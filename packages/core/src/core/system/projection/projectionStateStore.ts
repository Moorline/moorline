import type { DatabaseSync } from 'node:sqlite';
import { openRuntimeSqliteDatabase } from '../state/sqlite/connection.js';
import { mapRows } from '../state/sqlite/rowMappers.js';

interface ProjectionStateRecord {
  projector: string;
  lastEventId: string | null;
  lastAppliedAt: string;
  failure: string | null;
}

export class ProjectionStateStore {
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

  get(projector: string): ProjectionStateRecord | null {
    return (
      (this.db
        .prepare(`
          SELECT
            projector as projector,
            last_event_id as lastEventId,
            last_applied_at as lastAppliedAt,
            failure
          FROM projection_state
          WHERE projector = ?
        `)
        .get(projector) as ProjectionStateRecord | undefined) ?? null
    );
  }

  upsert(input: ProjectionStateRecord): void {
    this.db
      .prepare(`
        INSERT INTO projection_state (projector, last_event_id, last_applied_at, failure)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(projector) DO UPDATE SET
          last_event_id = excluded.last_event_id,
          last_applied_at = excluded.last_applied_at,
          failure = excluded.failure
        WHERE excluded.last_applied_at >= projection_state.last_applied_at
      `)
      .run(input.projector, input.lastEventId, input.lastAppliedAt, input.failure);
  }

  list(): ProjectionStateRecord[] {
    return mapRows<ProjectionStateRecord>(
      this.db
        .prepare(`
        SELECT
          projector as projector,
          last_event_id as lastEventId,
          last_applied_at as lastAppliedAt,
          failure
        FROM projection_state
        ORDER BY projector ASC
      `)
        .all()
    );
  }
}
