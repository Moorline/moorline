import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { retrieveFromMemoryWithSQLite } from './retrieval.js';
import { openRuntimeSqliteDatabase } from '../../system/state/sqlite/connection.js';
import { ensureRetrievalSchema } from './retrieval/schema.js';

interface MemoryStatus {
  scopeId: string;
  runtimeRoot: string;
  sqlitePath: string;
  files: {
    server: number;
    sessions: number;
    projects: number;
    total: number;
  };
  retrievalIndex: {
    chunks: number;
    embeddings: number;
  };
}

interface MemorySearchResult {
  id: string;
  content: string;
  sourceRefs: string[];
  strategy: 'symbolic' | 'semantic' | 'metadata';
  score: number;
}

function countMarkdownFiles(root: string): number {
  if (!existsSync(root)) {
    return 0;
  }
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    try {
      readdirSync(current, { withFileTypes: true }).forEach((entry) => {
        if (entry.isDirectory()) {
          stack.push(join(current, entry.name));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          count += 1;
        }
      });
    } catch {
      continue;
    }
  }
  return count;
}

function queryIndexCounts(sqlitePath: string): { chunks: number; embeddings: number } {
  if (!existsSync(sqlitePath)) {
    return { chunks: 0, embeddings: 0 };
  }
  const db = openRuntimeSqliteDatabase(sqlitePath);
  try {
    ensureRetrievalSchema(db);
    const chunks = (db.prepare('SELECT COUNT(*) as count FROM retrieval_chunks').get() as { count: number } | undefined)?.count ?? 0;
    const embeddings =
      (db.prepare('SELECT COUNT(*) as count FROM retrieval_embeddings').get() as { count: number } | undefined)?.count ?? 0;
    return { chunks, embeddings };
  } finally {
    db.close();
  }
}

export function getOperatorMemoryStatus(input: { runtimeRoot: string; sqlitePath: string; scopeId: string }): MemoryStatus {
  const scopeDir = `g${input.scopeId}`;
  const server = countMarkdownFiles(join(input.runtimeRoot, 'memory', 'server', scopeDir));
  const sessions = countMarkdownFiles(join(input.runtimeRoot, 'memory', 'sessions', scopeDir));
  const projects = countMarkdownFiles(join(input.runtimeRoot, 'memory', 'projects'));
  const index = queryIndexCounts(input.sqlitePath);
  return {
    scopeId: input.scopeId,
    runtimeRoot: input.runtimeRoot,
    sqlitePath: input.sqlitePath,
    files: {
      server,
      sessions,
      projects,
      total: server + sessions + projects
    },
    retrievalIndex: index
  };
}

export async function searchOperatorMemory(input: {
  runtimeRoot: string;
  sqlitePath: string;
  scopeId: string;
  query: string;
  maxResults?: number;
  enableRerank?: boolean;
}): Promise<MemorySearchResult[]> {
  const query = input.query.trim();
  if (!query) {
    throw new Error('memory search query is required.');
  }
  const docs = await retrieveFromMemoryWithSQLite(
    query,
    input.runtimeRoot,
    { scopeId: input.scopeId, projectKey: 'default' },
    input.sqlitePath,
    { maxResults: input.maxResults, enableRerank: input.enableRerank ?? true }
  );
  return docs.map((entry) => ({
    id: entry.id,
    content: entry.content,
    sourceRefs: [...entry.sourceRefs],
    strategy: entry.strategy,
    score: entry.score
  }));
}
