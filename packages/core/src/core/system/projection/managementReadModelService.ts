import { join } from 'node:path';
import { createPackageApplyPlan } from '../../extension/packages/packageApplyPlanner.js';
import { desiredPackageRefsFromConfig, isPackageActivated, packageActivationUniqueKey } from '../../extension/packages/packageActivation.js';
import { resolvePackageConfigSchema } from '../../extension/packages/packageConfigSchema.js';
import { PackageInventoryStore } from '../../extension/packages/packageInventoryStore.js';
import { evaluateRuntimeStartability } from '../../extension/packages/runtimeStartability.js';
import { GitHistoryService } from '../vcs/gitHistoryService.js';
import {
  detectMoorlineRuntimeMode,
  readMoorlineReleaseManifest,
  resolveMoorlineAssetRoot
} from '../release/releaseArtifacts.js';
import { loadRuntimePackageLoadReport } from '../release/runtimePackageLoadReport.js';
import { readConfigMigrationWarning, runtimePaths } from '../config/configStore.js';
import { readRecentAuditEvents } from './managementReadModel/auditEvents.js';
import type { ManagementReadModelServiceDeps } from './managementReadModel/deps.js';
import { buildServiceObjects } from './managementReadModel/objects/serviceObjects.js';
import { listPluginRecords } from './managementReadModel/pluginDiskRecords.js';
import { buildProviderAlignment } from './managementReadModel/providerAlignment.js';
import { summarize } from './managementReadModel/text.js';
import { readRuntimeOrchestrationHealth } from '../../runtime/execution/orchestrationHealth.js';
import { isOfficialPluginId, toPluginPackageId } from '../../extension/plugins/pluginId.js';
import { parsePendingRequestQuestions } from './pendingRequestQuestions.js';
import type {
  ManagementInstalledPackageRecord,
  ManagementPackageConfigRecord,
  ManagementReadModelPresentation,
  ManagedPendingRequestRecord,
  ManagedPluginRecord,
  ManagedProviderThreadRecord,
  ManagedServiceRecord,
  ManagedSessionRecord,
  ManagedSidecarSummary,
  ManagedSkillRecord,
  ManagementReadModel
} from '../../../types/app.js';
import type { JsonSchemaLike, PackageInstallRecord } from '../../../types/package.js';

function dataOnlyPresentation(runtimeRoot: string): ManagementReadModelPresentation {
  return {
    productDirection: '',
    setupReadyNextAction: '',
    setupIncompleteNextAction: '',
    contract: {
      readableResources: [],
      writableActions: [],
      trust: {
        authMode: 'bearer-token',
        loopbackOnly: true,
        tokenSource: 'local-connection-record',
        restartBehavior: 'adapter-restart-required'
      },
      navigation: [],
      deliveryTracks: [],
      recoveryActions: []
    },
    delivery: {
      install: {
        packageTargets: [],
        installedComponents: [runtimeRoot],
        uninstallBehavior: ''
      },
      onboarding: {
        steps: [],
        requiredInputs: [],
        prerequisiteChecks: [],
        completionState: ''
      },
      lifecycle: {
        clientDisconnectBehavior: '',
        runtimeStopBehavior: '',
        startAtLogin: 'manual',
        backgroundMode: '',
        failureRecovery: ''
      },
      updates: {
        appUpdates: '',
        officialPackageUpdates: '',
        localPackageHandling: '',
        operatorTrigger: ''
      }
    }
  };
}

type ConfigSchemaProperty = NonNullable<JsonSchemaLike['properties']>[string];

function configRootForPackage(input: {
  config: ManagementReadModelServiceDeps['config'];
  surface: PackageInstallRecord['surface'];
  packageId: string;
}): Record<string, unknown> {
  if (input.surface === 'api-adapter') {
    if (input.packageId === input.config.surfaces.apiAdapter.activePackageId) {
      return {
        ...input.config.surfaces.apiAdapter.config,
        ...(input.config.surfaces.apiAdapter.configByPackageId?.[input.packageId] ?? {})
      };
    }
    return {
      ...(input.config.surfaces.apiAdapter.configByPackageId?.[input.packageId] ?? {})
    };
  }
  if (input.surface === 'transport') {
    return {
      ...(input.config.surfaces.transport.activePackageId === input.packageId ? input.config.surfaces.transport.config : {}),
      ...(input.config.surfaces.transport.configByPackageId?.[input.packageId] ?? {})
    };
  }
  if (input.surface === 'provider') {
    return {
      ...(input.config.surfaces.provider.activePackageId === input.packageId ? input.config.surfaces.provider.config : {}),
      ...(input.config.surfaces.provider.configByPackageId?.[input.packageId] ?? {})
    };
  }
  if (input.surface === 'plugin') {
    return input.config.surfaces.plugins.configByPackageId[input.packageId] ?? {};
  }
  return input.config.surfaces.skills.configByPackageId[input.packageId] ?? {};
}

function configValueIsSet(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim().length === 0);
}

function schemaFieldType(property: ConfigSchemaProperty): 'string' | 'boolean' | 'number' {
  return property.type ?? 'string';
}

export class ManagementReadModelService {
  private readonly history = new GitHistoryService();

  constructor(private readonly deps: ManagementReadModelServiceDeps) {}

  build(): ManagementReadModel {
    const assetRoot = resolveMoorlineAssetRoot(import.meta.url);
    const runtimeMode = detectMoorlineRuntimeMode(import.meta.url);
    const releaseManifest = readMoorlineReleaseManifest(assetRoot, runtimeMode);
    const inventory = new PackageInventoryStore(this.deps.runtimeRoot).load();
    const activatedPackages = desiredPackageRefsFromConfig(this.deps.config);
    const applyPlan = createPackageApplyPlan(this.deps.config, inventory);
    const runtimeStartability = evaluateRuntimeStartability(this.deps.config, inventory);
    const sessions = this.buildSessions();
    const plugins = this.buildPlugins(inventory);
    const skills = this.buildSkills(inventory);
    const services = this.buildServices();
    const pendingRequests = this.buildPendingRequests();
    const providerThreads = this.buildProviderThreads();
    const sidecars = this.buildSidecars();
    const managementContributions = this.buildManagementContributions();
    const managementSurface = this.deps.getManagementSurface();
    const providerDiagnostics = this.deps.provider.getDiagnostics();
    const auditLogPath = join(this.deps.runtimeRoot, 'logs', 'policy-audit.jsonl');
    const namespaceState = this.deps.getNamespaceState();
    const homeRoot = this.deps.homeRoot;
    const historyStatus = this.history.statusSync(homeRoot);
    const historyEntries = historyStatus.gitAvailable ? this.history.listSync(homeRoot, 30) : [];
    const packageLoadReport = loadRuntimePackageLoadReport(runtimePaths(this.deps.runtimeRoot).packageLoadReportPath);
    const configMigrationWarning = readConfigMigrationWarning(this.deps.runtimeRoot);
    const runtimeHealth = readRuntimeOrchestrationHealth(this.deps.runtimeRoot);
    const presentation = this.deps.presentation ?? dataOnlyPresentation(this.deps.runtimeRoot);
    const providerConnected =
      providerDiagnostics.connectedSessions > 0 ||
      providerDiagnostics.accountLabel !== null;

    return {
      generatedAt: this.deps.now(),
      product: {
        runtimeName: 'Moorline',
        managementName: 'Moorline',
        direction: presentation.productDirection
      },
      contract: presentation.contract,
      delivery: presentation.delivery,
      setup: {
        runtimeRoot: this.deps.runtimeRoot,
        installationStatePath: join(this.deps.runtimeRoot, 'state', 'installation.json'),
        namespaceBootstrapped: namespaceState !== null,
        providerConnected,
        readyForSessions: runtimeStartability.startable,
        nextAction: runtimeStartability.startable
          ? presentation.setupReadyNextAction
          : runtimeStartability.issues[0] ?? presentation.setupIncompleteNextAction,
        completed: runtimeStartability.startable
      },
      settings: {
        defaults: {
          runtimeMode: this.deps.config.defaults.runtimeMode,
          model: this.deps.config.defaults.model
        },
        transport: {
          kind: this.deps.config.transport?.kind ?? this.deps.config.surfaces.transport.activePackageId ?? 'unselected',
          ...(this.deps.config.transport?.packageId
            ? { packageId: this.deps.config.transport.packageId }
            : this.deps.config.surfaces.transport.activePackageId
              ? { packageId: this.deps.config.surfaces.transport.activePackageId }
              : {}),
          scopeId: typeof this.deps.config.transport?.scopeId === 'string' ? this.deps.config.transport.scopeId : '',
          config: this.deps.config.transport?.config ?? {}
        },
        provider: {
          kind: this.deps.config.provider?.kind ?? this.deps.config.surfaces.provider.activePackageId ?? 'unselected',
          ...(this.deps.config.provider?.packageId
            ? { packageId: this.deps.config.provider.packageId }
            : this.deps.config.surfaces.provider.activePackageId
              ? { packageId: this.deps.config.surfaces.provider.activePackageId }
              : {}),
          config: {
            ...this.deps.config.surfaces.provider.config,
            ...(this.deps.config.surfaces.provider.activePackageId
              ? this.deps.config.surfaces.provider.configByPackageId?.[this.deps.config.surfaces.provider.activePackageId] ?? {}
              : {})
          }
        },
        admin: {
          explicitAccessGroupCount: this.deps.config.admin?.accessGroupIds.length ?? 0,
          explicitUserCount: this.deps.config.admin?.userIds.length ?? 0,
          allowTransportAdmin: this.deps.config.admin?.allowTransportAdmin === true,
          managedRole: {
            enabled: this.deps.config.admin?.managedRole.enabled !== false,
            name: this.deps.config.admin?.managedRole.name ?? 'Moorline Admin'
          },
          managedUserRole: {
            enabled: this.deps.config.admin?.managedUserRole.enabled !== false,
            name: this.deps.config.admin?.managedUserRole.name ?? 'Moorline User'
          }
        }
      },
      namespace: namespaceState,
      runtime: {
        status: this.deps.getRuntimeStatus(),
        control: this.deps.getRuntimeControlStatus(),
        release: {
          mode: runtimeMode,
          assetRoot,
          manifest: releaseManifest
        },
        managementSurface: {
          ...managementSurface,
          authMode: 'bearer-token'
        }
      },
      provider: {
        diagnostics: providerDiagnostics,
        alignment: buildProviderAlignment(providerDiagnostics.capabilityMetadata)
      },
      packages: {
        installed: inventory.installed
          .map<ManagementInstalledPackageRecord>((entry) => {
            const selected =
              (entry.surface === 'api-adapter' && this.deps.config.surfaces.apiAdapter.activePackageId === entry.packageId) ||
              (entry.surface === 'transport' && this.deps.config.surfaces.transport.activePackageId === entry.packageId) ||
              (entry.surface === 'provider' && this.deps.config.surfaces.provider.activePackageId === entry.packageId);
            const enabled =
              (entry.surface === 'plugin' && this.deps.config.surfaces.plugins.enabledPackageIds.includes(entry.packageId)) ||
              (entry.surface === 'skill' && this.deps.config.surfaces.skills.enabledPackageIds.includes(entry.packageId));
            const surface = entry.kind === 'bundle' ? null : entry.kind;
            const activated = surface !== null && isPackageActivated(activatedPackages, { surface, packageId: entry.packageId });
            return {
              kind: entry.kind,
              surface: entry.surface,
              packageId: entry.packageId,
              name: entry.name,
              version: entry.version,
              description: entry.description ?? null,
              installedAt: entry.installedAt,
              installPath: entry.installPath,
              sourceLabel:
                entry.source.kind === 'local_dir' || entry.source.kind === 'local_archive'
                  ? entry.source.path
                  : entry.source.url,
              dependencies: entry.dependencies.map((dependency) => `${dependency.kind ?? dependency.surface}:${dependency.packageId}:${dependency.requiredState}`),
              ...(entry.members ? { members: entry.members.map((member) => `${member.kind}:${member.packageId}:${member.version}:${member.activation}`) } : {}),
              ...(entry.installedByPackageIds ? { installedByPackageIds: entry.installedByPackageIds } : {}),
              selected,
              enabled,
              activationState: activated ? 'activated' : 'deactivated',
              activationUniqueKey: surface === null ? null : packageActivationUniqueKey(surface, entry)
            };
          })
          .sort((left, right) => left.packageId.localeCompare(right.packageId)),
        config: this.buildPackageConfig(inventory.installed),
        applyPlan
      },
      diagnostics: {
        auditLogPath,
        exportFormats: ['management-snapshot.json', 'diagnostics-export.json'],
        runtimeHealth: {
          orchestration: runtimeHealth.queue ?? {
            openRequests: 0,
            runningRequests: 0,
            pendingRequests: 0,
            staleRunningRequests: 0,
            oldestOpenAgeMs: 0,
            oldestRunningAgeMs: 0,
            inFlightRequests: 0,
            staleRunningThresholdMs: 0
          },
          activeTurns: runtimeHealth.turns ?? {
            activeTurns: 0,
            staleActiveTurns: 0,
            oldestActiveTurnAgeMs: 0,
            staleActiveTurnThresholdMs: 0
          },
          ...(runtimeHealth.retention ? { pruning: runtimeHealth.retention } : {}),
          ...(this.deps.getRuntimeWorkerQueues ? { workerQueues: this.deps.getRuntimeWorkerQueues() } : {})
        },
        packageLoadFailures: packageLoadReport?.failures ?? [],
        configMigrationWarning,
        recentAuditEvents: readRecentAuditEvents(auditLogPath),
        recentRuntimeActivities: this.deps.snapshots.listRecentActivities(12).map((activity) => ({
          kind: activity.kind,
          severity: activity.severity,
          title: activity.title,
          detail: activity.detail,
          threadId: activity.threadId,
          spaceId: activity.spaceId,
          createdAt: activity.createdAt
        }))
      },
      history: {
        status: historyStatus,
        entries: historyEntries,
        capabilities: {
          snapshot: historyStatus.gitAvailable,
          restore: historyStatus.gitAvailable,
          discard: historyStatus.gitAvailable
        }
      },
      overview: {
        sessions: sessions.length,
        pendingRequests: pendingRequests.length,
        plugins: plugins.length,
        skills: skills.length,
        services: services.length,
        providerThreads: providerThreads.length,
        sidecars: sidecars.length
      },
      objects: {
        sessions,
        plugins,
        skills,
        services,
        managementContributions,
        pendingRequests,
        providerThreads,
        sidecars
      }
    };
  }

  private buildManagementContributions(): ManagementReadModel['objects']['managementContributions'] {
    const getPluginHost = this.deps.getPluginHost;
    const createPluginContext = this.deps.createPluginContext;
    if (!getPluginHost || !createPluginContext) {
      return [];
    }
    return getPluginHost()
      .listManagementContributions((pluginId) => createPluginContext(`plugin:${pluginId}`))
      .sort((left, right) => `${left.placement}:${left.packageId}:${left.id}`.localeCompare(`${right.placement}:${right.packageId}:${right.id}`));
  }

  private buildPackageConfig(installed: PackageInstallRecord[]): ManagementPackageConfigRecord[] {
    const configTargets = [...installed];
    return configTargets
      .filter((entry) => entry.kind !== 'bundle')
      .map<ManagementPackageConfigRecord>((entry) => {
        const surface = entry.surface as Exclude<typeof entry.surface, 'bundle'>;
        const schema = resolvePackageConfigSchema({
          runtimeRoot: this.deps.runtimeRoot,
          surface,
          packageId: entry.packageId
        }) ?? null;
        const configRoot = configRootForPackage({
          config: this.deps.config,
          surface,
          packageId: entry.packageId
        });
        const required = new Set(schema?.required ?? []);
        const fields = Object.entries(schema?.properties ?? {})
          .map(([key, property]) => {
            const rawValue = configRoot[key];
            const configured = configValueIsSet(rawValue);
            const secret = property.secret === true;
            return {
              key,
              title: property.title ?? key,
              description: property.description ?? null,
              type: schemaFieldType(property),
              required: required.has(key),
              secret,
              defaultValue: property.default ?? null,
              enumValues: property.enum ?? [],
              value: secret || !configured ? null : (rawValue as string | boolean | number),
              configured
            };
          })
          .sort((left, right) => {
            const leftRequired = left.required ? 0 : 1;
            const rightRequired = right.required ? 0 : 1;
            return leftRequired - rightRequired || left.key.localeCompare(right.key);
          });
        const selected =
          (entry.surface === 'api-adapter' && this.deps.config.surfaces.apiAdapter.activePackageId === entry.packageId) ||
          (entry.surface === 'transport' && this.deps.config.surfaces.transport.activePackageId === entry.packageId) ||
          (entry.surface === 'provider' && this.deps.config.surfaces.provider.activePackageId === entry.packageId);
        const enabled =
          (entry.surface === 'plugin' && this.deps.config.surfaces.plugins.enabledPackageIds.includes(entry.packageId)) ||
          (entry.surface === 'skill' && this.deps.config.surfaces.skills.enabledPackageIds.includes(entry.packageId));
        return {
          surface,
          packageId: entry.packageId,
          selected,
          enabled,
          active: selected || enabled,
          activationState: selected || enabled ? 'activated' : 'deactivated',
          activationUniqueKey: packageActivationUniqueKey(surface, entry),
          schema,
          fields
        };
      })
      .sort((left, right) => `${left.surface}:${left.packageId}`.localeCompare(`${right.surface}:${right.packageId}`));
  }

  private buildSessions(): ManagedSessionRecord[] {
    return this.deps.snapshots.listSessions().map((snapshot) => ({
      id: snapshot.session.sessionId,
      kind: 'session',
      name: snapshot.session.spaceName,
      summary: summarize(snapshot.session.summary ?? snapshot.session.objective ?? null),
      controls: ['inspect', 'archive', 'delete_archived', 'provider_start', 'provider_stop', 'interrupt_turn'],
      mutability: {
        editable: true,
        installable: false,
        removable: snapshot.session.lifecycleStatus === 'archived'
      },
      trust: {
        level: 'operator',
        source: 'local SQLite runtime state'
      },
      sourceOfTruth: {
        kind: 'sqlite',
        label: 'runtime_sessions'
      },
      runtimeState: {
        status: snapshot.session.lifecycleStatus,
        updatedAt: snapshot.session.updatedAt,
        details: {
          runtimeMode: snapshot.session.runtimeMode,
          ownerKind: snapshot.session.ownerKind,
          pendingRequests: snapshot.pendingRequests.length,
          providerStatus: snapshot.provider?.status ?? snapshot.session.providerStatus
        }
      },
      spaceId: snapshot.session.spaceId,
      threadId: snapshot.session.threadId,
      lifecycleStatus: snapshot.session.lifecycleStatus,
      runtimeMode: snapshot.session.runtimeMode,
      objective: snapshot.session.objective ?? null,
      tags: snapshot.session.tags ?? [],
      owner:
        snapshot.session.ownerKind && snapshot.session.ownerId
          ? {
              kind: snapshot.session.ownerKind,
              id: snapshot.session.ownerId,
              label: snapshot.session.ownerLabel ?? null
            }
          : null,
      waitState: snapshot.receipt?.state ?? 'idle',
      providerStatus: snapshot.provider?.status ?? snapshot.session.providerStatus,
      pendingRequestCount: snapshot.pendingRequests.length,
      recentActivityCount: snapshot.recentActivities.length
    }));
  }

  private buildPlugins(inventory: ReturnType<PackageInventoryStore['load']>): ManagedPluginRecord[] {
    const enabledPluginIds = new Set(this.deps.config.surfaces.plugins.enabledPackageIds);
    const installedPluginIds = new Set(inventory.installed.filter((entry) => entry.kind === 'plugin').map((entry) => entry.packageId));
    const pluginsRoot = join(this.deps.runtimeRoot, 'packages', 'plugins');
    return listPluginRecords(pluginsRoot).map((record) => {
      if (!record.manifest) {
        return {
          id: record.pluginId,
          kind: 'plugin',
          name: record.pluginId,
          summary: summarize(record.error ?? 'Malformed plugin manifest'),
          controls: ['inspect'],
          mutability: {
            editable: record.packageGroup === 'local',
            installable: true,
            removable: record.packageGroup === 'local'
          },
          trust: {
            level: record.packageGroup === 'official' ? 'official' : 'local',
            source: record.packageGroup === 'official' ? 'bundled official runtime package' : 'runtime plugin directory'
          },
          sourceOfTruth: {
            kind: 'filesystem',
            label: 'plugin manifest',
            path: record.pluginPath
          },
          runtimeState: {
            status: 'invalid',
            updatedAt: null,
            details: {
              error: record.error ?? 'Malformed plugin manifest'
            }
          },
          pluginId: record.pluginId,
          version: 'invalid',
          pluginType: 'invalid',
          capabilities: [],
          hooks: [],
          commands: [],
          packageGroup: record.packageGroup
        };
      }

      const normalizedPluginId = toPluginPackageId(record.manifest.id);
      return {
        id: record.manifest.id,
        kind: 'plugin',
        name: record.manifest.name,
        summary: summarize(record.manifest.description ?? null),
        controls: ['inspect'],
        mutability: {
          editable: record.packageGroup === 'local',
          installable: true,
          removable: record.packageGroup === 'local'
        },
        trust: {
          level: record.packageGroup === 'official' ? 'official' : 'local',
          source: record.packageGroup === 'official' ? 'bundled official runtime package' : 'runtime plugin directory'
        },
        sourceOfTruth: {
          kind: 'filesystem',
          label: 'plugin manifest',
          path: record.pluginPath
        },
        runtimeState: {
          status: installedPluginIds.has(normalizedPluginId)
            ? enabledPluginIds.has(normalizedPluginId)
              ? 'enabled'
              : 'disabled'
            : 'available',
          updatedAt: null,
          details: {
            type: record.manifest.type,
            capabilities: record.manifest.capabilities,
            hooks: record.manifest.hooks ?? [],
            actions: []
          }
        },
        pluginId: record.manifest.id,
        version: record.manifest.version,
        pluginType: record.manifest.type,
        capabilities: [...record.manifest.capabilities],
        hooks: [...(record.manifest.hooks ?? [])],
        commands: [],
        packageGroup: record.packageGroup
      };
    });
  }

  private buildSkills(inventory: ReturnType<PackageInventoryStore['load']>): ManagedSkillRecord[] {
    const enabledSkillPackageIds = new Set(this.deps.config.surfaces.skills.enabledPackageIds);
    const skillPackages = inventory.installed
      .filter((entry) => entry.kind === 'skill')
      .map((entry) => ({
        packageId: entry.packageId,
        installPath: join(entry.installPath, 'skills')
      }))
      .sort((left, right) => right.installPath.length - left.installPath.length);
    return this.deps.skills.list().map((skill) => {
      const ownerPackageId = skillPackages.find((entry) => skill.path.startsWith(entry.installPath))?.packageId ?? null;
      const status = ownerPackageId && enabledSkillPackageIds.has(ownerPackageId) ? 'enabled' : 'available';
      return {
        id: skill.name,
        kind: 'skill',
        name: skill.name,
        summary: summarize(skill.description),
        controls: ['inspect', 'edit'],
        mutability: {
          editable: true,
          installable: true,
          removable: true
        },
        trust: {
          level: 'local',
          source: 'runtime skills directory'
        },
        sourceOfTruth: {
          kind: 'filesystem',
          label: 'SKILL.md',
          path: skill.path
        },
        runtimeState: {
          status,
          updatedAt: null,
          details: {
            tags: skill.tags,
            metadata: skill.metadata
          }
        },
        skillName: skill.name,
        tags: [...skill.tags],
        metadata: skill.metadata
      };
    });
  }

  private buildServices(): ManagedServiceRecord[] {
    return buildServiceObjects(this.deps);
  }

  private buildPendingRequests(): ManagedPendingRequestRecord[] {
    return this.deps.snapshots.overview().openRequests.map((request) => ({
      id: request.requestId,
      kind: 'pending_request',
      name: request.requestType,
      summary: summarize(request.detail),
      controls: ['inspect', 'resolve', 'answer', 'cancel'],
      mutability: {
        editable: false,
        installable: false,
        removable: false
      },
      trust: {
        level: 'operator',
        source: 'provider pending request projection'
      },
      sourceOfTruth: {
        kind: 'sqlite',
        label: 'pending_requests'
      },
      runtimeState: {
        status: request.status,
        updatedAt: request.createdAt,
        details: {
          threadId: request.threadId,
          spaceId: request.spaceId,
          requesterUserId: request.requesterUserId
        }
      },
      threadId: request.threadId,
      spaceId: request.spaceId,
      requestType: request.requestType,
      requesterUserId: request.requesterUserId,
      createdAt: request.createdAt,
      detail: request.detail,
      questions: parsePendingRequestQuestions(request.questionsJson)
    }));
  }

  private buildProviderThreads(): ManagedProviderThreadRecord[] {
    const snapshotsByThread = new Map(
      this.deps.snapshots.listSessions().map((snapshot) => [snapshot.session.threadId, snapshot] as const)
    );
    return this.deps.provider.listSessions().map((session) => {
      const snapshot = snapshotsByThread.get(session.threadId);
      return {
        id: session.threadId,
        kind: 'provider_thread',
        name: session.threadId,
        summary: summarize(session.lastError ?? session.model ?? null),
        controls: ['inspect', 'interrupt', 'compact'],
        mutability: {
          editable: false,
          installable: false,
          removable: false
        },
        trust: {
          level: 'official',
          source: 'provider runtime session'
        },
        sourceOfTruth: {
          kind: 'provider',
          label: 'app-server runtime session'
        },
        runtimeState: {
          status: session.status,
          updatedAt: session.updatedAt,
          details: {
            cwd: session.cwd,
            runtimeMode: session.runtimeMode,
            model: session.model ?? null
          }
        },
        threadId: session.threadId,
        spaceId: snapshot?.session.spaceId ?? null,
        providerThreadId: snapshot?.provider?.providerThreadId ?? session.resumeCursor?.threadId ?? null,
        runtimeMode: session.runtimeMode,
        model: session.model ?? null
      };
    });
  }

  private buildSidecars(): ManagedSidecarSummary[] {
    return this.deps.sidecars.listSidecars().map((sidecar) => ({
      id: sidecar.sidecarId,
      kind: 'sidecar',
      name: sidecar.name,
      summary: summarize(sidecar.lastError ?? null),
      controls: ['inspect', 'stop'],
      mutability: {
        editable: false,
        installable: false,
        removable: false
      },
      trust: {
        level: isOfficialPluginId(sidecar.pluginId) ? 'official' : 'local',
        source: sidecar.pluginId
      },
      sourceOfTruth: {
        kind: 'sqlite',
        label: 'managed_sidecars'
      },
      runtimeState: {
        status: sidecar.status,
        updatedAt: sidecar.updatedAt,
        details: {
          scopeKind: sidecar.scopeKind,
          scopeKey: sidecar.scopeKey,
          restartCount: sidecar.restartCount
        }
      },
      pluginId: sidecar.pluginId,
      scopeKind: sidecar.scopeKind,
      scopeKey: sidecar.scopeKey,
      command: sidecar.command,
      args: [...sidecar.args],
      restartPolicy: sidecar.restartPolicy,
      restartCount: sidecar.restartCount,
      pid: sidecar.pid,
      startedAt: sidecar.startedAt,
      readyAt: sidecar.readyAt,
      stoppedAt: sidecar.stoppedAt,
      lastError: sidecar.lastError
    }));
  }
}
