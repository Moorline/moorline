import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../packages/core/src/core/system/state/migrationRunner.js';
import { SqliteSessionStore } from '../../packages/core/src/core/system/state/sqliteSessionStore.js';
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
});
