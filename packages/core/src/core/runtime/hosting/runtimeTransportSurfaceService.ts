import type { RuntimeMessagePayload, RuntimeTransport } from '../../../types/transport.js';
import type { RuntimeSurfaceState } from '../../../types/config.js';
import type { RuntimeTransportEffectService } from './runtimeTransportEffectService.js';

interface RuntimeTransportSurfaceServiceDeps {
  transport(): RuntimeTransport;
  effects(): RuntimeTransportEffectService;
  getSurfaceState(): RuntimeSurfaceState | null;
}

export class RuntimeTransportSurfaceService {
  constructor(private readonly deps: RuntimeTransportSurfaceServiceDeps) {}

  startTypingLoop(actor: string, transportResourceId: string): () => void {
    void this.setPresence(actor, transportResourceId, 'busy');
    return () => {
      void this.setPresence(actor, transportResourceId, 'online');
    };
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
