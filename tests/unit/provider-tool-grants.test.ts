import { describe, expect, it } from 'vitest';
import { RuntimePluginContextService } from '../../packages/core/src/core/runtime/execution/runtimePluginContextService.js';

function createService(input: {
  runGuardedAction?: (input: { action: string; actor: string; execute: () => Promise<unknown> }) => Promise<unknown>;
  appendAuditEvent?: (event: string, payload: Record<string, unknown>) => void;
} = {}) {
  const service = new RuntimePluginContextService({
    config: {
      runtimeRoot: '/tmp/moorline-test',
      transport: { kind: 'test', packageId: 'test/transport', scopeId: 'scope', config: {} },
      provider: { kind: 'test', packageId: 'test/provider', config: {} },
      defaults: { runtimeMode: 'approval-required', model: 'provider-default' },
      surface: 'discord',
      main: { processMode: 'foreground' }
    },
    providerToolPolicy: {
      workspace: { nativePreset: 'provider-default' },
      ephemeral: { nativePreset: 'none', grants: ['core.moorline_session'] }
    },
    runtimeRoot: '/tmp/moorline-test',
    homeRoot: '/tmp/moorline-test/home',
    sqlitePath: '/tmp/moorline-test/runtime.sqlite',
    coordinationWorkspacePath: '/tmp/moorline-test/coordination',
    store: {},
    sessionRegistry: {},
    skillRegistry: { list: () => [] },
    memoryStore: {},
    activities: {},
    projectionState: {},
    snapshots: {
      querySessions: () => [],
      getSessionById: () => null,
      getSessionByTransportResourceId: () => null,
      listSessions: () => []
    },
    providerService: {},
    canonicalEvents: {},
    workManagement: {},
    runtimeControl: {},
    sidecars: {},
    providerOrchestrator: {},
    getPluginHost: () => ({
      listTools: () => [
        {
          pluginId: 'rync/persona',
          name: 'edit_soul',
          description: 'Edit SOUL',
          requiredCapability: 'fs.write',
          inputSchema: { type: 'object' },
          execute: async () => ({ content: 'edited' })
        }
      ]
    }),
    getAdminConfig: () => ({ accessGroupIds: [], userIds: [], allowTransportAdmin: false }),
    isAdminActor: () => false,
    requireSurfaceState: () => ({ coordinationResourceId: 'coord', statusResourceId: 'status' }),
    getSurfaceState: () => ({ coordinationResourceId: 'coord', statusResourceId: 'status' }),
    getRuntimeStatus: () => ({ uptimeSeconds: 0, openSessions: 0, coolSessions: 0, archivedSessions: 0, waitingSessions: 0, runningSessions: 0 }),
    getRuntimeControlStatus: () => ({ acceptingNewWork: true, providerAutoStartDefault: true }),
    ensureCoordinationSession: async () => {
      throw new Error('not used');
    },
    prepareProviderImages: async () => undefined,
    normalizeReply: (text: string) => text,
    postTransportMessage: async () => {},
    appendAuditEvent: input.appendAuditEvent ?? (() => {}),
    recordRuntimeActivity: () => {},
    now: () => '2026-06-14T00:00:00.000Z',
    runGuardedAction: async (actionInput: { action: string; actor: string; execute: () => Promise<unknown> }) =>
      input.runGuardedAction ? await input.runGuardedAction(actionInput) : await actionInput.execute(),
    resolvePendingRequest: async () => {},
    answerPendingRequest: async () => {},
    drainRuntimeWork: async () => {}
  } as never);
  (service as unknown as { createContext: (actorId: string) => { actorId: string } }).createContext = (actorId: string) => ({ actorId });
  return service as unknown as {
    resolveProviderTools(agentKind: 'workspace' | 'ephemeral', grantIds: string[]): Array<{ id: string; name: string }>;
    createProviderToolExecutor(tools: Array<{ id: string; name: string }>): {
      executeProviderTool(input: { threadId: string; toolId: string; arguments: Record<string, unknown>; actor: string }): Promise<{ content: string }>;
    };
  };
}

describe('provider tool grants', () => {
  it('exposes Moorline provider tools only through grants', () => {
    const service = createService();

    expect(service.resolveProviderTools('workspace', []).map((tool) => tool.id)).toEqual([]);
    expect(service.resolveProviderTools('ephemeral', []).map((tool) => tool.id)).toEqual(['core.moorline_session']);
    expect(service.resolveProviderTools('workspace', ['plugin:rync/persona.edit_soul']).map((tool) => tool.id)).toEqual([
      'plugin:rync/persona.edit_soul'
    ]);
  });

  it('enforces session-control capabilities and audits provider tool execution', async () => {
    const guarded: string[] = [];
    const audits: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const service = createService({
      runGuardedAction: async (input) => {
        guarded.push(input.action);
        return await input.execute();
      },
      appendAuditEvent: (event, payload) => audits.push({ event, payload })
    });
    const tools = service.resolveProviderTools('ephemeral', []);
    const executor = service.createProviderToolExecutor(tools);

    const result = await executor.executeProviderTool({
      threadId: 'thread-1',
      toolId: 'core.moorline_session',
      arguments: { action: 'query' },
      actor: 'provider:test/provider'
    });

    expect(result.content).toBe('No sessions matched.');
    expect(guarded).toEqual(['session.inspect']);
    expect(audits).toEqual([
      {
        event: 'provider.tool.executed',
        payload: {
          actor: 'provider:test/provider',
          toolId: 'core.moorline_session',
          ownerPackageId: 'core',
          ok: true
        }
      }
    ]);
  });
});
