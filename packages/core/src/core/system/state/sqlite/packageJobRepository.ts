import type { DatabaseSync } from 'node:sqlite';
import { mapRows } from './rowMappers.js';
import type { RuntimePackageJobRow } from './types.js';

const PACKAGE_JOB_SELECT = `
  SELECT
    package_id as packageId,
    job_id as jobId,
    action_id as actionId,
    schedule_text as schedule,
    schedule_anchor_at as scheduleAnchorAt,
    cadence_minutes as cadenceMinutes,
    schedule_meta_json as scheduleMetaJson,
    payload_json as payloadJson,
    next_run_at as nextRunAt,
    created_at as createdAt,
    updated_at as updatedAt
  FROM runtime_package_jobs
`;

export class PackageJobRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(row: RuntimePackageJobRow): void {
    this.db
      .prepare(
        `INSERT INTO runtime_package_jobs (
           package_id, job_id, action_id, schedule_text, schedule_anchor_at, cadence_minutes, schedule_meta_json,
           payload_json, next_run_at, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(package_id, job_id) DO UPDATE SET
           action_id = excluded.action_id,
           schedule_text = excluded.schedule_text,
           schedule_anchor_at = excluded.schedule_anchor_at,
           cadence_minutes = excluded.cadence_minutes,
           schedule_meta_json = excluded.schedule_meta_json,
           payload_json = excluded.payload_json,
           next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at`
      )
      .run(
        row.packageId,
        row.jobId,
        row.actionId,
        row.schedule,
        row.scheduleAnchorAt,
        row.cadenceMinutes,
        row.scheduleMetaJson,
        row.payloadJson,
        row.nextRunAt,
        row.createdAt,
        row.updatedAt
      );
  }

  get(packageId: string, jobId: string): RuntimePackageJobRow | null {
    return (
      (this.db.prepare(`${PACKAGE_JOB_SELECT} WHERE package_id = ? AND job_id = ?`).get(packageId, jobId) as
        | RuntimePackageJobRow
        | undefined) ?? null
    );
  }

  list(packageId: string): RuntimePackageJobRow[] {
    return mapRows<RuntimePackageJobRow>(
      this.db.prepare(`${PACKAGE_JOB_SELECT} WHERE package_id = ? ORDER BY created_at ASC, job_id ASC`).all(packageId)
    );
  }

  listDue(nowIso: string): RuntimePackageJobRow[] {
    return mapRows<RuntimePackageJobRow>(
      this.db
        .prepare(`${PACKAGE_JOB_SELECT} WHERE next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC`)
        .all(nowIso)
    );
  }

  delete(packageId: string, jobId: string): RuntimePackageJobRow | null {
    const existing = this.get(packageId, jobId);
    if (!existing) {
      return null;
    }
    this.db.prepare(`DELETE FROM runtime_package_jobs WHERE package_id = ? AND job_id = ?`).run(packageId, jobId);
    return existing;
  }
}
