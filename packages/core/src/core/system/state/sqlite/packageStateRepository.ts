import type { DatabaseSync } from 'node:sqlite';
import { mapRows } from './rowMappers.js';
import type { RuntimePackageStateRow } from './types.js';

export class PackageStateRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(packageId: string, key: string): RuntimePackageStateRow | null {
    return (
      (this.db
        .prepare(
          `SELECT package_id as packageId, key, value_json as valueJson, updated_at as updatedAt
           FROM runtime_package_state
           WHERE package_id = ? AND key = ?`
        )
        .get(packageId, key) as RuntimePackageStateRow | undefined) ?? null
    );
  }

  list(packageId: string, prefix?: string): RuntimePackageStateRow[] {
    const sql = prefix
      ? `SELECT package_id as packageId, key, value_json as valueJson, updated_at as updatedAt
         FROM runtime_package_state
         WHERE package_id = ? AND key LIKE ?
         ORDER BY key ASC`
      : `SELECT package_id as packageId, key, value_json as valueJson, updated_at as updatedAt
         FROM runtime_package_state
         WHERE package_id = ?
         ORDER BY key ASC`;
    const args = prefix ? [packageId, `${prefix}%`] : [packageId];
    return mapRows<RuntimePackageStateRow>(this.db.prepare(sql).all(...args));
  }

  put(row: RuntimePackageStateRow): void {
    this.db
      .prepare(
        `INSERT INTO runtime_package_state (package_id, key, value_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(package_id, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(row.packageId, row.key, row.valueJson, row.updatedAt);
  }

  delete(packageId: string, key: string): RuntimePackageStateRow | null {
    const existing = this.get(packageId, key);
    if (!existing) {
      return null;
    }
    this.db.prepare(`DELETE FROM runtime_package_state WHERE package_id = ? AND key = ?`).run(packageId, key);
    return existing;
  }
}
