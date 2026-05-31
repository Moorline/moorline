import type { AppliedMoorlineConfig } from '../../../../types/config.js';
import type { RuntimeMessagePayload } from '../../../../types/transport.js';
import type { RuntimeProvider } from '../../../../types/provider.js';
import type { RuntimeSessionRow } from '../../../system/state/sqliteSessionStore.js';
import type { SessionRegistry } from '../../../domain/sessions/sessionState.js';
import type { ProviderConnectionStore } from '../providerProjectionTypes.js';
import type { ProviderGuardPort, ProviderModelPort } from './ports.js';
import { ProviderSessionCoordinator } from '../providerCoordination/providerSessionCoordinator.js';

export interface ProviderSessionOrchestratorDeps extends ProviderGuardPort, ProviderModelPort {
  config: AppliedMoorlineConfig;
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
    options: { persistSessionState?: boolean } = {}
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

    const providerSession = await this.deps.runGuardedProviderAction({
      action: 'net.connect',
      actor,
      target: this.deps.providerPolicyTarget(session.threadId, 'session'),
      payload: { runtimeMode: session.runtimeMode, cwd: session.workspacePath },
      threadId: session.threadId,
      title: 'Provider session blocked',
      execute: async () =>
        await this.deps.provider.startOrResumeSession({
          session,
          runtimeRoot: this.deps.runtimeRoot,
          actor,
          ...(this.deps.configuredProviderModel() ? { model: this.deps.configuredProviderModel() } : {})
        })
    });

    if (options.persistSessionState !== false) {
      this.deps.upsertSession({
        ...session,
        providerStatus: providerSession.status,
        providerThreadId: providerSession.resumeCursor?.threadId ?? session.providerThreadId,
        resumeThreadId: providerSession.resumeCursor?.threadId ?? session.resumeThreadId,
        updatedAt: this.deps.now()
      });
    }
    this.clearThreadFailure(session.threadId);
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
        resumeThreadId: null,
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
