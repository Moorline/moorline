import type { DatabaseSync } from 'node:sqlite';
import { mapRows } from './rowMappers.js';
import type { RuntimeOrchestrationRequestRow } from './types.js';

export class RuntimeOrchestrationRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsertOrchestrationRequest(row: RuntimeOrchestrationRequestRow): void {
    this.db
      .prepare(`
        INSERT INTO runtime_orchestration_requests (
          request_id, actor_id, requested_by_thread_id, requested_by_transport_resource_id, dedupe_key, type, target_session_id,
          payload_json, status, result_json, error, execution_owner, execution_attempt, execution_started_at,
          completion_token, completed_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          actor_id = excluded.actor_id,
          requested_by_thread_id = excluded.requested_by_thread_id,
          requested_by_transport_resource_id = excluded.requested_by_transport_resource_id,
          dedupe_key = excluded.dedupe_key,
          type = excluded.type,
          target_session_id = excluded.target_session_id,
          payload_json = excluded.payload_json,
          status = excluded.status,
          result_json = excluded.result_json,
          error = excluded.error,
          execution_owner = excluded.execution_owner,
          execution_attempt = excluded.execution_attempt,
          execution_started_at = excluded.execution_started_at,
          completion_token = excluded.completion_token,
          completed_at = excluded.completed_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `)
      .run(
        row.requestId,
        row.actorId,
        row.requestedByThreadId,
        row.requestedByTransportResourceId,
        row.dedupeKey,
        row.type,
        row.targetSessionId,
        row.payloadJson,
        row.status,
        row.resultJson,
        row.error,
        row.executionOwner,
        row.executionAttempt,
        row.executionStartedAt,
        row.completionToken,
        row.completedAt,
        row.createdAt,
        row.updatedAt
      );
  }

  claimPendingOrchestrationRequest(input: {
    requestId: string;
    executionOwner: string;
    nowIso: string;
  }): RuntimeOrchestrationRequestRow | null {
    const updated = this.db
      .prepare(`
        UPDATE runtime_orchestration_requests
        SET
          status = 'running',
          error = NULL,
          execution_owner = ?,
          execution_attempt = execution_attempt + 1,
          execution_started_at = ?,
          completion_token = NULL,
          completed_at = NULL,
          updated_at = ?
        WHERE request_id = ? AND status = 'pending'
      `)
      .run(input.executionOwner, input.nowIso, input.nowIso, input.requestId) as { changes?: number };
    if ((updated.changes ?? 0) === 0) {
      return null;
    }
    return this.getOrchestrationRequest(input.requestId);
  }

  failAbandonedRunningOrchestrationRequests(input: {
    executionOwner: string;
    nowIso: string;
    error: string;
  }): number {
    const result = this.db
      .prepare(`
        UPDATE runtime_orchestration_requests
        SET
          status = 'failed',
          error = ?,
          execution_owner = ?,
          completed_at = ?,
          updated_at = ?
        WHERE status = 'running' AND completion_token IS NULL
      `)
      .run(input.error, input.executionOwner, input.nowIso, input.nowIso) as { changes?: number };
    return result.changes ?? 0;
  }

  getOrchestrationRequest(requestId: string): RuntimeOrchestrationRequestRow | null {
    return (
      (this.db
        .prepare(`
          SELECT
            request_id as requestId,
            actor_id as actorId,
            requested_by_thread_id as requestedByThreadId,
            requested_by_transport_resource_id as requestedByTransportResourceId,
            dedupe_key as dedupeKey,
            type,
            target_session_id as targetSessionId,
            payload_json as payloadJson,
            status,
            result_json as resultJson,
            error,
            execution_owner as executionOwner,
            execution_attempt as executionAttempt,
            execution_started_at as executionStartedAt,
            completion_token as completionToken,
            completed_at as completedAt,
            created_at as createdAt,
            updated_at as updatedAt
          FROM runtime_orchestration_requests
          WHERE request_id = ?
        `)
        .get(requestId) as RuntimeOrchestrationRequestRow | undefined) ?? null
    );
  }

  getLatestOrchestrationRequestByDedupeKey(dedupeKey: string): RuntimeOrchestrationRequestRow | null {
    return (
      (this.db
        .prepare(`
          SELECT
            request_id as requestId,
            actor_id as actorId,
            requested_by_thread_id as requestedByThreadId,
            requested_by_transport_resource_id as requestedByTransportResourceId,
            dedupe_key as dedupeKey,
            type,
            target_session_id as targetSessionId,
            payload_json as payloadJson,
            status,
            result_json as resultJson,
            error,
            execution_owner as executionOwner,
            execution_attempt as executionAttempt,
            execution_started_at as executionStartedAt,
            completion_token as completionToken,
            completed_at as completedAt,
            created_at as createdAt,
            updated_at as updatedAt
          FROM runtime_orchestration_requests
          WHERE dedupe_key = ?
          ORDER BY created_at DESC, request_id DESC
          LIMIT 1
        `)
        .get(dedupeKey) as RuntimeOrchestrationRequestRow | undefined) ?? null
    );
  }

  listOpenOrchestrationRequests(): RuntimeOrchestrationRequestRow[] {
    return mapRows<RuntimeOrchestrationRequestRow>(
      this.db
        .prepare(`
        SELECT
          request_id as requestId,
          actor_id as actorId,
          requested_by_thread_id as requestedByThreadId,
          requested_by_transport_resource_id as requestedByTransportResourceId,
          dedupe_key as dedupeKey,
          type,
          target_session_id as targetSessionId,
          payload_json as payloadJson,
          status,
          result_json as resultJson,
          error,
          execution_owner as executionOwner,
          execution_attempt as executionAttempt,
          execution_started_at as executionStartedAt,
          completion_token as completionToken,
          completed_at as completedAt,
          created_at as createdAt,
          updated_at as updatedAt
        FROM runtime_orchestration_requests
        WHERE status IN ('pending', 'running')
        ORDER BY created_at ASC, request_id ASC
      `)
        .all()
    );
  }
}
