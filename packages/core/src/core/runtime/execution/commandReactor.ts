import type { RuntimeModeName } from '../../../types/runtime.js';
import type { SessionOwnerLink } from '../../../types/plugin.js';
import type { RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';
import type { SessionRegistry } from '../../domain/sessions/sessionState.js';

export class CommandReactor {
  constructor(private readonly sessions: SessionRegistry) {}

  createCoordinationSession(input: {
    scopeId: string;
    transportResourceId: string;
    threadId: string;
    transportResourceName: string;
    workspacePath: string;
    runtimeMode: RuntimeModeName;
    nowIso: string;
    providerAutoStartEnabled?: boolean;
  }): RuntimeSessionRow | null {
    const existing = this.sessions.getByTransportResourceId(input.transportResourceId);
    if (existing) {
      return existing;
    }
    return this.sessions.updateSession({
      sessionId: `coordination-${input.transportResourceId}`,
      scopeId: input.scopeId,
      transportResourceId: input.transportResourceId,
      threadId: input.threadId,
      transportResourceName: input.transportResourceName,
      agentKind: 'ephemeral',
      workspacePath: null,
      providerCwd: input.workspacePath,
      runtimeMode: input.runtimeMode,
      lifecycleStatus: 'hot',
      summary: null,
      provider: this.sessions.providerPackageId,
      providerThreadId: null,
      resumeCursor: null,
      toolGrantIds: ['core.moorline_session'],
      providerStatus: 'connecting',
      providerAutoStartEnabled: input.providerAutoStartEnabled !== false,
      activeTurnId: null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
      lastActivityAt: input.nowIso,
      archivedAt: null,
      lastError: null
    });
  }

  createSession(input: {
    scopeId: string;
    transportResourceId: string;
    transportResourceName: string;
    requestedName: string;
    runtimeMode: RuntimeModeName;
    nowIso: string;
    providerAutoStartEnabled?: boolean;
    owner?: SessionOwnerLink;
    objective?: string;
    tags?: string[];
    createdBy?: string;
  }): RuntimeSessionRow {
    return this.sessions.create(input);
  }
}
