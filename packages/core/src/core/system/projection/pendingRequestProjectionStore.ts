import type { DatabaseSync } from 'node:sqlite';
import type { PendingRuntimeRequestRecord } from '../../../types/runtime.js';
import { openRuntimeSqliteDatabase } from '../state/sqlite/connection.js';
import { mapRows } from '../state/sqlite/rowMappers.js';

export class PendingRequestProjectionStore {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;

  constructor(pathOrDb: string | DatabaseSync) {
    if (typeof pathOrDb === 'string') {
      this.db = openRuntimeSqliteDatabase(pathOrDb);
      this.ownsDb = true;
      return;
    }
    this.db = pathOrDb;
    this.ownsDb = false;
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  get(requestId: string): PendingRuntimeRequestRecord | null {
    return (
      (this.db
        .prepare(`
          SELECT
            request_id as requestId,
            thread_id as threadId,
            turn_id as turnId,
            transport_resource_id as transportResourceId,
            requester_user_id as requesterUserId,
            message_id as messageId,
            request_type as requestType,
            status,
            detail,
            questions_json as questionsJson,
            decision,
            created_at as createdAt,
            resolved_at as resolvedAt
          FROM pending_runtime_requests
          WHERE request_id = ?
        `)
        .get(requestId) as PendingRuntimeRequestRecord | undefined) ?? null
    );
  }

  listByTransportResource(transportResourceId: string): PendingRuntimeRequestRecord[] {
    return mapRows<PendingRuntimeRequestRecord>(
      this.db
        .prepare(`
        SELECT
          request_id as requestId,
          thread_id as threadId,
          turn_id as turnId,
          transport_resource_id as transportResourceId,
          requester_user_id as requesterUserId,
          message_id as messageId,
          request_type as requestType,
          status,
          detail,
          questions_json as questionsJson,
          decision,
          created_at as createdAt,
          resolved_at as resolvedAt
        FROM pending_runtime_requests
        WHERE transport_resource_id = ?
        ORDER BY created_at ASC, request_id ASC
      `)
        .all(transportResourceId)
    );
  }

  listOpen(): PendingRuntimeRequestRecord[] {
    return mapRows<PendingRuntimeRequestRecord>(
      this.db
        .prepare(`
        SELECT
          request_id as requestId,
          thread_id as threadId,
          turn_id as turnId,
          transport_resource_id as transportResourceId,
          requester_user_id as requesterUserId,
          message_id as messageId,
          request_type as requestType,
          status,
          detail,
          questions_json as questionsJson,
          decision,
          created_at as createdAt,
          resolved_at as resolvedAt
        FROM pending_runtime_requests
        WHERE status = 'open'
        ORDER BY created_at ASC, request_id ASC
      `)
        .all()
    );
  }

  upsert(row: PendingRuntimeRequestRecord): void {
    this.db
      .prepare(`
        INSERT INTO pending_runtime_requests (
          request_id, thread_id, turn_id, transport_resource_id, requester_user_id, message_id,
          request_type, status, detail, questions_json, decision, created_at, resolved_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          transport_resource_id = excluded.transport_resource_id,
          requester_user_id = excluded.requester_user_id,
          message_id = excluded.message_id,
          request_type = excluded.request_type,
          status = excluded.status,
          detail = excluded.detail,
          questions_json = excluded.questions_json,
          decision = excluded.decision,
          created_at = excluded.created_at,
          resolved_at = excluded.resolved_at
      `)
      .run(
        row.requestId,
        row.threadId,
        row.turnId,
        row.transportResourceId,
        row.requesterUserId,
        row.messageId,
        row.requestType,
        row.status,
        row.detail,
        row.questionsJson,
        row.decision,
        row.createdAt,
        row.resolvedAt
      );
  }
}
