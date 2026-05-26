import type { DatabaseSync } from 'node:sqlite';

interface TableColumnInfo {
  name: string;
  pk: number;
}

function hasColumn(columns: TableColumnInfo[], columnName: string): boolean {
  return columns.some((column) => column.name === columnName);
}

function tableColumns(db: DatabaseSync, tableName: string): TableColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as unknown as TableColumnInfo[];
}

function createRetrievalTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_embeddings (
      scope_key TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      embedding_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, chunk_id)
    );

    CREATE TABLE IF NOT EXISTS retrieval_chunks (
      scope_key TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      layer TEXT NOT NULL,
      project_key TEXT,
      scope_id TEXT,
      space_id TEXT,
      thread_id TEXT,
      file_path TEXT NOT NULL,
      file_mtime_ms INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      source_refs TEXT NOT NULL,
      recency_boost REAL NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_tokens TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, chunk_id)
    );

    CREATE TABLE IF NOT EXISTS retrieval_files (
      scope_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      layer TEXT NOT NULL,
      project_key TEXT,
      scope_id TEXT,
      space_id TEXT,
      thread_id TEXT,
      file_mtime_ms INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_key, file_path)
    );

    CREATE TABLE IF NOT EXISTS retrieval_index_state (
      scope_key TEXT PRIMARY KEY,
      last_refresh_started_at TEXT NOT NULL,
      last_refresh_completed_at TEXT
    );
  `);
}

function ensureScopedIndexes(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_scope
      ON retrieval_chunks (layer, project_key, scope_id, space_id, thread_id);

    CREATE INDEX IF NOT EXISTS idx_retrieval_chunks_file
      ON retrieval_chunks (scope_key, file_path);

    CREATE INDEX IF NOT EXISTS idx_retrieval_files_scope
      ON retrieval_files (layer, project_key, scope_id, space_id, thread_id);
  `);
}

function isLegacyChunkSchema(columns: TableColumnInfo[]): boolean {
  return (
    columns.length > 0 &&
    (!hasColumn(columns, 'scope_key') || hasColumn(columns, 'guild_id') || hasColumn(columns, 'channel_id') || !hasColumn(columns, 'layer'))
  );
}

function isLegacyFileSchema(columns: TableColumnInfo[]): boolean {
  return (
    columns.length > 0 &&
    (!hasColumn(columns, 'scope_key') || hasColumn(columns, 'guild_id') || hasColumn(columns, 'channel_id') || !hasColumn(columns, 'layer'))
  );
}

function isLegacyEmbeddingSchema(columns: TableColumnInfo[]): boolean {
  return columns.length > 0 && hasColumn(columns, 'doc_id');
}

function assertCurrentRetrievalSchema(db: DatabaseSync): void {
  const outdatedTables: string[] = [];
  if (isLegacyChunkSchema(tableColumns(db, 'retrieval_chunks'))) {
    outdatedTables.push('retrieval_chunks');
  }
  if (isLegacyFileSchema(tableColumns(db, 'retrieval_files'))) {
    outdatedTables.push('retrieval_files');
  }
  if (isLegacyEmbeddingSchema(tableColumns(db, 'retrieval_embeddings'))) {
    outdatedTables.push('retrieval_embeddings');
  }
  if (outdatedTables.length > 0) {
    throw new Error(
      `Retrieval schema is outdated in ${outdatedTables.join(', ')}. Delete the retrieval index tables and let Moorline rebuild them with the current scope_key schema.`
    );
  }
}

export function ensureRetrievalSchema(db: DatabaseSync): void {
  createRetrievalTables(db);
  assertCurrentRetrievalSchema(db);
  ensureScopedIndexes(db);
}
