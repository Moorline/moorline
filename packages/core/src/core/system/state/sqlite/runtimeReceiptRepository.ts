import type { DatabaseSync } from 'node:sqlite';
import { mapRows } from './rowMappers.js';
import type { RuntimeReceiptRecord } from './types.js';

const runtimeReceiptSelect = `
  SELECT
    thread_id as threadId,
    session_id as sessionId,
    transport_resource_id as transportResourceId,
    active_turn_id as activeTurnId,
    state,
    wait_reason as waitReason,
    pending_request_id as pendingRequestId,
    last_assistant_text as lastAssistantText,
    updated_at as updatedAt
  FROM runtime_receipts
`;

export class RuntimeReceiptRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsertRuntimeReceipt(row: RuntimeReceiptRecord): void {
    this.db
      .prepare(`
        INSERT INTO runtime_receipts (
          thread_id, session_id, transport_resource_id, active_turn_id, state, wait_reason,
          pending_request_id, last_assistant_text, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          session_id = excluded.session_id,
          transport_resource_id = excluded.transport_resource_id,
          active_turn_id = excluded.active_turn_id,
          state = excluded.state,
          wait_reason = excluded.wait_reason,
          pending_request_id = excluded.pending_request_id,
          last_assistant_text = excluded.last_assistant_text,
          updated_at = excluded.updated_at
      `)
      .run(
        row.threadId,
        row.sessionId,
        row.transportResourceId,
        row.activeTurnId,
        row.state,
        row.waitReason,
        row.pendingRequestId,
        row.lastAssistantText,
        row.updatedAt
      );
  }

  getRuntimeReceipt(threadId: string): RuntimeReceiptRecord | null {
    return (this.db.prepare(`${runtimeReceiptSelect} WHERE thread_id = ?`).get(threadId) as RuntimeReceiptRecord | undefined) ?? null;
  }

  listRuntimeReceipts(): RuntimeReceiptRecord[] {
    return mapRows<RuntimeReceiptRecord>(this.db.prepare(`${runtimeReceiptSelect} ORDER BY updated_at ASC, thread_id ASC`).all());
  }
}
