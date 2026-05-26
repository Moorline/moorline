import { SqliteSessionStore, type RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';

interface SessionLifecycleConfig {
  cooldownMinutes: number;
  archiveAfterDays: number;
}

interface SessionTransition {
  sessionId: string;
  threadId: string;
  spaceId: string;
  from: RuntimeSessionRow['lifecycleStatus'];
  to: RuntimeSessionRow['lifecycleStatus'];
  at: string;
}

export class SessionLifecycleService {
  constructor(
    private readonly store: SqliteSessionStore,
    private readonly config: SessionLifecycleConfig
  ) {}

  recordActivity(threadId: string, nowIso: string): SessionTransition | null {
    const session = this.store.listSessions().find((entry) => entry.threadId === threadId);
    if (!session) {
      return null;
    }
    if (session.lifecycleStatus === 'archived') {
      return null;
    }

    const next: RuntimeSessionRow = {
      ...session,
      lifecycleStatus: 'hot',
      lastActivityAt: nowIso,
      archivedAt: null,
      updatedAt: nowIso
    };
    this.store.upsertSession(next);
    if (session.lifecycleStatus === 'hot') {
      return null;
    }
    return {
      sessionId: session.sessionId,
      threadId: session.threadId,
      spaceId: session.spaceId,
      from: session.lifecycleStatus,
      to: 'hot',
      at: nowIso
    };
  }

  sweep(nowIso: string): SessionTransition[] {
    const nowMs = Date.parse(nowIso);
    const transitions: SessionTransition[] = [];

    for (const session of this.store.listSessions()) {
      if (session.sessionId.startsWith('chat-') || session.threadId.startsWith('chat:')) {
        continue;
      }
      const idleMs = nowMs - Date.parse(session.lastActivityAt);
      const coolMs = this.config.cooldownMinutes * 60 * 1000;
      const archiveMs = this.config.archiveAfterDays * 24 * 60 * 60 * 1000;

      if (idleMs >= archiveMs && session.lifecycleStatus !== 'archived') {
        transitions.push({
          sessionId: session.sessionId,
          threadId: session.threadId,
          spaceId: session.spaceId,
          from: session.lifecycleStatus,
          to: 'archived',
          at: nowIso
        });
        continue;
      }

      if (idleMs >= coolMs && session.lifecycleStatus === 'hot') {
        this.store.upsertSession({
          ...session,
          lifecycleStatus: 'cool',
          updatedAt: nowIso
        });
        transitions.push({
          sessionId: session.sessionId,
          threadId: session.threadId,
          spaceId: session.spaceId,
          from: 'hot',
          to: 'cool',
          at: nowIso
        });
      }
    }

    return transitions;
  }
}
