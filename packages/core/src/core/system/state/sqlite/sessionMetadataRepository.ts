import type { DatabaseSync } from 'node:sqlite';
import { safeReadJsonValue } from '../safeJson.js';

export class SessionMetadataRepository {
  constructor(private readonly db: DatabaseSync) {}

  putMetadata(key: string, value: unknown, updatedAt: string): void {
    this.db
      .prepare(`
        INSERT INTO runtime_metadata (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `)
      .run(key, JSON.stringify(value), updatedAt);
  }

  getMetadata<T>(key: string): T | null {
    const row = this.db
      .prepare(`SELECT value_json as valueJson FROM runtime_metadata WHERE key = ?`)
      .get(key) as { valueJson: string } | undefined;
    return row ? (safeReadJsonValue<T>(row.valueJson).value ?? null) : null;
  }
}
