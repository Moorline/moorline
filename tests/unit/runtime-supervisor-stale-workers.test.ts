import { describe, expect, it } from 'vitest';
import { cleanupStaleRuntimeWorkers } from '../../packages/core/src/core/runtime/supervision/runtimeSupervisor.js';

describe('runtime stale worker cleanup', () => {
  it('terminates owned stale workers for the same config and excludes current workers', async () => {
    const signals: Array<{ pid: number; signal: string | number }> = [];
    const killed = await cleanupStaleRuntimeWorkers({
      configPath: '/tmp/moorline/config.json',
      excludePids: [200],
      waitMs: 0,
      findWorkers: async () => [
        { pid: 100, argv: ['node', 'moorline', 'worker-run', '--config', '/tmp/moorline/config.json'] },
        { pid: 200, argv: ['node', 'moorline', 'worker-run', '--config', '/tmp/moorline/config.json'] }
      ],
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
      },
      isProcessAlive: (pid) => pid === 100
    });

    expect(killed).toEqual([100]);
    expect(signals).toEqual([
      { pid: 100, signal: 'SIGTERM' },
      { pid: 100, signal: 'SIGKILL' }
    ]);
  });
});
