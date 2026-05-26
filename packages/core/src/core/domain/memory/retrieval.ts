import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { walkMarkdownFiles } from './retrieval/fileWalker.js';
import { buildIndexTargets } from './retrieval/indexTargets.js';
import { extractHeadings, markdownAwareChunks, tokenizeMetadata } from './retrieval/markdownChunker.js';
import { safeParseEmbedding, safeParseStringArray } from './retrieval/parse.js';
import { rankByScore, rerankWithHeuristics, topStrategy } from './retrieval/ranking.js';
import { ensureRetrievalSchema } from './retrieval/schema.js';
import {
  normalizeScope,
  scopeFilterArgs,
  scopeKey,
  selectScopeFilter,
  storageScopeKey,
  type NormalizedRetrievalScope
} from './retrieval/scope.js';
import { cosineSimilarity, hashContent, normalizeTokens, tokenEmbedding } from './retrieval/tokenEmbedding.js';
import { openRuntimeSqliteDatabase } from '../../system/state/sqlite/connection.js';
import type {
  CachedEmbeddingChunkRow,
  CandidateDoc,
  HybridRetrievalDocument,
  RetrievalChunkRow,
  RetrievalDocument,
  RetrievalFileRow,
  RetrievalIndexStateRow,
  RetrievalOptions,
  RetrievalScope,
  StrategyScores,
  VectorRow
} from './retrieval/types.js';
import { EMBEDDING_VERSION, REFRESH_INTERVAL_MS, RRF_K } from './retrieval/types.js';

const refreshJobs = new Map<string, Promise<void>>();

function refreshJobKey(repoPath: string, scope: NormalizedRetrievalScope, sqlitePath: string): string {
  return `${resolve(repoPath)}::${resolve(sqlitePath)}::${scopeKey(scope)}`;
}

function chunkIdentity(scopeStorageKey: string, chunkId: string): string {
  return `${scopeStorageKey}\u0000${chunkId}`;
}

function fileIdentity(scopeStorageKey: string, filePath: string): string {
  return `${scopeStorageKey}\u0000${filePath}`;
}

function upsertRefreshState(db: DatabaseSync, key: string, startedAt: string, completedAt: string | null): void {
  db.prepare(`
      INSERT INTO retrieval_index_state (scope_key, last_refresh_started_at, last_refresh_completed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        last_refresh_started_at = excluded.last_refresh_started_at,
        last_refresh_completed_at = excluded.last_refresh_completed_at
    `).run(key, startedAt, completedAt);
}

async function refreshMemoryIndexInternal(repoPath: string, scope: NormalizedRetrievalScope, sqlitePath: string): Promise<void> {
  const db = openRuntimeSqliteDatabase(sqlitePath);
  try {
    ensureRetrievalSchema(db);

    const key = scopeKey(scope);
    const startedAt = new Date().toISOString();
    upsertRefreshState(db, key, startedAt, null);

    const targets = buildIndexTargets(repoPath, scope);
    const indexedRows = db
      .prepare(
        `SELECT scope_key as scopeKey, file_path as filePath, file_mtime_ms as fileMtimeMs, file_size as fileSize
         FROM retrieval_files
         WHERE ${selectScopeFilter('retrieval_files', !scope.spaceId)}`
      )
      .all(...scopeFilterArgs(scope)) as unknown as RetrievalFileRow[];
    const indexedByPath = new Map(indexedRows.map((row) => [fileIdentity(row.scopeKey, row.filePath), row]));

    const seenPaths = new Set<string>();
    const deleteChunksByFile = db.prepare('DELETE FROM retrieval_chunks WHERE scope_key = ? AND file_path = ?');
    const deleteEmbeddingsByFile = db.prepare(
      'DELETE FROM retrieval_embeddings WHERE scope_key = ? AND chunk_id IN (SELECT chunk_id FROM retrieval_chunks WHERE scope_key = ? AND file_path = ?)'
    );
    const deleteFileRow = db.prepare('DELETE FROM retrieval_files WHERE scope_key = ? AND file_path = ?');
    const selectCachedChunks = db.prepare(`
      SELECT
        c.scope_key as scopeKey,
        c.chunk_id as chunkId,
        c.content as content,
        c.content_hash as contentHash,
        e.embedding as embedding,
        e.embedding_version as embeddingVersion
      FROM retrieval_chunks c
      LEFT JOIN retrieval_embeddings e ON e.scope_key = c.scope_key AND e.chunk_id = c.chunk_id
      WHERE c.scope_key = ? AND c.file_path = ?
      ORDER BY c.chunk_index ASC
    `);
    const upsertVector = db.prepare(`
      INSERT INTO retrieval_embeddings (scope_key, chunk_id, content_hash, embedding, embedding_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, chunk_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        embedding = excluded.embedding,
        embedding_version = excluded.embedding_version,
        updated_at = excluded.updated_at
    `);
    const upsertChunk = db.prepare(`
      INSERT INTO retrieval_chunks (
        scope_key,
        chunk_id,
        doc_id,
        layer,
        project_key,
        scope_id,
        space_id,
        thread_id,
        file_path,
        file_mtime_ms,
        file_size,
        chunk_index,
        content,
        source_refs,
        recency_boost,
        content_hash,
        metadata_tokens,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, chunk_id) DO UPDATE SET
        doc_id = excluded.doc_id,
        layer = excluded.layer,
        project_key = excluded.project_key,
        scope_id = excluded.scope_id,
        space_id = excluded.space_id,
        thread_id = excluded.thread_id,
        file_path = excluded.file_path,
        file_mtime_ms = excluded.file_mtime_ms,
        file_size = excluded.file_size,
        chunk_index = excluded.chunk_index,
        content = excluded.content,
        source_refs = excluded.source_refs,
        recency_boost = excluded.recency_boost,
        content_hash = excluded.content_hash,
        metadata_tokens = excluded.metadata_tokens,
        updated_at = excluded.updated_at
    `);
    const upsertFile = db.prepare(`
      INSERT INTO retrieval_files (
        scope_key,
        file_path,
        layer,
        project_key,
        scope_id,
        space_id,
        thread_id,
        file_mtime_ms,
        file_size,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, file_path) DO UPDATE SET
        project_key = excluded.project_key,
        layer = excluded.layer,
        scope_id = excluded.scope_id,
        space_id = excluded.space_id,
        thread_id = excluded.thread_id,
        file_mtime_ms = excluded.file_mtime_ms,
        file_size = excluded.file_size,
        updated_at = excluded.updated_at
    `);

    for (const target of targets) {
      const targetScopeKey = storageScopeKey(target);
      const markdownFiles = await walkMarkdownFiles(target.rootPath);
      for (const path of markdownFiles) {
        let fileStat: Awaited<ReturnType<typeof stat>>;
        try {
          fileStat = await stat(path);
        } catch {
          continue;
        }

        seenPaths.add(fileIdentity(targetScopeKey, path));
        const existing = indexedByPath.get(fileIdentity(targetScopeKey, path));
        if (existing && existing.fileMtimeMs === fileStat.mtimeMs && existing.fileSize === fileStat.size) {
          const cachedChunks = selectCachedChunks.all(targetScopeKey, path) as unknown as CachedEmbeddingChunkRow[];
          const needsEmbeddingRefresh =
            cachedChunks.length > 0 &&
            cachedChunks.some((row) => {
              const parsed = row.embedding ? safeParseEmbedding(row.embedding) : null;
              return row.embeddingVersion !== EMBEDDING_VERSION || !parsed;
            });

          if (needsEmbeddingRefresh) {
            const nowIso = new Date().toISOString();
            for (const chunk of cachedChunks) {
              upsertVector.run(
                targetScopeKey,
                chunk.chunkId,
                chunk.contentHash,
                JSON.stringify(tokenEmbedding(chunk.content)),
                EMBEDDING_VERSION,
                nowIso
              );
            }
          }

          if (cachedChunks.length > 0) {
            continue;
          }
        }

        let content: string;
        try {
          content = await readFile(path, 'utf8');
        } catch {
          continue;
        }

        const nowIso = new Date().toISOString();
        const ageHours = (Date.now() - fileStat.mtimeMs) / (1000 * 60 * 60);
        const recencyBoost = Math.max(0, 0.25 - ageHours / (24 * 30));
        const chunks = markdownAwareChunks(content);
        const rel = path.startsWith(repoPath) ? path.slice(repoPath.length + 1) : path;
        const headings = extractHeadings(content);
        const metadataTokens = tokenizeMetadata(`${rel}\n${headings.join(' ')}`);
        const candidateDocs: CandidateDoc[] = chunks.map((chunk, index) => ({
          scopeKey: targetScopeKey,
          docId: rel,
          chunkId: `${rel}#chunk-${index + 1}`,
          chunkIndex: index,
          content: chunk,
          sourceRefs: [`${rel}#chunk-${index + 1}`],
          recencyBoost,
          contentHash: hashContent(chunk),
          metadataTokens
        }));

        const cachedChunksForFile = selectCachedChunks.all(targetScopeKey, path) as unknown as CachedEmbeddingChunkRow[];
        const vectorById = new Map(cachedChunksForFile.map((row) => [row.chunkId, row]));

        deleteEmbeddingsByFile.run(targetScopeKey, targetScopeKey, path);
        deleteChunksByFile.run(targetScopeKey, path);

        for (const doc of candidateDocs) {
          const existingVector = vectorById.get(doc.chunkId);
          const parsedVector = existingVector?.embedding ? safeParseEmbedding(existingVector.embedding) : null;
          const vector =
            existingVector &&
            existingVector.contentHash === doc.contentHash &&
            existingVector.embeddingVersion === EMBEDDING_VERSION &&
            parsedVector
              ? parsedVector
              : tokenEmbedding(doc.content);

          upsertVector.run(targetScopeKey, doc.chunkId, doc.contentHash, JSON.stringify(vector), EMBEDDING_VERSION, nowIso);
          upsertChunk.run(
            targetScopeKey,
            doc.chunkId,
            doc.docId,
            target.layer,
            target.projectKey,
            target.scopeId,
            target.spaceId,
            target.threadId,
            path,
            fileStat.mtimeMs,
            fileStat.size,
            doc.chunkIndex,
            doc.content,
            JSON.stringify(doc.sourceRefs),
            doc.recencyBoost,
            doc.contentHash,
            JSON.stringify(doc.metadataTokens),
            nowIso
          );
        }

        upsertFile.run(
          targetScopeKey,
          path,
          target.layer,
          target.projectKey,
          target.scopeId,
          target.spaceId,
          target.threadId,
          fileStat.mtimeMs,
          fileStat.size,
          nowIso
        );
      }
    }

    for (const row of indexedRows) {
      if (seenPaths.has(fileIdentity(row.scopeKey, row.filePath))) {
        continue;
      }
      deleteEmbeddingsByFile.run(row.scopeKey, row.scopeKey, row.filePath);
      deleteChunksByFile.run(row.scopeKey, row.filePath);
      deleteFileRow.run(row.scopeKey, row.filePath);
    }

    upsertRefreshState(db, key, startedAt, new Date().toISOString());
  } finally {
    db.close();
  }
}

function maybeStartBackgroundRefresh(repoPath: string, scope: NormalizedRetrievalScope, sqlitePath: string): void {
  const key = refreshJobKey(repoPath, scope, sqlitePath);
  if (refreshJobs.has(key)) {
    return;
  }
  const job = refreshMemoryIndexInternal(repoPath, scope, sqlitePath)
    .catch((error) => {
      console.error(
        `[retrieval.background_refresh.failed] key=${key} error=${error instanceof Error ? error.message : String(error)}`
      );
    })
    .finally(() => {
      refreshJobs.delete(key);
    });
  refreshJobs.set(key, job);
}

async function ensureFreshEnoughIndex(repoPath: string, scope: NormalizedRetrievalScope, sqlitePath: string): Promise<void> {
  const db = openRuntimeSqliteDatabase(sqlitePath);
  try {
    ensureRetrievalSchema(db);

    const key = scopeKey(scope);
    const state = db
      .prepare(
        'SELECT scope_key as scopeKey, last_refresh_completed_at as lastRefreshCompletedAt FROM retrieval_index_state WHERE scope_key = ?'
      )
      .get(key) as RetrievalIndexStateRow | undefined;
    const chunkCountRow = db
      .prepare(`SELECT COUNT(*) as count FROM retrieval_chunks WHERE ${selectScopeFilter('retrieval_chunks', !scope.spaceId)}`)
      .get(...scopeFilterArgs(scope)) as { count: number };

    if (!state || !state.lastRefreshCompletedAt || chunkCountRow.count === 0) {
      await refreshMemoryIndexInternal(repoPath, scope, sqlitePath);
      return;
    }

    const lastCompletedMs = Date.parse(state.lastRefreshCompletedAt);
    if (!Number.isFinite(lastCompletedMs) || Date.now() - lastCompletedMs > REFRESH_INTERVAL_MS) {
      maybeStartBackgroundRefresh(repoPath, scope, sqlitePath);
    }
  } finally {
    db.close();
  }
}

function loadIndexedDocs(db: DatabaseSync, scope: NormalizedRetrievalScope): CandidateDoc[] {
  const rows = db
    .prepare(
      `SELECT
          scope_key as scopeKey,
          doc_id as docId,
          chunk_id as chunkId,
          chunk_index as chunkIndex,
          content,
          source_refs as sourceRefs,
          recency_boost as recencyBoost,
          content_hash as contentHash,
          metadata_tokens as metadataTokens
        FROM retrieval_chunks
        WHERE ${selectScopeFilter('retrieval_chunks', !scope.spaceId)}`
    )
    .all(...scopeFilterArgs(scope)) as unknown as RetrievalChunkRow[];

  return rows.map((row) => ({
    scopeKey: row.scopeKey,
    docId: row.docId,
    chunkId: row.chunkId,
    chunkIndex: row.chunkIndex,
    content: row.content,
    sourceRefs: safeParseStringArray(row.sourceRefs),
    recencyBoost: row.recencyBoost,
    contentHash: row.contentHash,
    metadataTokens: safeParseStringArray(row.metadataTokens)
  }));
}

export function retrieveWithProvenance(query: string, docs: RetrievalDocument[]): RetrievalDocument[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  return docs.filter((doc) => doc.content.toLowerCase().includes(normalized));
}

export async function refreshMemoryIndex(repoPath: string, scope: RetrievalScope, sqlitePath: string): Promise<void> {
  const normalizedScope = normalizeScope(scope);
  const key = refreshJobKey(repoPath, normalizedScope, sqlitePath);
  const existing = refreshJobs.get(key);
  if (existing) {
    await existing;
    return;
  }

  const job = refreshMemoryIndexInternal(repoPath, normalizedScope, sqlitePath).finally(() => {
    refreshJobs.delete(key);
  });
  refreshJobs.set(key, job);
  await job;
}

export async function retrieveFromMemoryWithSQLite(
  query: string,
  repoPath: string,
  scope: RetrievalScope,
  sqlitePath: string,
  options: RetrievalOptions = {}
): Promise<HybridRetrievalDocument[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const normalizedScope = normalizeScope(scope);
  await ensureFreshEnoughIndex(repoPath, normalizedScope, sqlitePath);

  const db = openRuntimeSqliteDatabase(sqlitePath);
  try {
    ensureRetrievalSchema(db);

    const docs = loadIndexedDocs(db, normalizedScope);
    if (!docs.length) {
      return [];
    }

    const rows = db
      .prepare(
        `SELECT
           scope_key as scopeKey,
           chunk_id as chunkId,
           content_hash as contentHash,
           embedding,
           embedding_version as embeddingVersion
         FROM retrieval_embeddings
         WHERE (scope_key || char(0) || chunk_id) IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(docs.map((doc) => chunkIdentity(doc.scopeKey, doc.chunkId)))) as unknown as VectorRow[];
    const rowById = new Map(rows.map((row) => [chunkIdentity(row.scopeKey, row.chunkId), row]));

    const queryTokens = normalizeTokens(normalizedQuery);
    const queryEmbedding = tokenEmbedding(normalizedQuery);

    const rankedChunks = docs
      .map((doc) => {
        const existing = rowById.get(chunkIdentity(doc.scopeKey, doc.chunkId));
        const vector = existing?.embedding ? safeParseEmbedding(existing.embedding) ?? tokenEmbedding(doc.content) : tokenEmbedding(doc.content);
        const scores: StrategyScores = {
          symbolic: queryTokens.length
            ? queryTokens.filter((token) => doc.content.toLowerCase().includes(token)).length / queryTokens.length
            : 0,
          semantic: cosineSimilarity(queryEmbedding, vector),
          metadata: (() => {
            if (!queryTokens.length) {
              return 0;
            }
            const metadataTokenSet = new Set(doc.metadataTokens);
            const metadataHits = queryTokens.filter((token) => metadataTokenSet.has(token)).length;
            if (metadataHits === 0) {
              return 0;
            }
            let score = metadataHits / queryTokens.length;
            if (doc.docId.includes('/sessions/')) {
              score += 0.2;
            }
            score += doc.recencyBoost;
            return Math.min(1.2, score);
          })()
        };

        return { doc, scores };
      })
      .filter(({ scores }) => scores.symbolic > 0 || scores.semantic > 0 || scores.metadata > 0);

    const symbolicRanks = rankByScore(
      rankedChunks.map(({ doc, scores }) => ({ chunkId: doc.chunkId, scores })),
      'symbolic'
    );
    const semanticRanks = rankByScore(
      rankedChunks.map(({ doc, scores }) => ({ chunkId: doc.chunkId, scores })),
      'semantic'
    );
    const metadataRanks = rankByScore(
      rankedChunks.map(({ doc, scores }) => ({ chunkId: doc.chunkId, scores })),
      'metadata'
    );

    const maxResults = options.maxResults ?? 5;
    const merged = rankedChunks
      .map(({ doc, scores }) => {
        const retrievalScore =
          (symbolicRanks.has(doc.chunkId) ? 1 / (RRF_K + symbolicRanks.get(doc.chunkId)!) : 0) +
          (semanticRanks.has(doc.chunkId) ? 1 / (RRF_K + semanticRanks.get(doc.chunkId)!) : 0) +
          (metadataRanks.has(doc.chunkId) ? 1 / (RRF_K + metadataRanks.get(doc.chunkId)!) : 0);

        return {
          id: doc.docId,
          content: doc.content,
          sourceRefs: doc.sourceRefs,
          score: retrievalScore,
          retrievalScore,
          strategy: topStrategy(scores)
        };
      })
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.id.localeCompare(b.id);
      });

    const ranked = options.enableRerank ? rerankWithHeuristics(normalizedQuery, queryTokens, merged) : merged;
    return ranked
      .filter((doc) => doc.score >= 0.02)
      .slice(0, maxResults)
      .map(({ retrievalScore: _retrievalScore, ...doc }) => doc);
  } finally {
    db.close();
  }
}
