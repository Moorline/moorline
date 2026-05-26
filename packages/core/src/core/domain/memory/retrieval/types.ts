export interface HybridRetrievalDocument {
  id: string;
  content: string;
  sourceRefs: string[];
  score: number;
  strategy: 'symbolic' | 'semantic' | 'metadata';
}

export interface CandidateDoc {
  scopeKey: string;
  docId: string;
  chunkId: string;
  chunkIndex: number;
  content: string;
  sourceRefs: string[];
  recencyBoost: number;
  contentHash: string;
  metadataTokens: string[];
}

export interface StrategyScores {
  symbolic: number;
  semantic: number;
  metadata: number;
}

export interface VectorRow {
  scopeKey: string;
  chunkId: string;
  contentHash: string;
  embedding: string;
  embeddingVersion?: number;
}

export interface RetrievalChunkRow {
  scopeKey: string;
  docId: string;
  chunkId: string;
  chunkIndex: number;
  content: string;
  sourceRefs: string;
  recencyBoost: number;
  contentHash: string;
  metadataTokens: string;
}

export interface CachedEmbeddingChunkRow {
  scopeKey: string;
  chunkId: string;
  content: string;
  contentHash: string;
  embedding: string | null;
  embeddingVersion: number | null;
}

export interface RetrievalFileRow {
  scopeKey: string;
  filePath: string;
  fileMtimeMs: number;
  fileSize: number;
}

export interface RetrievalIndexStateRow {
  scopeKey: string;
  lastRefreshCompletedAt: string | null;
}

export interface IndexTarget {
  layer: 'project' | 'server' | 'session';
  rootPath: string;
  projectKey: string | null;
  scopeId: string | null;
  spaceId: string | null;
  threadId: string | null;
}

export interface RetrievalOptions {
  enableRerank?: boolean;
  maxResults?: number;
}

export interface RetrievalScope {
  scopeId: string;
  spaceId?: string;
  threadId?: string | null;
  projectKey?: string;
}

export interface RetrievalDocument {
  id: string;
  content: string;
  sourceRefs: string[];
}

export const VECTOR_DIMENSIONS = 96;
export const EMBEDDING_VERSION = 2;
export const CHUNK_TARGET_CHARS = 1200;
export const CHUNK_MAX_CHARS = 1800;
export const RRF_K = 60;
export const REFRESH_INTERVAL_MS = 30_000;
