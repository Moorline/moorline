import type {
  ProviderControlResult,
  RuntimeControlExecutionRequest,
  RuntimeControlRequest,
  RuntimeControlResult,
  RuntimeReloadMode
} from './runtimeControl.js';
import type { RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';
import type { RuntimeActorIdentity } from '../../../types/transport.js';

interface RuntimeControlAuthorizationInput {
  actorId: string;
  target: string;
  reason: string;
  requestedBy: RuntimeActorIdentity;
}

interface RequestRuntimeReloadInput {
  actorId: string;
  mode: RuntimeReloadMode;
  reason: string;
  requestedBy: RuntimeActorIdentity;
}

interface SetRuntimeAcceptingNewWorkInput {
  actorId: string;
  accepting: boolean;
  reason: string;
  requestedBy: RuntimeActorIdentity;
}

interface ProviderSessionControlInput {
  actorId: string;
  threadId?: string;
  reason: string;
  requestedBy: RuntimeActorIdentity;
}

interface RuntimeControlServiceOptions {
  requestControl?: (input: RuntimeControlRequest) => Promise<RuntimeControlResult>;
  authorize(input: RuntimeControlAuthorizationInput): Promise<void>;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  now(): string;
  setAcceptingNewWork(accepting: boolean): void;
  setProviderAutoStartDefault(enabled: boolean): void;
  getSessionByThreadId(threadId: string): RuntimeSessionRow | null;
  listSessions(): RuntimeSessionRow[];
  upsertSession(session: RuntimeSessionRow): void;
  updateSession(session: RuntimeSessionRow): RuntimeSessionRow;
  stopProviderSession(threadId: string): void;
  stopAllProviders(): void;
  drainProviders(): Promise<void>;
  ensureProviderSession(session: RuntimeSessionRow, actorId: string): Promise<void>;
}

export class RuntimeControlService {
  constructor(private readonly options: RuntimeControlServiceOptions) {}

  async executeSupervisorControl(input: RuntimeControlExecutionRequest): Promise<RuntimeControlResult> {
    switch (input.action) {
      case 'set-accepting':
        await this.applyRuntimeAcceptingNewWork({
          accepting: input.accepting,
          reason: input.reason,
          requestedBy: input.requestedBy
        });
        return {
          accepted: true,
          detail: input.accepting ? 'Runtime is now accepting new work.' : 'Runtime is no longer accepting new work.'
        };
      case 'provider-stop':
        await this.applyStopProviderSessions({
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          reason: input.reason,
          requestedBy: input.requestedBy
        });
        return {
          accepted: true,
          detail: input.threadId ? `Stopped provider session ${input.threadId}.` : 'Stopped all provider sessions.'
        };
      case 'provider-start':
        await this.applyStartProviderSessions({
          actorId: 'runtime:supervisor/control',
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          reason: input.reason,
          requestedBy: input.requestedBy
        });
        return {
          accepted: true,
          detail: input.threadId ? `Recovered provider session ${input.threadId}.` : 'Recovered all provider sessions.'
        };
    }
  }

  async requestRuntimeReload(input: RequestRuntimeReloadInput): Promise<RuntimeControlResult> {
    await this.options.authorize({
      actorId: input.actorId,
      target: `runtime:reload:${input.mode}`,
      reason: input.reason,
      requestedBy: input.requestedBy
    });
    this.options.appendAuditEvent('runtime.reload.requested', {
      mode: input.mode,
      reason: input.reason,
      requestedBy: input.requestedBy.actorId
    });
    if (!this.options.requestControl) {
      return {
        accepted: false,
        detail: 'Runtime reload requires the supervised runtime entrypoint.'
      };
    }
    return await this.options.requestControl({
      action: 'reload',
      mode: input.mode,
      reason: input.reason,
      requestedBy: input.requestedBy
    });
  }

  async requestSetRuntimeAcceptingNewWork(input: SetRuntimeAcceptingNewWorkInput): Promise<void> {
    await this.options.authorize({
      actorId: input.actorId,
      target: `runtime:accepting:${input.accepting ? 'enabled' : 'disabled'}`,
      reason: input.reason,
      requestedBy: input.requestedBy
    });
    if (this.options.requestControl) {
      const result = await this.options.requestControl({
        action: 'set-accepting',
        accepting: input.accepting,
        reason: input.reason,
        requestedBy: input.requestedBy
      });
      if (!result.accepted) {
        throw new Error(result.detail);
      }
      return;
    }
    await this.applyRuntimeAcceptingNewWork(input);
  }

  async requestStopProviderSessions(input: ProviderSessionControlInput): Promise<ProviderControlResult> {
    await this.options.authorize({
      actorId: input.actorId,
      target: input.threadId ? `provider:${input.threadId}:stop` : 'provider:all:stop',
      reason: input.reason,
      requestedBy: input.requestedBy
    });
    if (this.options.requestControl) {
      const result = await this.options.requestControl({
        action: 'provider-stop',
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        reason: input.reason,
        requestedBy: input.requestedBy
      });
      if (!result.accepted) {
        throw new Error(result.detail);
      }
      return bridgeProviderResult('stop', input, result.detail);
    }
    return await this.applyStopProviderSessions(input);
  }

  async requestStartProviderSessions(input: ProviderSessionControlInput): Promise<ProviderControlResult> {
    await this.options.authorize({
      actorId: input.actorId,
      target: input.threadId ? `provider:${input.threadId}:start` : 'provider:all:start',
      reason: input.reason,
      requestedBy: input.requestedBy
    });
    if (this.options.requestControl) {
      const result = await this.options.requestControl({
        action: 'provider-start',
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        reason: input.reason,
        requestedBy: input.requestedBy
      });
      if (!result.accepted) {
        throw new Error(result.detail);
      }
      return bridgeProviderResult('start', input, result.detail);
    }
    return await this.applyStartProviderSessions({
      ...input,
      actorId: 'runtime:provider/control'
    });
  }

  private async applyRuntimeAcceptingNewWork(input: {
    accepting: boolean;
    reason: string;
    requestedBy: RuntimeActorIdentity;
  }): Promise<void> {
    this.options.setAcceptingNewWork(input.accepting);
    this.options.appendAuditEvent('runtime.accepting.updated', {
      accepting: input.accepting,
      reason: input.reason,
      requestedBy: input.requestedBy.actorId
    });
  }

  private async applyStopProviderSessions(input: {
    threadId?: string;
    reason: string;
    requestedBy: RuntimeActorIdentity;
  }): Promise<ProviderControlResult> {
    const nowIso = this.options.now();
    let requestedCount = 0;
    let affectedCount = 0;
    if (input.threadId) {
      requestedCount = 1;
      const session = this.options.getSessionByThreadId(input.threadId);
      if (session) {
        this.options.upsertSession({
          ...session,
          providerAutoStartEnabled: false,
          providerStatus: 'closed',
          activeTurnId: null,
          updatedAt: nowIso
        });
        affectedCount = 1;
      }
      this.options.stopProviderSession(input.threadId);
    } else {
      this.options.setProviderAutoStartDefault(false);
      const sessions = this.options.listSessions().filter((session) => session.lifecycleStatus !== 'archived');
      requestedCount = sessions.length;
      for (const session of sessions) {
        this.options.upsertSession({
          ...session,
          providerAutoStartEnabled: false,
          providerStatus: 'closed',
          activeTurnId: null,
          updatedAt: nowIso
        });
        affectedCount += 1;
      }
      this.options.stopAllProviders();
    }
    await this.options.drainProviders();
    this.options.appendAuditEvent('provider.stop.requested', {
      scope: input.threadId ? 'thread' : 'all',
      threadId: input.threadId ?? null,
      reason: input.reason,
      requestedBy: input.requestedBy.actorId
    });
    const skippedCount = Math.max(0, requestedCount - affectedCount);
    return {
      ok: true,
      action: 'stop',
      scope: input.threadId ? 'thread' : 'all',
      threadId: input.threadId ?? null,
      requestedCount,
      affectedCount,
      skippedCount,
      failures: [],
      message: input.threadId
        ? providerSessionControlMessage('stop', input.threadId, affectedCount, skippedCount)
        : providerBulkControlMessage('stop', requestedCount, affectedCount, skippedCount)
    };
  }

  private async applyStartProviderSessions(input: {
    actorId: string;
    threadId?: string;
    reason: string;
    requestedBy: RuntimeActorIdentity;
  }): Promise<ProviderControlResult> {
    const nowIso = this.options.now();
    const failures: Array<{ threadId: string; error: string }> = [];
    let requestedCount = 0;
    let affectedCount = 0;
    if (input.threadId) {
      requestedCount = 1;
      const session = this.options.getSessionByThreadId(input.threadId);
      if (!session) {
        throw new Error(`Unknown session thread: ${input.threadId}`);
      }
      const updatedSession = this.options.updateSession({
        ...session,
        providerAutoStartEnabled: true,
        providerStatus: 'connecting',
        updatedAt: nowIso,
        lastError: null
      });
      try {
        await this.options.ensureProviderSession(updatedSession, input.actorId);
        affectedCount = 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.upsertSession({
          ...updatedSession,
          providerStatus: 'error',
          lastError: message,
          updatedAt: this.options.now()
        });
        failures.push({ threadId: updatedSession.threadId, error: message });
      }
    } else {
      this.options.setProviderAutoStartDefault(true);
      const sessions = this.options.listSessions().filter((session) => session.lifecycleStatus !== 'archived');
      requestedCount = sessions.length;
      for (const session of sessions) {
        const updatedSession = this.options.updateSession({
          ...session,
          providerAutoStartEnabled: true,
          providerStatus: 'connecting',
          updatedAt: nowIso,
          lastError: null
        });
        try {
          await this.options.ensureProviderSession(updatedSession, input.actorId);
          affectedCount += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ threadId: session.threadId, error: message });
          this.options.upsertSession({
            ...updatedSession,
            providerStatus: 'error',
            lastError: message,
            updatedAt: this.options.now()
          });
        }
      }
    }
    this.options.appendAuditEvent('provider.start.requested', {
      scope: input.threadId ? 'thread' : 'all',
      threadId: input.threadId ?? null,
      reason: input.reason,
      requestedBy: input.requestedBy.actorId,
      failureCount: failures.length,
      failures
    });
    if (failures.length > 0) {
      throw new Error(`Failed to start provider sessions: ${failures.map((entry) => `${entry.threadId}: ${entry.error}`).join('; ')}`);
    }
    const skippedCount = Math.max(0, requestedCount - affectedCount);
    return {
      ok: true,
      action: 'start',
      scope: input.threadId ? 'thread' : 'all',
      threadId: input.threadId ?? null,
      requestedCount,
      affectedCount,
      skippedCount,
      failures,
      message: input.threadId
        ? providerSessionControlMessage('start', input.threadId, affectedCount, skippedCount)
        : providerBulkControlMessage('start', requestedCount, affectedCount, skippedCount),
      ...(requestedCount === 0
        ? { remediation: 'Create a session, or run the provider test to verify provider startup without creating work state.' }
        : {})
    };
  }
}

function bridgeProviderResult(
  action: 'start' | 'stop',
  input: ProviderSessionControlInput,
  message: string
): ProviderControlResult {
  return {
    ok: true,
    action,
    scope: input.threadId ? 'thread' : 'all',
    threadId: input.threadId ?? null,
    requestedCount: input.threadId ? 1 : 0,
    affectedCount: input.threadId ? 1 : 0,
    skippedCount: 0,
    failures: [],
    message
  };
}

function providerBulkControlMessage(
  action: 'start' | 'stop',
  requestedCount: number,
  affectedCount: number,
  skippedCount: number
): string {
  if (requestedCount === 0) {
    return action === 'start'
      ? 'No active sessions exist yet, so no provider sessions were started.'
      : 'No active sessions exist yet, so no provider sessions were stopped.';
  }
  const verb = action === 'start' ? 'Started' : 'Stopped';
  const noun = affectedCount === 1 ? 'provider session' : 'provider sessions';
  const suffix = skippedCount > 0 ? ` (${skippedCount} skipped).` : '.';
  return `${verb} ${affectedCount} ${noun}${suffix}`;
}

function providerSessionControlMessage(
  action: 'start' | 'stop',
  threadId: string,
  affectedCount: number,
  skippedCount: number
): string {
  if (affectedCount === 0 && skippedCount > 0) {
    return `No provider session changed for ${threadId}.`;
  }
  return action === 'start' ? `Started provider session ${threadId}.` : `Stopped provider session ${threadId}.`;
}
