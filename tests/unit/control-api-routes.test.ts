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

  it('accepts session ids for managed session archive and delete routes', () => {
    expect(parseControlApiPostRoute('/api/work/session/archive', {
      sessionId: 'session-1'
    })).toMatchObject({
      path: '/api/work/session/archive',
      payload: {
        sessionId: 'session-1'
      }
    });

    expect(parseControlApiPostRoute('/api/work/session/delete', {
      sessionId: 'session-1'
    })).toMatchObject({
      path: '/api/work/session/delete',
      payload: {
        sessionId: 'session-1'
      }
    });
  });

  it('still rejects managed session archive and delete routes without a target', () => {
    expect(() => parseControlApiPostRoute('/api/work/session/archive', {})).toThrow(/Either sessionId or transportResourceId is required/);
    expect(() => parseControlApiPostRoute('/api/work/session/delete', {})).toThrow(/Either sessionId or transportResourceId is required/);
  });
});
