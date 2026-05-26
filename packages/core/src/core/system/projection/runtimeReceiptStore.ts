import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeReceiptRecord } from '../../runtime/execution/runtimeDomain.js';
import { openRuntimeSqliteDatabase } from '../state/sqlite/connection.js';
import { mapRows } from '../state/sqlite/rowMappers.js';

export class RuntimeReceiptStore {
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

  get(threadId: string): RuntimeReceiptRecord | null {
    return (
      (this.db
        .prepare(`
          SELECT
            thread_id as threadId,
            session_id as sessionId,
            space_id as spaceId,
            active_turn_id as activeTurnId,
            state,
            wait_reason as waitReason,
            pending_request_id as pendingRequestId,
            last_assistant_text as lastAssistantText,
            updated_at as updatedAt
          FROM runtime_receipts
          WHERE thread_id = ?
        `)
        .get(threadId) as RuntimeReceiptRecord | undefined) ?? null
    );
  }

  list(): RuntimeReceiptRecord[] {
    return mapRows<RuntimeReceiptRecord>(
      this.db
        .prepare(`
        SELECT
          thread_id as threadId,
          session_id as sessionId,
          space_id as spaceId,
          active_turn_id as activeTurnId,
          state,
          wait_reason as waitReason,
          pending_request_id as pendingRequestId,
          last_assistant_text as lastAssistantText,
          updated_at as updatedAt
        FROM runtime_receipts
        ORDER BY updated_at ASC, thread_id ASC
      `)
        .all()
    );
  }

  upsert(row: RuntimeReceiptRecord): void {
    this.db
      .prepare(`
        INSERT INTO runtime_receipts (
          thread_id, session_id, space_id, active_turn_id, state, wait_reason,
          pending_request_id, last_assistant_text, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          session_id = excluded.session_id,
          space_id = excluded.space_id,
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
        row.spaceId,
        row.activeTurnId,
        row.state,
        row.waitReason,
        row.pendingRequestId,
        row.lastAssistantText,
        row.updatedAt
      );
  }
}
