import type { RuntimeReceiptRecord } from '../../runtime/execution/runtimeDomain.js';
import { RuntimeSnapshotQuery } from './runtimeSnapshotQuery.js';
import { SqliteSessionStore } from '../state/sqliteSessionStore.js';
import type { PendingRuntimeRequestRecord } from '../../../types/runtime.js';

interface ReconcileIssue {
  kind: 'missing-provider-binding' | 'stale-open-request' | 'missing-waiting-receipt';
  threadId: string;
  sessionId: string | null;
  detail: string;
  correction?:
    | { type: 'upsert_receipt'; receipt: RuntimeReceiptRecord }
    | { type: 'resolve_request'; request: PendingRuntimeRequestRecord; nowIso: string };
}

export class RuntimeReconciler {
  constructor(
    private readonly store: SqliteSessionStore,
    private readonly snapshots: RuntimeSnapshotQuery
  ) {}

  reconcile(nowIso: string): ReconcileIssue[] {
    const issues: ReconcileIssue[] = [];
    const overview = this.snapshots.overview();
    const receiptByThread = new Map<string, RuntimeReceiptRecord>(overview.receipts.map((receipt) => [receipt.threadId, receipt]));
    const sessionByThread = new Map(overview.sessions.map((snapshot) => [snapshot.session.threadId, snapshot]));
    const persistedSessionByThread = new Map<string, ReturnType<SqliteSessionStore['getSessionByThreadId']>>();
    for (const request of overview.openRequests) {
      if (!persistedSessionByThread.has(request.threadId)) {
        persistedSessionByThread.set(request.threadId, this.store.getSessionByThreadId(request.threadId));
      }
    }

    for (const snapshot of overview.sessions) {
      if (snapshot.session.sessionId.startsWith('chat-') || snapshot.session.lifecycleStatus === 'archived') {
        continue;
      }
      if (!snapshot.provider) {
        issues.push({
          kind: 'missing-provider-binding',
          threadId: snapshot.session.threadId,
          sessionId: snapshot.session.sessionId,
          detail: 'Session has no provider binding.'
        });
        continue;
      }
      for (const request of snapshot.pendingRequests.filter((entry) => entry.status === 'open')) {
        const receipt = receiptByThread.get(request.threadId);
        if (!receipt || (receipt.state !== 'waiting_for_approval' && receipt.state !== 'waiting_for_input')) {
          const rebuiltReceipt: RuntimeReceiptRecord = {
            threadId: request.threadId,
            sessionId: snapshot.session.sessionId,
            spaceId: snapshot.session.spaceId,
            activeTurnId: request.turnId,
            state: request.requestType === 'tool_user_input' ? 'waiting_for_input' : 'waiting_for_approval',
            waitReason: request.requestType === 'tool_user_input' ? 'user_input' : 'approval',
            pendingRequestId: request.requestId,
            lastAssistantText: receipt?.lastAssistantText ?? null,
            updatedAt: nowIso
          };
          issues.push({
            kind: 'missing-waiting-receipt',
            threadId: request.threadId,
            sessionId: snapshot.session.sessionId,
            detail: `Rebuilt waiting receipt for ${request.requestId}.`,
            correction: {
              type: 'upsert_receipt',
              receipt: rebuiltReceipt
            }
          });
        }
      }
    }

    for (const request of overview.openRequests) {
      const session = sessionByThread.get(request.threadId);
      const persistedSession = persistedSessionByThread.get(request.threadId) ?? null;
      if (
        (!session && persistedSession && persistedSession.lifecycleStatus !== 'archived') ||
        (session && session.session.lifecycleStatus !== 'archived')
      ) {
        continue;
      }
      if (!session || session.session.lifecycleStatus === 'archived') {
        issues.push({
          kind: 'stale-open-request',
          threadId: request.threadId,
          sessionId: session?.session.sessionId ?? null,
          detail: `Resolved stale request ${request.requestId}.`,
          correction: {
            type: 'resolve_request',
            request,
            nowIso
          }
        });
      }
    }

    return issues;
  }
}
