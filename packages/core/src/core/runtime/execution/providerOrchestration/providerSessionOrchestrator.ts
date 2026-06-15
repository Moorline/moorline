import type { AppliedMoorlineConfig } from '../../../../types/config.js';
import type { RuntimeMessagePayload } from '../../../../types/transport.js';
import {
  type ProviderResourceBundle,
  type ProviderToolDefinition,
  type ProviderToolExecutor,
  type ProviderToolPolicyConfig,
  type RuntimeProvider,
  type RuntimeProviderSessionInput
} from '../../../../types/provider.js';
import type { RuntimeSessionRow } from '../../../system/state/sqliteSessionStore.js';
import type { SessionRegistry } from '../../../domain/sessions/sessionState.js';
import type { ProviderConnectionStore } from '../providerProjectionTypes.js';
import type { ProviderGuardPort, ProviderModelPort } from './ports.js';
import { ProviderSessionCoordinator } from '../providerCoordination/providerSessionCoordinator.js';

interface ProviderSessionOrchestratorDeps extends ProviderGuardPort, ProviderModelPort {
  config: AppliedMoorlineConfig;
  providerToolPolicy: ProviderToolPolicyConfig;
  runtimeRoot: string;
  provider: RuntimeProvider;
  connections: ProviderConnectionStore;
  sessions: SessionRegistry;
  now(): string;
  upsertSession(session: RuntimeSessionRow): void;
  setProviderAutoStartDefault(enabled: boolean): void;
}

export class ProviderSessionOrchestrator {
  private readonly replies = new ProviderSessionCoordinator();
  private readonly threadFailures = new Map<string, string>();

  constructor(private readonly deps: ProviderSessionOrchestratorDeps) {}

  providerAutoStartEnabled(session: RuntimeSessionRow): boolean {
    return session.providerAutoStartEnabled !== false;
  }

  setProviderAutoStartDefault(enabled: boolean): void {
    this.deps.setProviderAutoStartDefault(enabled);
  }

  providerStoppedReply(session: RuntimeSessionRow): string {
    return this.replies.providerStoppedReply(session);
  }

  consumeThreadFailure(threadId: string): string | null {
    const failure = this.threadFailures.get(threadId) ?? null;
    if (failure) {
      this.threadFailures.delete(threadId);
    }
    return failure;
  }

  markThreadFailure(threadId: string, reason: string): void {
    this.threadFailures.set(threadId, reason);
  }

  clearThreadFailure(threadId: string): void {
    this.threadFailures.delete(threadId);
  }

  async ensureSession(
    session: RuntimeSessionRow,
    actor: string,
    options: {
      persistSessionState?: boolean;
      resources?: ProviderResourceBundle;
      tools?: ProviderToolDefinition[];
      toolExecutor?: ProviderToolExecutor;
    } = {}
  ): Promise<void> {
    if (!this.providerAutoStartEnabled(session)) {
      this.markThreadFailure(session.threadId, this.providerStoppedReply(session));
      return;
    }

    const active = this.deps.provider.listSessions().find((entry) => entry.threadId === session.threadId);
    if (active) {
      this.clearThreadFailure(session.threadId);
      return;
    }

    const providerSessionInput = this.toProviderSessionInput(session);
    const providerSession = await this.deps.runGuardedProviderAction({
      action: 'net.connect',
      actor,
      target: this.deps.providerPolicyTarget(session.threadId, 'session'),
      payload: {
        runtimeMode: providerSessionInput.runtimeMode,
        agentKind: providerSessionInput.agentKind,
        cwd: providerSessionInput.providerCwd ?? providerSessionInput.workspacePath
      },
      threadId: session.threadId,
      title: 'Provider session blocked',
      execute: async () =>
        await this.deps.provider.startOrResumeSession({
          session: providerSessionInput,
          runtimeRoot: this.deps.runtimeRoot,
          actor,
          ...(this.deps.configuredProviderModel() ? { model: this.deps.configuredProviderModel() } : {}),
          ...(options.resources ? { resources: options.resources } : {}),
          ...(options.tools ? { tools: options.tools } : {}),
          ...(options.toolExecutor ? { toolExecutor: options.toolExecutor } : {})
        })
    });

    if (options.persistSessionState !== false) {
      this.deps.upsertSession({
        ...session,
        providerStatus: providerSession.status,
        providerThreadId: providerSession.resumeCursor?.threadId ?? session.providerThreadId,
        resumeCursor: providerSession.resumeCursor?.cursor ?? session.resumeCursor ?? null,
        updatedAt: this.deps.now()
      });
    }
    this.clearThreadFailure(session.threadId);
  }

  private toProviderSessionInput(session: RuntimeSessionRow): RuntimeProviderSessionInput {
    const agentKind = session.agentKind ?? 'workspace';
    if (agentKind === 'workspace' && !session.workspacePath) {
      throw new Error(`Workspace provider session ${session.sessionId} is missing workspacePath.`);
    }
    if (agentKind === 'ephemeral' && session.workspacePath !== null) {
      throw new Error(`Ephemeral provider session ${session.sessionId} must not have a workspacePath.`);
    }
    return {
      sessionId: session.sessionId,
      threadId: session.threadId,
      transportResourceId: session.transportResourceId,
      runtimeMode: session.runtimeMode,
      agentKind,
      workspacePath: session.workspacePath,
      providerCwd: session.providerCwd ?? null,
      resumeCursor: session.resumeCursor ?? null,
      lifecycleStatus: session.lifecycleStatus,
      providerAutoStartEnabled: session.providerAutoStartEnabled,
      toolGrantIds: session.toolGrantIds ?? [],
      toolPolicy: this.deps.providerToolPolicy
    };
  }

  refreshActiveSessionsForProviderDefault(): void {
    const activeSessions = this.deps.provider.listSessions();
    const blockedSessions = activeSessions.filter((session) => session.status !== 'ready');
    if (blockedSessions.length > 0) {
      throw new Error(
        `Cannot switch to latest while sessions are active: ${blockedSessions.map((session) => session.threadId).join(', ')}`
      );
    }

    for (const providerSession of activeSessions) {
      this.deps.provider.stopSession(providerSession.threadId);
      this.deps.connections.delete(providerSession.threadId);

      const session = this.deps.sessions.getByThreadId(providerSession.threadId);
      if (!session) {
        continue;
      }

      this.deps.upsertSession({
        ...session,
        providerThreadId: null,
        resumeCursor: null,
        providerStatus: 'connecting',
        activeTurnId: null,
        updatedAt: this.deps.now(),
        lastError: null
      });
    }
  }

  stoppedReplyIfDisabled(session: RuntimeSessionRow): RuntimeMessagePayload | null {
    return this.providerAutoStartEnabled(session) ? null : { text: this.providerStoppedReply(session) };
  }
}
