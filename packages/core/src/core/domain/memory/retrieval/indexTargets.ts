import { resolveContainedPath } from '../pathSafety.js';
import type { IndexTarget } from './types.js';
import type { NormalizedRetrievalScope } from './scope.js';

export function buildIndexTargets(repoPath: string, scope: NormalizedRetrievalScope): IndexTarget[] {
  const targets: IndexTarget[] = [
    {
      layer: 'project',
      rootPath: resolveContainedPath(repoPath, ['memory', 'projects', scope.projectKey], 'Project retrieval root'),
      projectKey: scope.projectKey,
      scopeId: null,
      transportResourceId: null,
      threadId: null
    },
    {
      layer: 'server',
      rootPath: resolveContainedPath(repoPath, ['memory', 'server', `g${scope.scopeId}`], 'Server retrieval root'),
      projectKey: null,
      scopeId: scope.scopeId,
      transportResourceId: null,
      threadId: null
    }
  ];

  if (scope.transportResourceId) {
    targets.push({
      layer: 'session',
      rootPath: resolveContainedPath(
        repoPath,
        ['memory', 'sessions', `g${scope.scopeId}`, `c${scope.transportResourceId}`, scope.threadId ?? 'root'],
        'Session retrieval root'
      ),
      projectKey: null,
      scopeId: scope.scopeId,
      transportResourceId: scope.transportResourceId,
      threadId: scope.threadId ?? 'root'
    });
  } else {
    targets.push({
      layer: 'session',
      rootPath: resolveContainedPath(repoPath, ['memory', 'sessions', `g${scope.scopeId}`], 'Session retrieval root'),
      projectKey: null,
      scopeId: scope.scopeId,
      transportResourceId: null,
      threadId: null
    });
  }

  return targets;
}
