import type { RuntimeModeName } from '../../../types/runtime.js';
import type { SessionOwnerLink } from '../../../types/plugin.js';
import type { RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';
import type { SessionRegistry } from '../../domain/sessions/sessionState.js';

export class CommandReactor {
  constructor(private readonly sessions: SessionRegistry) {}

  createChatSession(input: {
    scopeId: string;
    spaceId: string;
    threadId: string;
    spaceName: string;
    workspacePath: string;
    runtimeMode: RuntimeModeName;
    nowIso: string;
    providerAutoStartEnabled?: boolean;
  }): RuntimeSessionRow | null {
    const existing = this.sessions.getBySpaceId(input.spaceId);
    if (existing) {
      return existing;
    }
    return this.sessions.updateSession({
      sessionId: `chat-${input.spaceId}`,
      scopeId: input.scopeId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      spaceName: input.spaceName,
      workspacePath: input.workspacePath,
      runtimeMode: input.runtimeMode,
      lifecycleStatus: 'hot',
      summary: null,
      provider: this.sessions.providerPackageId,
      providerThreadId: null,
      resumeThreadId: null,
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
    spaceId: string;
    spaceName: string;
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
