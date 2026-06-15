import { describe, expect, it } from 'vitest';
import { RuntimeControlService } from '../../packages/core/src/core/runtime/supervision/runtimeControlService.js';
import type { RuntimeSessionRow } from '../../packages/core/src/core/system/state/sqliteSessionStore.js';

function session(): RuntimeSessionRow {
  return {
    sessionId: 'session-1',
    scopeId: 'scope-1',
    transportResourceId: 'resource-1',
    threadId: 'session:session-1',
    transportResourceName: 'Session 1',
    workspacePath: '/tmp/session-1',
    runtimeMode: 'full-access',
    lifecycleStatus: 'hot',
    summary: null,
    provider: 'rync/pi',
    providerThreadId: null,
    providerStatus: 'closed',
    activeTurnId: null,
    providerAutoStartEnabled: false,
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    lastActivityAt: '2026-06-07T00:00:00.000Z',
    archivedAt: null,
    lastError: null,
    tags: []
  };
}

describe('RuntimeControlService provider start', () => {
  it('authorizes the requesting plugin actor but starts provider sessions as runtime control', async () => {
    const original = session();
    let current = original;
    const authorizedActorIds: string[] = [];
    const ensureActorIds: string[] = [];
    const service = new RuntimeControlService({
      authorize: async (input) => {
        authorizedActorIds.push(input.actorId);
      },
      appendAuditEvent() {},
      now: () => '2026-06-07T00:00:01.000Z',
      setAcceptingNewWork() {},
      setProviderAutoStartDefault() {},
      getSessionByThreadId: (threadId) => current.threadId === threadId ? current : null,
      listSessions: () => [current],
      upsertSession: (updated) => {
        current = updated;
      },
      updateSession: (updated) => {
        current = updated;
        return current;
      },
      stopProviderSession() {},
      stopAllProviders() {},
      drainProviders: async () => {},
      ensureProviderSession: async (_session, actorId) => {
        ensureActorIds.push(actorId);
      }
    });

    await service.requestStartProviderSessions({
      actorId: 'plugin:rync/admin-control',
      reason: 'test',
      requestedBy: {
        actorId: 'operator',
        displayName: 'Operator',
        isSurfaceAdmin: true
      }
    });

    expect(authorizedActorIds).toEqual(['plugin:rync/admin-control']);
    expect(ensureActorIds).toEqual(['runtime:provider/control']);
  });
});
