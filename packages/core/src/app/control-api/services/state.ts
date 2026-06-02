import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { SkillRegistry } from '../../../core/extension/skills/skillRegistry.js';
import { loadInstallationState, runtimePaths } from '../../../core/system/config/configStore.js';
import { ManagementReadModelService } from '../../../core/system/projection/managementReadModelService.js';
import { RuntimeSnapshotQuery } from '../../../core/system/projection/runtimeSnapshotQuery.js';
import { SqliteSessionStore } from '../../../core/system/state/sqliteSessionStore.js';
import { computeRuntimeStatus } from '../../../core/runtime/runtimeStatus.js';
import { SidecarManager } from '../../../core/runtime/supervision/sidecarManager.js';
import type { RuntimeProvider, RuntimeProviderDiagnostics } from '../../../types/provider.js';
import type { ProviderInputImage, ProviderRuntimeEvent, ProviderSessionRecord } from '../../../types/runtime.js';
import type { ManagementReadModel, ManagementReadModelPresentation } from '../../../types/app.js';
import { homeRootForRuntime, type MoorlineConfig } from '../../../types/config.js';
import { ProviderSessionDirectory } from '../../../core/runtime/execution/providerSessionDirectory.js';
import type { RuntimeSessionRow } from '../../../core/system/state/sqlite/types.js';

class SnapshotRuntimeProvider extends EventEmitter<{
  providerEvent: [event: ProviderRuntimeEvent];
}> implements RuntimeProvider {
  constructor(private readonly store: SqliteSessionStore) {
    super();
  }

  listSessions(): ProviderSessionRecord[] {
    return new ProviderSessionDirectory(this.store).list().map((binding) => ({
      providerPackageId: binding.providerPackageId,
      provider: binding.providerPackageId,
      threadId: binding.threadId,
      runtimeMode: binding.runtimeMode,
      cwd: binding.workspacePath,
      model: binding.model ?? undefined,
      status: binding.status,
      resumeCursor: binding.providerThreadId ? { threadId: binding.providerThreadId } : undefined,
      createdAt: binding.updatedAt,
      updatedAt: binding.updatedAt,
      lastError: binding.lastError ?? undefined
    }));
  }

  getDiagnostics(): RuntimeProviderDiagnostics {
    const bindings = new ProviderSessionDirectory(this.store).list();
    const latest = bindings.at(-1) ?? null;
    const statusCounts = bindings.reduce<Record<string, number>>((counts, binding) => {
      counts[binding.status] = (counts[binding.status] ?? 0) + 1;
      return counts;
    }, {});
    return {
      accountLabel: latest?.accountLabel ?? null,
      availableModels: latest?.availableModels ?? [],
      connectedSessions: bindings.length,
      statusCounts,
      capabilityMetadata: latest?.capabilityMetadata ?? {}
    };
  }

  async startOrResumeSession(_: {
    session: RuntimeSessionRow;
    runtimeRoot: string;
    actor: string;
    model?: string;
  }): Promise<ProviderSessionRecord> {
    throw new Error('Provider session start is only available from the running main process.');
  }

  async recoverSessions(_: { sessions: RuntimeSessionRow[]; runtimeRoot: string; model?: string }): Promise<void> {
    throw new Error('Provider recovery is only available from the running main process.');
  }

  async sendTurn(_: string, __: { text: string; images?: ProviderInputImage[] }, ___?: string): Promise<{ turnId: string }> {
    throw new Error('Provider turns are only available from the running main process.');
  }

  async compactThread(_: string): Promise<void> {
    throw new Error('Provider thread compaction is only available from the running main process.');
  }

  async respondToRequest(_: string, __: string, ___: 'accept' | 'acceptForSession' | 'decline' | 'cancel'): Promise<void> {
    throw new Error('Pending request responses are only available from the running main process.');
  }

  async respondToUserInput(_: string, __: string, ___: Record<string, string | string[]>): Promise<void> {
    throw new Error('Pending request responses are only available from the running main process.');
  }

  async interruptTurn(_: string): Promise<void> {
    throw new Error('Turn interruption is only available from the running main process.');
  }

  async drain(): Promise<void> {
    return undefined;
  }

  stopSession(): void {
    return undefined;
  }

  stopAll(): void {
    return undefined;
  }
}

function controlApiPresentation(): ManagementReadModelPresentation {
  return {
    productDirection: 'Moorline runtime with an API-first control plane and independent clients.',
    setupReadyNextAction: 'Use the CLI against the Control API.',
    setupIncompleteNextAction: 'Finish transport and provider setup through the Control API, then start the main process.',
    contract: {
      readableResources: ['runtime.status', 'runtime.control', 'packages', 'history', 'pending_requests'],
      writableActions: ['runtime.reload', 'runtime.accepting', 'provider.control', 'packages.apply', 'history.restore'],
      trust: {
        authMode: 'bearer-token',
        loopbackOnly: true,
        tokenSource: 'local-connection-record',
        restartBehavior: 'adapter-restart-required'
      },
      navigation: ['operations', 'configure', 'history', 'requests'],
      deliveryTracks: [],
      recoveryActions: []
    },
    delivery: {
      install: {
        packageTargets: [],
        installedComponents: ['control-api', 'cli', 'main-process'],
        uninstallBehavior: 'Preserve runtime root by default.'
      },
      onboarding: {
        steps: ['configure', 'apply', 'start-main'],
        requiredInputs: ['transport package', 'provider package'],
        prerequisiteChecks: ['local runtime root'],
        completionState: 'ready when transport and provider are selected and applied'
      },
      lifecycle: {
        clientDisconnectBehavior: 'CLI and remote clients disconnect independently from the Control API and main process.',
        runtimeStopBehavior: 'Stop the main process explicitly or via stop_on_last_lease.',
        startAtLogin: 'manual',
        backgroundMode: 'Control API and main process run independently.',
        failureRecovery: 'Restart the main process through the Control API.'
      },
      updates: {
        appUpdates: 'Operator triggered.',
        officialPackageUpdates: 'Applied through package management and restart.',
        localPackageHandling: 'Never overwrite local packages.',
        operatorTrigger: 'Use the Control API through the CLI.'
      }
    }
  };
}

export class ControlApiStateService {
  constructor(
    private readonly input: {
      now?: () => string;
      getRuntimeControlStatus: () => { acceptingNewWork: boolean; supervised: boolean };
      getManagementSurface: () => { enabled: boolean; host: string; port: number; url: string | null };
    }
  ) {}

  build(config: MoorlineConfig): ManagementReadModel {
    const now = this.input.now ?? (() => new Date().toISOString());
    const paths = runtimePaths(config.runtimeRoot);
    const store = new SqliteSessionStore(paths.sqlitePath);
    try {
      const snapshots = new RuntimeSnapshotQuery(store, store.database());
      const skills = new SkillRegistry([join(config.runtimeRoot, 'packages', 'skills')]);
      const provider = new SnapshotRuntimeProvider(store);
      const sidecars = new SidecarManager({
        runtimeRoot: config.runtimeRoot,
        store,
        now,
        appendAuditEvent: () => undefined
      });
      const startedAtIso = store.getMetadata<string>('runtime.started_at') ?? null;
      const surfaceState = loadInstallationState(paths.installationPath);
      const service = new ManagementReadModelService({
        homeRoot: homeRootForRuntime(config.runtimeRoot),
        runtimeRoot: config.runtimeRoot,
        config,
        snapshots,
        skills,
        provider,
        sidecars,
        now,
        getRuntimeControlStatus: () => this.input.getRuntimeControlStatus(),
        getRuntimeStatus: () =>
          computeRuntimeStatus({
            snapshots,
            startedAtIso,
            now
          }),
        getSurfaceState: () => surfaceState,
        getManagementSurface: () => this.input.getManagementSurface(),
        presentation: controlApiPresentation()
      });
      return service.build();
    } finally {
      store.close();
    }
  }
}
