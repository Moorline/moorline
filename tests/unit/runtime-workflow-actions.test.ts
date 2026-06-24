import { describe, expect, it } from 'vitest';
import { RuntimeInteractionService } from '../../packages/core/src/core/runtime/execution/runtimeInteractionService.js';
import type { RuntimeTransportIntent } from '../../packages/core/src/types/transport.js';

function workflowActionIntent(
  overrides: Partial<Extract<RuntimeTransportIntent, { type: 'transport.action.invoked' }>> = {}
): Extract<RuntimeTransportIntent, { type: 'transport.action.invoked' }> {
  return {
    type: 'transport.action.invoked',
    intentId: 'intent-workflow-1',
    scopeId: 'scope-1',
    transportPackageId: 'test/transport',
    occurredAt: '2026-06-23T00:00:00.000Z',
    transportResourceId: 'resource-1',
    actor: { actorId: 'user-1', displayName: 'User One' },
    actionId: 'coding-workflow',
    input: { idea: 'make slash workflows real' },
    ...overrides
  };
}

function createService(input: {
  transportResourceSession?: { sessionId: string; threadId: string } | null;
  startWorkflow?: (input: Record<string, unknown>) => Promise<{ runId: string; status: string }>;
  listWorkflows?: () => Array<Record<string, unknown>>;
  listActions?: () => Array<Record<string, unknown>>;
  handleTransportIntent?: () => Promise<Record<string, unknown>>;
}) {
  return new RuntimeInteractionService({
    config: {
      transport: { scopeId: 'scope-1' }
    },
    sessionRegistry: {
      getByTransportResourceId: () => input.transportResourceSession ?? null
    },
    sessionLifecycle: {},
    snapshots: {},
    getPluginHost: () => ({
      listActions:
        input.listActions ??
        (() => [
          {
            id: 'coding-workflow',
            title: 'Coding workflow',
            metadata: {
              workflow: {
                id: 'coding-workflow',
                packageId: 'rync/workflow-coder'
              }
            }
          }
        ]),
      handleTransportIntent: input.handleTransportIntent ?? (async () => ({ handled: false }))
    }),
    queue: async (_key: string, work: () => Promise<unknown>) => await work(),
    now: () => '2026-06-23T00:00:00.000Z',
    getSurfaceReady: () => true,
    getAcceptingNewWork: () => true,
    postTransportMessage: async () => undefined,
    appendAuditEvent: () => undefined,
    upsertExternalResource: () => undefined,
    createPluginContext: () => ({
      listWorkflows:
        input.listWorkflows ??
        (() => [
          {
            packageId: 'rync/workflow-coder',
            id: 'coding-workflow',
            title: 'Coding workflow',
            trigger: { sessionOnly: true }
          }
        ]),
      startWorkflow: input.startWorkflow ?? (async () => ({ runId: 'run-1', status: 'completed' }))
    }),
    isAdminActor: () => false,
    respondToProviderRequest: async () => undefined,
    resolvePendingRequest: async () => undefined
  } as never);
}

describe('runtime workflow actions', () => {
  it('starts a durable workflow run when a transport action maps to workflow metadata', async () => {
    const started: Record<string, unknown>[] = [];
    const replies: string[] = [];
    const service = createService({
      transportResourceSession: { sessionId: 'session-1', threadId: 'thread-1' },
      startWorkflow: async (input) => {
        started.push(input);
        return { runId: 'run-123', status: 'running' };
      },
      handleTransportIntent: async () => {
        throw new Error('legacy action path should not run');
      }
    });

    await service.handleTransportIntent(
      workflowActionIntent({
        native: {
          kind: 'discord.slash_command',
          payload: {
            reply: async (input: { content: string }) => {
              replies.push(input.content);
            }
          }
        }
      })
    );

    expect(started).toEqual([
      {
        packageId: 'rync/workflow-coder',
        workflowId: 'coding-workflow',
        input: { idea: 'make slash workflows real' },
        actor: { actorId: 'user-1', displayName: 'User One' },
        origin: {
          sourceEventId: 'intent-workflow-1',
          transportResourceId: 'resource-1',
          sessionId: 'session-1',
          threadId: 'thread-1'
        }
      }
    ]);
    expect(replies).toEqual(['Started workflow: Coding workflow (run-123).']);
  });

  it('rejects session-only workflow actions without a transport resource', async () => {
    const started: Record<string, unknown>[] = [];
    const replies: string[] = [];
    const service = createService({
      startWorkflow: async (input) => {
        started.push(input);
        return { runId: 'run-123', status: 'running' };
      }
    });

    await service.handleTransportIntent(
      workflowActionIntent({
        transportResourceId: undefined,
        native: {
          kind: 'discord.slash_command',
          payload: {
            reply: async (input: { content: string }) => {
              replies.push(input.content);
            }
          }
        }
      })
    );

    expect(started).toEqual([]);
    expect(replies).toEqual(['Coding workflow must be started from a session transport resource.']);
  });
});
