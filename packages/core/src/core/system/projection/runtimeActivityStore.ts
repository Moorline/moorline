import type { DatabaseSync } from 'node:sqlite';
import { openRuntimeSqliteDatabase } from '../state/sqlite/connection.js';
import { mapRows } from '../state/sqlite/rowMappers.js';

export interface RuntimeActivityRecord {
  activityId: string;
  threadId: string;
  sessionId: string | null;
  spaceId: string | null;
  sourceEventId: string;
  kind: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail: string | null;
  createdAt: string;
}

export class RuntimeActivityStore {
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

  append(row: RuntimeActivityRecord): void {
    this.db
      .prepare(`
        INSERT INTO runtime_activities (
          activity_id, thread_id, session_id, space_id, source_event_id,
          kind, severity, title, detail, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.activityId,
        row.threadId,
        row.sessionId,
        row.spaceId,
        row.sourceEventId,
        row.kind,
        row.severity,
        row.title,
        row.detail,
        row.createdAt
      );
  }

  listByThread(threadId: string): RuntimeActivityRecord[] {
    return mapRows<RuntimeActivityRecord>(
      this.db
        .prepare(`
        SELECT
          activity_id as activityId,
          thread_id as threadId,
          session_id as sessionId,
          space_id as spaceId,
          source_event_id as sourceEventId,
          kind,
          severity,
          title,
          detail,
          created_at as createdAt
        FROM runtime_activities
        WHERE thread_id = ?
        ORDER BY created_at ASC, activity_id ASC
      `)
        .all(threadId)
    );
  }

  listRecentByThread(threadId: string, limit: number): RuntimeActivityRecord[] {
    return mapRows<RuntimeActivityRecord>(
      this.db
        .prepare(`
        SELECT
          activity_id as activityId,
          thread_id as threadId,
          session_id as sessionId,
          space_id as spaceId,
          source_event_id as sourceEventId,
          kind,
          severity,
          title,
          detail,
          created_at as createdAt
        FROM runtime_activities
        WHERE thread_id = ?
        ORDER BY created_at DESC, activity_id DESC
        LIMIT ?
      `)
        .all(threadId, Math.max(1, limit))
    ).reverse();
  }

  listRecentByThreads(threadIds: string[], limitPerThread: number): Map<string, RuntimeActivityRecord[]> {
    const normalizedThreadIds = [...new Set(threadIds.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
    if (normalizedThreadIds.length === 0) {
      return new Map();
    }
    const placeholders = normalizedThreadIds.map(() => '?').join(', ');
    const rows = mapRows<RuntimeActivityRecord>(
      this.db
        .prepare(`
        SELECT
          activityId,
          threadId,
          sessionId,
          spaceId,
          sourceEventId,
          kind,
          severity,
          title,
          detail,
          createdAt
        FROM (
          SELECT
            activity_id as activityId,
            thread_id as threadId,
            session_id as sessionId,
            space_id as spaceId,
            source_event_id as sourceEventId,
            kind,
            severity,
            title,
            detail,
            created_at as createdAt,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY created_at DESC, activity_id DESC
            ) as rowNum
          FROM runtime_activities
          WHERE thread_id IN (${placeholders})
        )
        WHERE rowNum <= ?
        ORDER BY threadId ASC, createdAt DESC, activityId DESC
      `)
        .all(...normalizedThreadIds, Math.max(1, limitPerThread))
    );

    const grouped = new Map<string, RuntimeActivityRecord[]>();
    for (const row of rows) {
      const bucket = grouped.get(row.threadId);
      if (bucket) {
        bucket.push(row);
      } else {
        grouped.set(row.threadId, [row]);
      }
    }
    for (const [threadId, bucket] of grouped.entries()) {
      grouped.set(threadId, [...bucket].reverse());
    }
    return grouped;
  }

  listRecent(limit: number): RuntimeActivityRecord[] {
    return mapRows<RuntimeActivityRecord>(
      this.db
        .prepare(`
        SELECT
          activity_id as activityId,
          thread_id as threadId,
          session_id as sessionId,
          space_id as spaceId,
          source_event_id as sourceEventId,
          kind,
          severity,
          title,
          detail,
          created_at as createdAt
        FROM runtime_activities
        ORDER BY created_at DESC, activity_id DESC
        LIMIT ?
      `)
        .all(limit)
    );
  }
}
