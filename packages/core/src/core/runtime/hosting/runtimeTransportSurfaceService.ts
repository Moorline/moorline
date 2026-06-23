import { randomUUID } from 'node:crypto';
import type { RuntimeMessagePayload, RuntimeTransport } from '../../../types/transport.js';
import type { RuntimeSurfaceState } from '../../../types/config.js';
import type { RuntimeTransportEffectService } from './runtimeTransportEffectService.js';

interface RuntimeTransportSurfaceServiceDeps {
  transport(): RuntimeTransport;
  effects(): RuntimeTransportEffectService;
  getSurfaceState(): RuntimeSurfaceState | null;
}

const ACTIVITY_LEASE_MS = 15_000;
const ACTIVITY_REFRESH_INTERVAL_MS = 8_000;

export class RuntimeTransportSurfaceService {
  constructor(private readonly deps: RuntimeTransportSurfaceServiceDeps) {}

  startWorkActivity(actor: string, transportResourceId: string): () => void {
    const transport = this.deps.transport();
    if (!transport.capabilities().activity) {
      return () => {};
    }

    const activityId = randomUUID();
    const refreshActivity = () => {
      void this.setActivity(actor, transportResourceId, {
        activityId,
        kind: 'work',
        state: 'active',
        leaseMs: ACTIVITY_LEASE_MS
      }).catch(() => {});
    };

    refreshActivity();
    const interval = globalThis.setInterval(refreshActivity, ACTIVITY_REFRESH_INTERVAL_MS);
    return () => {
      globalThis.clearInterval(interval);
      void this.setActivity(actor, transportResourceId, {
        activityId,
        kind: 'work',
        state: 'inactive'
      }).catch(() => {});
    };
  }

  async setActivity(
    actor: string,
    transportResourceId: string,
    input: {
      activityId: string;
      kind: 'work';
      state: 'active' | 'inactive';
      leaseMs?: number;
      text?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    const transport = this.deps.transport();
    if (!transport.capabilities().activity) {
      return;
    }
    await this.deps.effects().setActivity(actor, {
      transportResourceId,
      ...input
    });
  }

  async setPresence(actor: string, transportResourceId: string, status: 'online' | 'idle' | 'busy' | 'offline'): Promise<void> {
    const transport = this.deps.transport();
    if (!transport.capabilities().presence) {
      return;
    }
    await this.deps.effects().setPresence(actor, {
      transportResourceId: transportResourceId,
      status
    });
  }

  async postMessage(actor: string, transportResourceId: string, payload: RuntimeMessagePayload): Promise<{ id: string }> {
    const receipt = await this.deps.effects().sendMessage(actor, { transportResourceId }, payload);
    return { id: receipt.nativeId ?? receipt.effectId };
  }

  async sendStatusUpdate(payload: RuntimeMessagePayload): Promise<void> {
    const surface = this.deps.getSurfaceState();
    if (!surface) {
      return;
    }
    await this.postMessage('runtime:status', surface.statusResourceId ?? surface.scopeId ?? surface.surfaceId, payload);
  }
}
