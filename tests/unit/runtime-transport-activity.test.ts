import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeTransportSurfaceService } from '../../packages/core/src/core/runtime/hosting/runtimeTransportSurfaceService.js';
import type { RuntimeTransport, RuntimeTransportActivityInput } from '../../packages/core/src/types/transport.js';

function transport(activity: boolean): RuntimeTransport {
  return {
    verifyAccess: async () => ({ scopeId: 'scope-1' }),
    start: async () => {},
    stop: async () => {},
    capabilities: () => ({
      nativeActions: false,
      resources: { list: false, create: false, update: false, delete: false },
      activity,
      presence: false
    }),
    applyEffect: async (effect) => ({
      effectId: effect.effectId,
      appliedAt: '2026-06-23T00:00:00.000Z'
    })
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('runtime transport activity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not emit activity effects when the transport does not support activity', async () => {
    const records: RuntimeTransportActivityInput[] = [];
    const service = new RuntimeTransportSurfaceService({
      transport: () => transport(false),
      effects: () =>
        ({
          setActivity: async (_actor: string, input: RuntimeTransportActivityInput) => {
            records.push(input);
            return { effectId: 'effect-1', appliedAt: '2026-06-23T00:00:00.000Z' };
          }
        }) as never,
      getSurfaceState: () => null
    });

    const stop = service.startWorkActivity('runtime:activity/test', 'resource-1');
    stop();
    await flushPromises();

    expect(records).toEqual([]);
  });

  it('emits leased active activity, refreshes it, and clears it on cleanup', async () => {
    vi.useFakeTimers();
    const records: RuntimeTransportActivityInput[] = [];
    const service = new RuntimeTransportSurfaceService({
      transport: () => transport(true),
      effects: () =>
        ({
          setActivity: async (_actor: string, input: RuntimeTransportActivityInput) => {
            records.push(input);
            return { effectId: `effect-${records.length}`, appliedAt: '2026-06-23T00:00:00.000Z' };
          }
        }) as never,
      getSurfaceState: () => null
    });

    const stop = service.startWorkActivity('runtime:activity/test', 'resource-1');
    await flushPromises();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      transportResourceId: 'resource-1',
      kind: 'work',
      state: 'active',
      leaseMs: 15_000
    });

    vi.advanceTimersByTime(8_000);
    await flushPromises();
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      transportResourceId: 'resource-1',
      activityId: records[0]?.activityId,
      kind: 'work',
      state: 'active',
      leaseMs: 15_000
    });

    stop();
    await flushPromises();
    expect(records).toHaveLength(3);
    expect(records[2]).toMatchObject({
      transportResourceId: 'resource-1',
      activityId: records[0]?.activityId,
      kind: 'work',
      state: 'inactive'
    });

    vi.advanceTimersByTime(8_000);
    await flushPromises();
    expect(records).toHaveLength(3);
  });
});
