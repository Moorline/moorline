import type { DatabaseSync } from 'node:sqlite';
import { SqliteSessionStore, type RuntimeSessionRow } from '../state/sqliteSessionStore.js';
import { RuntimeActivityStore, type RuntimeActivityRecord } from './runtimeActivityStore.js';
import { ProjectionStateStore } from './projectionStateStore.js';
import type { PendingRuntimeRequestRecord } from '../../../types/runtime.js';
import type { RuntimeReceiptRecord } from '../../runtime/execution/runtimeDomain.js';
import { ProviderSessionDirectory } from '../../runtime/execution/providerSessionDirectory.js';
import {
  toRuntimeProviderConnectionSnapshot,
  type ProviderConnectionRecord
} from '../../runtime/execution/providerProjectionTypes.js';
import type { RuntimeProviderConnectionSnapshot } from '../../../types/plugin.js';
import type { SessionQueryFilter } from '../../../types/plugin.js';
import { isManagedWorkerSession } from '../../domain/sessions/managedWorkerSessions.js';

interface RuntimeSessionSnapshot {
  session: RuntimeSessionRow;
  receipt: RuntimeReceiptRecord | null;
  provider: RuntimeProviderConnectionSnapshot | null;
  pendingRequests: PendingRuntimeRequestRecord[];
  recentActivities: RuntimeActivityRecord[];
}

interface RuntimeOverviewSnapshot {
  sessions: RuntimeSessionSnapshot[];
  receipts: RuntimeReceiptRecord[];
  providers: RuntimeProviderConnectionSnapshot[];
  projectionStates: Array<{
    projector: string;
    lastEventId: string | null;
    lastAppliedAt: string;
    failure: string | null;
  }>;
  openRequests: PendingRuntimeRequestRecord[];
}

export class RuntimeSnapshotQuery {
  private readonly activities: RuntimeActivityStore;
  private readonly projections: ProjectionStateStore;
  private readonly directory: ProviderSessionDirectory;

  constructor(private readonly store: SqliteSessionStore, sqlitePathOrDb: string | DatabaseSync) {
    this.activities = new RuntimeActivityStore(sqlitePathOrDb);
    this.projections = new ProjectionStateStore(sqlitePathOrDb);
    this.directory = new ProviderSessionDirectory(store);
  }

  getSessionBySpaceId(spaceId: string): RuntimeSessionSnapshot | null {
    const session = this.store.getSessionBySpaceId(spaceId);
    return session ? this.buildSessionSnapshot(session) : null;
  }

  getSessionByThreadId(threadId: string): RuntimeSessionSnapshot | null {
    const session = this.store.getSessionByThreadId(threadId);
    return session ? this.buildSessionSnapshot(session) : null;
  }

  getSessionById(sessionId: string): RuntimeSessionSnapshot | null {
    const session = this.store.getSession(sessionId);
    return session ? this.buildSessionSnapshot(session) : null;
  }

  listSessions(): RuntimeSessionSnapshot[] {
    const sessions = this.store.listSessions();
    if (sessions.length === 0) {
      return [];
    }
    const threadIds = sessions.map((session) => session.threadId);
    const receiptsByThread = new Map(this.store.listRuntimeReceipts().map((receipt) => [receipt.threadId, receipt] as const));
    const providersByThread = new Map(
      this.directory.list().map((provider) => [
        provider.threadId,
        toRuntimeProviderConnectionSnapshot(provider)
      ] as const)
    );
    const pendingRequestsByThread = new Map<string, PendingRuntimeRequestRecord[]>();
    for (const request of this.store.listOpenPendingRequests()) {
      const bucket = pendingRequestsByThread.get(request.threadId);
      if (bucket) {
        bucket.push(request);
      } else {
        pendingRequestsByThread.set(request.threadId, [request]);
      }
    }
    const recentActivitiesByThread = this.activities.listRecentByThreads(threadIds, 10);

    return sessions.map((session) => ({
      session,
      receipt: receiptsByThread.get(session.threadId) ?? null,
      provider: providersByThread.get(session.threadId) ?? null,
      pendingRequests: pendingRequestsByThread.get(session.threadId) ?? [],
      recentActivities: recentActivitiesByThread.get(session.threadId) ?? []
    }));
  }

  querySessions(filter: SessionQueryFilter = {}): RuntimeSessionSnapshot[] {
    const normalizedTag = filter.tag?.trim().toLowerCase();
    const normalizedObjective = filter.objectiveText?.trim().toLowerCase();
    return this.listSessions()
      .filter((snapshot) => {
        if (filter.scope === 'managed_workers' && !isManagedWorkerSession(snapshot.session)) {
          return false;
        }
        if (filter.includeArchived !== true && snapshot.session.lifecycleStatus === 'archived') {
          return false;
        }
        if (filter.lifecycleStatuses && !filter.lifecycleStatuses.includes(snapshot.session.lifecycleStatus)) {
          return false;
        }
        if (filter.runtimeModes && !filter.runtimeModes.includes(snapshot.session.runtimeMode)) {
          return false;
        }
        if (filter.ownerKind && snapshot.session.ownerKind !== filter.ownerKind) {
          return false;
        }
        if (filter.ownerId && snapshot.session.ownerId !== filter.ownerId) {
          return false;
        }
        if (normalizedTag && !(snapshot.session.tags ?? []).some((tag) => tag.toLowerCase() === normalizedTag)) {
          return false;
        }
        if (
          normalizedObjective &&
          !(snapshot.session.objective ?? '').toLowerCase().includes(normalizedObjective)
        ) {
          return false;
        }
        if (filter.waitStates && !filter.waitStates.includes(snapshot.receipt?.state ?? 'idle')) {
          return false;
        }
        return true;
      })
      .slice(0, Math.max(0, filter.limit ?? Number.MAX_SAFE_INTEGER));
  }

  overview(): RuntimeOverviewSnapshot {
    return {
      sessions: this.listSessions(),
      receipts: this.store.listRuntimeReceipts(),
      providers: this.directory.list().map((provider) => toRuntimeProviderConnectionSnapshot(provider)),
      projectionStates: this.projections.list(),
      openRequests: this.store.listOpenPendingRequests()
    };
  }

  getOpenRequestById(requestId: string): PendingRuntimeRequestRecord | null {
    return this.store.listOpenPendingRequests().find((request) => request.requestId === requestId) ?? null;
  }

  listOpenRequestsBySpace(spaceId: string): PendingRuntimeRequestRecord[] {
    return this.store.listOpenPendingRequestsBySpace(spaceId);
  }

  listRecentActivities(limit: number): RuntimeActivityRecord[] {
    return this.activities.listRecent(limit);
  }

  close(): void {
    this.activities.close();
    this.projections.close();
  }

  findOpenRequestByMessage(spaceId: string, messageId: string): PendingRuntimeRequestRecord | null {
    return (
      this.listOpenRequestsBySpace(spaceId).find(
        (request) =>
          request.messageId === messageId &&
          request.requestType !== 'tool_user_input'
      ) ?? null
    );
  }

  private buildSessionSnapshot(session: RuntimeSessionRow): RuntimeSessionSnapshot {
    return {
      session,
      receipt: this.store.getRuntimeReceipt(session.threadId),
      provider: this.mapProvider(this.directory.get(session.threadId)),
      pendingRequests: this.store.listOpenPendingRequestsByThread(session.threadId),
      recentActivities: this.activities.listRecentByThread(session.threadId, 10)
    };
  }

  private mapProvider(provider: ProviderConnectionRecord | null): RuntimeProviderConnectionSnapshot | null {
    return provider ? toRuntimeProviderConnectionSnapshot(provider) : null;
  }
}
