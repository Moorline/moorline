import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../packages/core/src/core/system/state/migrationRunner.js';
import { SqliteSessionStore } from '../../packages/core/src/core/system/state/sqliteSessionStore.js';
import { createTempRoot } from '../helpers/temp.js';

function createStore(): SqliteSessionStore {
  const root = createTempRoot('moorline-workflow-runs-');
  const sqlitePath = join(root, 'runtime.sqlite');
  runMigrations(sqlitePath, join(process.cwd(), 'packages', 'core', 'resources', 'migrations'));
  return new SqliteSessionStore(sqlitePath);
}

describe('workflow run storage', () => {
  it('persists and updates durable workflow runs', () => {
    const store = createStore();

    const created = store.upsertWorkflowRun({
      runId: 'run-1',
      packageId: 'rync/workflow-coder',
      workflowId: 'coding-workflow',
      status: 'queued',
      input: { idea: 'make it sturdy' },
      actor: { actorId: 'user-1', displayName: 'Ryan' },
      origin: { transportResourceId: 'resource-1', threadId: 'thread-1' },
      result: null,
      error: null,
      createdAt: '2026-06-23T00:00:00.000Z',
      updatedAt: '2026-06-23T00:00:00.000Z',
      completedAt: null
    });

    expect(created).toMatchObject({
      runId: 'run-1',
      packageId: 'rync/workflow-coder',
      workflowId: 'coding-workflow',
      status: 'queued',
      input: { idea: 'make it sturdy' },
      actor: { actorId: 'user-1', displayName: 'Ryan' },
      origin: { transportResourceId: 'resource-1', threadId: 'thread-1' }
    });

    store.upsertWorkflowRun({
      ...created,
      status: 'completed',
      result: { ok: true },
      updatedAt: '2026-06-23T00:01:00.000Z',
      completedAt: '2026-06-23T00:01:00.000Z'
    });

    expect(store.getWorkflowRun('run-1')).toMatchObject({
      status: 'completed',
      result: { ok: true },
      completedAt: '2026-06-23T00:01:00.000Z'
    });
    expect(store.listWorkflowRuns({ packageId: 'rync/workflow-coder' }).map((run) => run.runId)).toEqual(['run-1']);
  });
});
