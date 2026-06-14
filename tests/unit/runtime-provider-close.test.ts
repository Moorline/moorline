import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeIngestion } from '../../packages/core/src/core/runtime/execution/runtimeIngestion.js';
import {
  domainEventsFromProviderEvent,
  type RuntimeDomainEvent,
  type RuntimeReceiptRecord
} from '../../packages/core/src/core/runtime/execution/runtimeDomain.js';
import { runMigrations } from '../../packages/core/src/core/system/state/migrationRunner.js';
import { SqliteSessionStore } from '../../packages/core/src/core/system/state/sqliteSessionStore.js';
import type { ProviderRuntimeEvent } from '../../packages/core/src/types/runtime.js';
import { createTempRoot } from '../helpers/temp.js';

function createStore(): SqliteSessionStore {
  const root = createTempRoot('moorline-runtime-provider-close-');
  const sqlitePath = join(root, 'runtime.sqlite');
  runMigrations(sqlitePath, join(process.cwd(), 'packages', 'core', 'resources', 'migrations'));
  return new SqliteSessionStore(sqlitePath);
}

function event(type: RuntimeDomainEvent['type'], payload: RuntimeDomainEvent['payload'], createdAt: string): RuntimeDomainEvent {
  return {
    eventId: `${type}:${createdAt}`,
    threadId: 'thread-1',
    sessionId: 'session-1',
    transportResourceId: 'resource-1',
    type,
    payload,
    createdAt
  } as RuntimeDomainEvent;
}

function providerClosedEvent(createdAt: string): ProviderRuntimeEvent {
  return {
    eventId: `provider-close:${createdAt}`,
    threadId: 'thread-1',
    type: 'session.state.changed',
    payload: {
      state: 'closed',
      reason: 'closed'
    },
    createdAt
  };
}

function receipt(state: RuntimeReceiptRecord['state'], activeTurnId: string | null): RuntimeReceiptRecord {
  return {
    threadId: 'thread-1',
    sessionId: 'session-1',
    transportResourceId: 'resource-1',
    activeTurnId,
    state,
    waitReason: null,
    pendingRequestId: null,
    lastAssistantText: null,
    updatedAt: '2026-06-07T00:00:01.000Z'
  };
}

describe('provider close receipt projection', () => {
  it('does not downgrade a completed turn when the provider closes during shutdown', () => {
    const store = createStore();
    const ingestion = new RuntimeIngestion(store);

    ingestion.ingestDomainEvent(event('turn.started', { turnId: 'turn-1' }, '2026-06-07T00:00:00.000Z'));
    ingestion.ingestDomainEvent(event('turn.completed', { turnId: 'turn-1' }, '2026-06-07T00:00:01.000Z'));
    ingestion.ingestDomainEvent(event('runtime.idle', { state: 'completed' }, '2026-06-07T00:00:01.001Z'));
    ingestion.ingestDomainEvent(event('provider.closed', { message: 'closed' }, '2026-06-07T00:00:02.000Z'));

    expect(store.getRuntimeReceipt('thread-1')).toMatchObject({
      state: 'idle',
      activeTurnId: null,
      updatedAt: '2026-06-07T00:00:01.001Z'
    });
  });

  it('interrupts a running receipt when the provider closes mid-turn', () => {
    const store = createStore();
    const ingestion = new RuntimeIngestion(store);

    ingestion.ingestDomainEvent(event('turn.started', { turnId: 'turn-1' }, '2026-06-07T00:00:00.000Z'));
    ingestion.ingestDomainEvent(event('provider.closed', { message: 'closed' }, '2026-06-07T00:00:02.000Z'));

    expect(store.getRuntimeReceipt('thread-1')).toMatchObject({
      state: 'interrupted',
      activeTurnId: null,
      updatedAt: '2026-06-07T00:00:02.000Z'
    });
  });

  it('does not emit provider.closed domain events for quiesced receipts', () => {
    const events = domainEventsFromProviderEvent({
      event: providerClosedEvent('2026-06-07T00:00:02.000Z'),
      sessionId: 'session-1',
      transportResourceId: 'resource-1',
      runtimeMode: 'full-access',
      workspacePath: '/tmp/workspace',
      request: null,
      receipt: receipt('completed', null),
      activeTurnId: null
    });

    expect(events).toEqual([]);
  });

  it('emits provider.closed domain events for active receipts', () => {
    const events = domainEventsFromProviderEvent({
      event: providerClosedEvent('2026-06-07T00:00:02.000Z'),
      sessionId: 'session-1',
      transportResourceId: 'resource-1',
      runtimeMode: 'full-access',
      workspacePath: '/tmp/workspace',
      request: null,
      receipt: receipt('running', 'turn-1'),
      activeTurnId: 'turn-1'
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'provider.closed',
      payload: {
        message: 'closed'
      }
    });
  });
});
