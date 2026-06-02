import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePluginRuntimeContract } from '../../packages/core/src/core/extension/plugins/pluginManifest.js';
import { PluginHost } from '../../packages/core/src/core/extension/plugins/pluginHost.js';
import { runMigrations } from '../../packages/core/src/core/system/state/migrationRunner.js';
import { SqliteSessionStore } from '../../packages/core/src/core/system/state/sqliteSessionStore.js';
import type { RuntimeWorkItemRecord } from '../../packages/core/src/types/external.js';
import type { RuntimePlugin, RuntimePluginContext } from '../../packages/core/src/types/plugin.js';
import type { RuntimeTransportEvent } from '../../packages/core/src/types/transport.js';
import { createTempRoot } from '../helpers/temp.js';

function createStore(): SqliteSessionStore {
  const root = createTempRoot('moorline-external-work-spine-');
  const sqlitePath = join(root, 'runtime.sqlite');
  runMigrations(sqlitePath, join(process.cwd(), 'packages', 'core', 'resources', 'migrations'));
  return new SqliteSessionStore(sqlitePath);
}

function queuedWorkItem(input: Partial<RuntimeWorkItemRecord> & { workItemId: string; packageId?: string }): RuntimeWorkItemRecord {
  return {
    workItemId: input.workItemId,
    packageId: input.packageId ?? 'acme/external-worker',
    queue: input.queue ?? 'items',
    status: input.status ?? 'queued',
    priority: input.priority ?? 0,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.externalResource ? { externalResource: input.externalResource } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    payload: input.payload ?? {},
    ...(input.phase ? { phase: input.phase } : {}),
    attempts: input.attempts ?? 0,
    maxAttempts: input.maxAttempts ?? 3,
    runAfter: input.runAfter ?? null,
    leaseOwner: input.leaseOwner ?? null,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    lastError: input.lastError ?? null,
    createdAt: input.createdAt ?? '2026-06-01T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-06-01T00:00:00.000Z',
    completedAt: input.completedAt ?? null
  };
}

describe('external work spine storage', () => {
  it('upserts resources and enqueues work idempotently', () => {
    const store = createStore();
    const resource = store.upsertExternalResource({
      provider: 'external-system',
      kind: 'item',
      id: 'external:item:123',
      url: 'https://external.example/resources/123',
      title: 'Make work first class',
      metadata: { number: 123 },
      nowIso: '2026-06-01T00:00:00.000Z'
    });

    expect(resource).toMatchObject({
      provider: 'external-system',
      kind: 'item',
      id: 'external:item:123',
      title: 'Make work first class'
    });

    const first = store.enqueueWorkItem({
      workItemId: 'work-1',
      packageId: 'acme/external-worker',
      queue: 'items',
      status: 'queued',
      priority: 10,
      idempotencyKey: 'external:item:123',
      externalResource: resource,
      payload: { action: 'opened' },
      attempts: 0,
      maxAttempts: 2,
      runAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      completedAt: null
    });
    const second = store.enqueueWorkItem({
      ...first,
      workItemId: 'work-duplicate',
      payload: { action: 'edited' },
      updatedAt: '2026-06-01T00:01:00.000Z'
    });

    expect(second.workItemId).toBe(first.workItemId);
    expect(second.externalResource).toMatchObject({
      provider: 'external-system',
      kind: 'item',
      id: 'external:item:123'
    });
  });

  it('claims work with leases and reclaims expired running work', () => {
    const store = createStore();
    store.enqueueWorkItem(queuedWorkItem({ workItemId: 'work-lease' }));

    const claimed = store.claimWorkItem({
      packageId: 'acme/external-worker',
      queue: 'items',
      leaseOwner: 'worker-a',
      leaseExpiresAt: '2026-06-01T00:05:00.000Z',
      nowIso: '2026-06-01T00:00:00.000Z'
    });
    expect(claimed).toMatchObject({
      status: 'running',
      leaseOwner: 'worker-a',
      attempts: 1
    });

    expect(
      store.claimWorkItem({
        packageId: 'acme/external-worker',
        queue: 'items',
        leaseOwner: 'worker-b',
        leaseExpiresAt: '2026-06-01T00:06:00.000Z',
        nowIso: '2026-06-01T00:01:00.000Z'
      })
    ).toBeNull();

    const reclaimed = store.claimWorkItem({
      packageId: 'acme/external-worker',
      queue: 'items',
      leaseOwner: 'worker-b',
      leaseExpiresAt: '2026-06-01T00:10:00.000Z',
      nowIso: '2026-06-01T00:06:00.000Z'
    });
    expect(reclaimed).toMatchObject({
      leaseOwner: 'worker-b',
      attempts: 2
    });
  });

  it('claims by priority, skips future work, and isolates packages', () => {
    const store = createStore();
    store.enqueueWorkItem(queuedWorkItem({ workItemId: 'low', priority: 1 }));
    store.enqueueWorkItem(queuedWorkItem({ workItemId: 'future', priority: 100, runAfter: '2026-06-01T01:00:00.000Z' }));
    store.enqueueWorkItem(queuedWorkItem({ workItemId: 'high', priority: 50 }));
    store.enqueueWorkItem(queuedWorkItem({ workItemId: 'other-package', packageId: 'official/other-worker', priority: 999 }));

    const claimed = store.claimWorkItem({
      packageId: 'acme/external-worker',
      queue: 'items',
      leaseOwner: 'worker-a',
      leaseExpiresAt: '2026-06-01T00:05:00.000Z',
      nowIso: '2026-06-01T00:00:00.000Z'
    });
    expect(claimed?.workItemId).toBe('high');

    const other = store.claimWorkItem({
      packageId: 'official/other-worker',
      queue: 'items',
      leaseOwner: 'worker-b',
      leaseExpiresAt: '2026-06-01T00:05:00.000Z',
      nowIso: '2026-06-01T00:00:00.000Z'
    });
    expect(other?.workItemId).toBe('other-package');
  });

  it('binds sessions to external resources and records gate runs', () => {
    const store = createStore();
    store.upsertSession({
      sessionId: 'session-1',
      scopeId: 'runtime',
      transportResourceId: 'resource-1',
      threadId: 'thread-1',
      transportResourceName: 'Item 123',
      workspacePath: '/tmp/session-1',
      runtimeMode: 'full-access',
      lifecycleStatus: 'hot',
      summary: null,
      provider: 'default',
      providerThreadId: null,
      resumeThreadId: null,
      providerStatus: 'ready',
      activeTurnId: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      lastActivityAt: '2026-06-01T00:00:00.000Z',
      archivedAt: null,
      lastError: null,
      tags: []
    });
    const resource = { provider: 'external-system', kind: 'item', id: 'external:item:123' };
    store.upsertExternalResource({ ...resource, nowIso: '2026-06-01T00:00:00.000Z' });
    store.bindSessionToExternalResource({
      sessionId: 'session-1',
      resource,
      relationship: 'source',
      nowIso: '2026-06-01T00:00:00.000Z'
    });

    expect(store.listSessionIdsForExternalResource(resource)).toEqual(['session-1']);
    expect(store.listExternalResourcesForSession('session-1')).toHaveLength(1);

    const gate = store.upsertGateRun({
      gateRunId: 'gate-1',
      gateId: 'lint',
      packageId: 'acme/external-worker',
      sessionId: 'session-1',
      command: 'bun',
      args: ['run', 'lint'],
      required: true,
      status: 'passed',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      startedAt: '2026-06-01T00:00:00.000Z',
      completedAt: '2026-06-01T00:00:02.000Z'
    });
    expect(gate).toMatchObject({
      status: 'passed',
      required: true,
      args: ['run', 'lint']
    });
  });
});

describe('external event plugin dispatch', () => {
  it('dispatches external transport events to the dedicated hook', async () => {
    const seen: RuntimeTransportEvent[] = [];
    const plugin: RuntimePlugin = {
      id: 'acme/external-worker',
      manifest: {
        id: 'acme/external-worker',
        name: 'External Worker',
        version: '1.0.0',
        type: 'plugin',
        capabilities: ['package.work.manage'],
        hooks: ['onExternalEvent']
      },
      onExternalEvent(event) {
        seen.push(event);
        return { handled: true };
      }
    };

    const host = new PluginHost([plugin]);
    const result = await host.handleTransportEvent(
      {
        type: 'external.event.received',
        scopeId: 'runtime',
        source: 'external-system',
        eventName: 'item.opened',
        receivedAt: '2026-06-01T00:00:00.000Z',
        resource: {
          provider: 'external-system',
          kind: 'item',
          id: 'external:item:123'
        },
        payload: { action: 'opened' },
        idempotencyKey: 'external:item:123'
      },
      () => ({}) as RuntimePluginContext
    );

    expect(result.handled).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'external.event.received',
      eventName: 'item.opened'
    });
  });

  it('dispatches dedicated external hooks even when a transport hook handles first', async () => {
    const seen: string[] = [];
    const transportPlugin: RuntimePlugin = {
      id: 'official/observer',
      manifest: {
        id: 'official/observer',
        name: 'Observer',
        version: '1.0.0',
        type: 'plugin',
        capabilities: ['package.work.manage'],
        hooks: ['onTransportEvent']
      },
      onTransportEvent() {
        seen.push('transport');
        return { handled: true };
      }
    };
    const externalPlugin: RuntimePlugin = {
      id: 'acme/external-worker',
      manifest: {
        id: 'acme/external-worker',
        name: 'External Worker',
        version: '1.0.0',
        type: 'plugin',
        capabilities: ['package.work.manage'],
        hooks: ['onExternalEvent']
      },
      onExternalEvent() {
        seen.push('external');
        return { handled: true };
      }
    };

    const host = new PluginHost([transportPlugin, externalPlugin]);
    await host.handleTransportEvent(
      {
        type: 'external.event.received',
        scopeId: 'runtime',
        source: 'external-system',
        eventName: 'item.opened',
        receivedAt: '2026-06-01T00:00:00.000Z',
        payload: {}
      },
      () => ({}) as RuntimePluginContext
    );

    expect(seen).toEqual(['transport', 'external']);
  });
});

describe('external event plugin contract validation', () => {
  it('requires onExternalEvent to be declared and implemented consistently', () => {
    const valid: RuntimePlugin = {
      id: 'acme/external-worker',
      manifest: {
        id: 'acme/external-worker',
        name: 'External Worker',
        version: '1.0.0',
        type: 'plugin',
        capabilities: ['package.work.manage'],
        hooks: ['onExternalEvent']
      },
      onExternalEvent() {}
    };
    expect(() => validatePluginRuntimeContract(valid)).not.toThrow();

    expect(() =>
      validatePluginRuntimeContract({
        ...valid,
        manifest: {
          ...valid.manifest,
          hooks: []
        }
      })
    ).toThrow(/undeclared hook onExternalEvent/);

    expect(() =>
      validatePluginRuntimeContract({
        id: 'acme/external-worker',
        manifest: valid.manifest
      })
    ).toThrow(/declares hook onExternalEvent but does not implement it/);
  });
});
