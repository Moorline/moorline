import type { RetrievalScope } from './types.js';
import { sanitizePathSegment } from '../pathSafety.js';

export interface NormalizedRetrievalScope {
  scopeId: string;
  transportResourceId: string | null;
  threadId: string | null;
  projectKey: string;
}

interface RetrievalStorageScope {
  layer: 'project' | 'server' | 'session';
  projectKey: string | null;
  scopeId: string | null;
  transportResourceId: string | null;
  threadId: string | null;
}

export function normalizeScope(scope: RetrievalScope): NormalizedRetrievalScope {
  const scopeId = sanitizePathSegment(scope.scopeId, 'scopeId');
  const transportResourceId = scope.transportResourceId ? sanitizePathSegment(scope.transportResourceId, 'transportResourceId') : null;
  const threadId = transportResourceId ? sanitizePathSegment(scope.threadId ?? 'root', 'threadId') : null;
  const projectKey = sanitizePathSegment(scope.projectKey ?? 'default', 'projectKey');
  return {
    scopeId,
    transportResourceId,
    threadId,
    projectKey
  };
}

export function scopeKey(scope: NormalizedRetrievalScope): string {
  return JSON.stringify(scope);
}

export function storageScopeKey(scope: RetrievalStorageScope): string {
  if (scope.layer === 'project') {
    return `project:${scope.projectKey ?? 'default'}`;
  }
  if (scope.layer === 'server') {
    return `server:${scope.scopeId ?? 'unknown'}`;
  }
  return `session:${scope.scopeId ?? 'unknown'}:${scope.transportResourceId ?? '*'}:${scope.threadId ?? '*'}`;
}

export function selectScopeFilter(alias: string, includeAllScopeSessions: boolean): string {
  return `(
    (${alias}.layer = 'project' AND ${alias}.project_key = ?)
    OR (${alias}.layer = 'server' AND ${alias}.scope_id = ?)
    OR (${alias}.layer = 'session' AND ${alias}.scope_id = ? AND ${
      includeAllScopeSessions ? '1 = 1' : `${alias}.transport_resource_id = ? AND ${alias}.thread_id = ?`
    })
  )`;
}

export function scopeFilterArgs(scope: NormalizedRetrievalScope): string[] {
  return !scope.transportResourceId
    ? [scope.projectKey, scope.scopeId, scope.scopeId]
    : [scope.projectKey, scope.scopeId, scope.scopeId, scope.transportResourceId, scope.threadId ?? 'root'];
}
