import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

interface MigrationResult {
  appliedVersions: number[];
}

interface MigrationFile {
  version: number;
  filename: string;
}

function parseMigrationFiles(migrationsDir: string): MigrationFile[] {
  const files = readdirSync(migrationsDir)
    .filter((file) => /^\d{3}_.+\.sql$/.test(file))
    .map((filename) => ({
      filename,
      version: Number.parseInt(filename.slice(0, 3), 10)
    }))
    .sort((a, b) => a.version - b.version);

  for (let i = 0; i < files.length; i += 1) {
    const expected = i + 1;
    if (files[i]?.version !== expected) {
      throw new Error(`Migration files must be sequential starting at 001 (expected ${expected.toString().padStart(3, '0')})`);
    }
  }

  return files;
}

export function runMigrations(dbPath: string, migrationsDir: string): MigrationResult {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const appliedRows = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ version: number }>;
    const applied = new Set(appliedRows.map((row) => row.version));

    const files = parseMigrationFiles(migrationsDir);
    const appliedVersions: number[] = [];

    for (const file of files) {
      if (applied.has(file.version)) {
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file.filename), 'utf8');
      db.exec('BEGIN');
      try {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(file.version, new Date().toISOString());
        db.exec('COMMIT');
        appliedVersions.push(file.version);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }

    return { appliedVersions };
  } finally {
    db.close();
  }
}
