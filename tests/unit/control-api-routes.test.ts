import { describe, expect, it } from 'vitest';
import { parseControlApiPostRoute, type ControlApiPayloadForPath } from '../../packages/control-api/src/contracts/routes.js';

describe('Control API route contract', () => {
  it('includes main lifecycle, shutdown, and lease routes used by CLI clients', () => {
    expect(parseControlApiPostRoute('/api/main/start', {})).toMatchObject({
      path: '/api/main/start',
      payload: {}
    });
    expect(parseControlApiPostRoute('/api/shutdown', {})).toMatchObject({
      path: '/api/shutdown',
      payload: {}
    });
    expect(parseControlApiPostRoute('/api/leases/create', {
      client: 'cli',
      policy: 'stop_on_last_lease',
      ttlMs: 30_000
    })).toMatchObject({
      path: '/api/leases/create',
      payload: {
        client: 'cli',
        policy: 'stop_on_last_lease',
        ttlMs: 30_000
      }
    });

    const heartbeat: ControlApiPayloadForPath<'/api/leases/heartbeat'> = {
      leaseId: 'lease-1',
      ttlMs: 30_000
    };
    expect(parseControlApiPostRoute('/api/leases/heartbeat', heartbeat)).toMatchObject({
      path: '/api/leases/heartbeat',
      payload: heartbeat
    });
  });
});
