import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../packages/core/src/core/system/state/migrationRunner.js';
import { SqliteSessionStore } from '../../packages/core/src/core/system/state/sqliteSessionStore.js';
import { RuntimeTransportIntentService } from '../../packages/core/src/core/runtime/hosting/runtimeTransportIntentService.js';
import type { RuntimeTransportIntent } from '../../packages/core/src/types/transport.js';
import { createTempRoot } from '../helpers/temp.js';

function createStore(): SqliteSessionStore {
  const root = createTempRoot('moorline-transport-intents-');
  const sqlitePath = join(root, 'runtime.sqlite');
  runMigrations(sqlitePath, join(process.cwd(), 'packages', 'core', 'resources', 'migrations'));
  return new SqliteSessionStore(sqlitePath);
}

function sessionEnsureIntent(overrides: Partial<Extract<RuntimeTransportIntent, { type: 'transport.session.ensure' }>> = {}): RuntimeTransportIntent {
  return {
    type: 'transport.session.ensure',
    intentId: 'intent-session-1',
    scopeId: 'scope-1',
    transportPackageId: 'test/transport',
    occurredAt: '2026-06-01T00:00:00.000Z',
    transportResourceId: 'resource-1',
    requestedName: 'work-channel',
    runtimeMode: 'full-access',
    ...overrides
  };
}

describe('transport intent storage', () => {
  it('persists pending intents and marks them processed', () => {
    const store = createStore();
    const intent = sessionEnsureIntent();

    expect(store.appendTransportIntent(intent)).toEqual({ inserted: true });
    expect(store.appendTransportIntent(intent)).toEqual({ inserted: false });
    expect(store.listPendingTransportIntents()).toEqual([intent]);

    store.markTransportIntentProcessed(intent.intentId, '2026-06-01T00:01:00.000Z');

    expect(store.listPendingTransportIntents()).toEqual([]);
  });

  it('rejects conflicting duplicate intent ids', () => {
    const store = createStore();
    const intent = sessionEnsureIntent();

    store.appendTransportIntent(intent);

    expect(() =>
      store.appendTransportIntent(sessionEnsureIntent({ requestedName: 'other-channel' }))
    ).toThrow(/Conflicting transport intent replay/u);
  });

  it('drains pending intents after restart', async () => {
    const store = createStore();
    const intent = sessionEnsureIntent();
    const bound: string[] = [];
    const service = new RuntimeTransportIntentService({
      config: {
        transport: {
          scopeId: 'scope-1'
        },
        defaults: {
          runtimeMode: 'approval-required'
        }
      },
      store,
      workManagement: {
        bindManagedSessionToTransportResource: async (input: { transportResourceId: string }) => {
          bound.push(input.transportResourceId);
          return {
            transportResourceId: input.transportResourceId
          };
        }
      },
      interactions: {
        handleTransportIntent: async () => undefined
      },
      now: () => '2026-06-01T00:01:00.000Z',
      appendAuditEvent: () => undefined
    } as never);

    store.appendTransportIntent(intent);

    await expect(service.drainPendingIntents()).resolves.toBe(1);

    expect(bound).toEqual(['resource-1']);
    expect(store.listPendingTransportIntents()).toEqual([]);
  });

  it('continues draining after a failed pending intent', async () => {
    const store = createStore();
    const bound: string[] = [];
    const failures: string[] = [];
    const service = new RuntimeTransportIntentService({
      config: {
        transport: {
          scopeId: 'scope-1'
        },
        defaults: {
          runtimeMode: 'approval-required'
        }
      },
      store,
      workManagement: {
        bindManagedSessionToTransportResource: async (input: { transportResourceId: string }) => {
          if (input.transportResourceId === 'bad-resource') {
            throw new Error('bad resource');
          }
          bound.push(input.transportResourceId);
          return {
            transportResourceId: input.transportResourceId
          };
        }
      },
      interactions: {
        handleTransportIntent: async () => undefined
      },
      now: () => '2026-06-01T00:01:00.000Z',
      appendAuditEvent: (event: string) => {
        failures.push(event);
      }
    } as never);

    store.appendTransportIntent(sessionEnsureIntent({ intentId: 'intent-bad', transportResourceId: 'bad-resource' }));
    store.appendTransportIntent(sessionEnsureIntent({ intentId: 'intent-good', transportResourceId: 'good-resource' }));

    await expect(service.drainPendingIntents()).resolves.toBe(2);

    expect(bound).toEqual(['good-resource']);
    expect(failures).toContain('transport.intent.failed');
    expect(store.listPendingTransportIntents()).toEqual([]);
  });

  it('emits initial session messages with a distinct intent id', async () => {
    const store = createStore();
    const seen: RuntimeTransportIntent[] = [];
    const service = new RuntimeTransportIntentService({
      config: {
        transport: {
          scopeId: 'scope-1'
        },
        defaults: {
          runtimeMode: 'approval-required'
        }
      },
      store,
      workManagement: {
        bindManagedSessionToTransportResource: async (input: { transportResourceId: string }) => ({
          transportResourceId: input.transportResourceId
        })
      },
      interactions: {
        handleTransportIntent: async (intent: RuntimeTransportIntent) => {
          seen.push(intent);
        }
      },
      now: () => '2026-06-01T00:01:00.000Z',
      appendAuditEvent: () => undefined
    } as never);

    await service.handleIntent(
      sessionEnsureIntent({
        initialMessage: { text: 'start here' },
        actor: { actorId: 'user-1' }
      })
    );

    expect(seen).toMatchObject([
      {
        type: 'transport.message.received',
        intentId: 'intent-session-1:initial-message',
        message: { text: 'start here' }
      }
    ]);
  });
});
