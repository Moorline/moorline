import type { DatabaseSync } from 'node:sqlite';
import { mapRows } from './rowMappers.js';
import type { PendingRuntimeRequestRecord } from './types.js';

const pendingRequestSelect = `
  SELECT
    request_id as requestId,
    thread_id as threadId,
    turn_id as turnId,
    space_id as spaceId,
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
`;

export class PendingRequestRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsertPendingRequest(row: PendingRuntimeRequestRecord): void {
    this.db
      .prepare(`
        INSERT INTO pending_runtime_requests (
          request_id, thread_id, turn_id, space_id, requester_user_id, message_id,
          request_type, status, detail, questions_json, decision, created_at, resolved_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          space_id = excluded.space_id,
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
        row.spaceId,
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

  getPendingRequest(requestId: string): PendingRuntimeRequestRecord | null {
    return (this.db.prepare(`${pendingRequestSelect} WHERE request_id = ?`).get(requestId) as PendingRuntimeRequestRecord | undefined) ?? null;
  }

  listPendingRequestsBySpace(spaceId: string | null | undefined): PendingRuntimeRequestRecord[] {
    if (typeof spaceId !== 'string' || spaceId.trim().length === 0) {
      return [];
    }
    return mapRows<PendingRuntimeRequestRecord>(
      this.db.prepare(`${pendingRequestSelect} WHERE space_id = ? ORDER BY created_at ASC, request_id ASC`).all(spaceId)
    );
  }

  listOpenPendingRequests(): PendingRuntimeRequestRecord[] {
    return mapRows<PendingRuntimeRequestRecord>(
      this.db.prepare(`${pendingRequestSelect} WHERE status = 'open' ORDER BY created_at ASC, request_id ASC`).all()
    );
  }

  listOpenPendingRequestsBySpace(spaceId: string | null | undefined): PendingRuntimeRequestRecord[] {
    if (typeof spaceId !== 'string' || spaceId.trim().length === 0) {
      return [];
    }
    return mapRows<PendingRuntimeRequestRecord>(
      this.db.prepare(`${pendingRequestSelect} WHERE status = 'open' AND space_id = ? ORDER BY created_at ASC, request_id ASC`).all(spaceId)
    );
  }

  listOpenPendingRequestsByThread(threadId: string | null | undefined): PendingRuntimeRequestRecord[] {
    if (typeof threadId !== 'string' || threadId.trim().length === 0) {
      return [];
    }
    return mapRows<PendingRuntimeRequestRecord>(
      this.db.prepare(`${pendingRequestSelect} WHERE status = 'open' AND thread_id = ? ORDER BY created_at ASC, request_id ASC`).all(threadId)
    );
  }

  deletePendingRequest(requestId: string): void {
    this.db.prepare(`DELETE FROM pending_runtime_requests WHERE request_id = ?`).run(requestId);
  }
}
