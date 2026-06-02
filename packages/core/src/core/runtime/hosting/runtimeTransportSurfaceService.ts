import type { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type { RuntimeMessagePayload, RuntimeTransport } from '../../../types/transport.js';
import type { RuntimeSurfaceState } from '../../../types/config.js';

interface RuntimeTransportSurfaceServiceDeps {
  queue<T>(key: string, work: () => Promise<T>): Promise<T>;
  guard(): RuntimeActionGuard;
  transport(): RuntimeTransport;
  getSurfaceState(): RuntimeSurfaceState | null;
}

const TYPING_REFRESH_MS = 8_000;

export class RuntimeTransportSurfaceService {
  constructor(private readonly deps: RuntimeTransportSurfaceServiceDeps) {}

  startTypingLoop(actor: string, transportResourceId: string): () => void {
    const transport = this.deps.transport() as RuntimeTransport & {
      triggerTyping?(transportResourceId: string): Promise<void>;
    };
    if (typeof transport.triggerTyping === 'function') {
      let stopped = false;
      let interval: ReturnType<typeof globalThis.setInterval> | null = null;
      const trigger = async (): Promise<void> => {
        try {
          await this.deps.queue(transportResourceId, async () =>
            await this.deps.guard().run({
              action: 'transport.message.send',
              actor,
              target: `${transportResourceId}:typing`,
              execute: async () => {
                await transport.triggerTyping?.(transportResourceId);
              }
            })
          );
        } catch {
          // Typing indicator failures are cosmetic.
        }
      };
      void trigger();
      interval = globalThis.setInterval(() => {
        if (stopped) {
          return;
        }
        void trigger();
      }, TYPING_REFRESH_MS);
      return () => {
        stopped = true;
        if (interval) {
          globalThis.clearInterval(interval);
          interval = null;
        }
      };
    }

    void this.setPresence(actor, transportResourceId, 'busy');
    return () => {
      void this.setPresence(actor, transportResourceId, 'online');
    };
  }

  async setPresence(actor: string, transportResourceId: string, status: 'online' | 'idle' | 'busy' | 'offline'): Promise<void> {
    const transport = this.deps.transport();
    if (!transport.capabilities().presence || !transport.setPresence) {
      return;
    }
    await this.deps.queue(transportResourceId, async () =>
      await this.deps.guard().run({
        action: 'transport.message.send',
        actor,
        target: `${transportResourceId}:presence`,
        execute: async () => {
          await transport.setPresence?.({
            transportResourceId: transportResourceId,
            status
          });
        }
      })
    );
  }

  async postMessage(actor: string, transportResourceId: string, payload: RuntimeMessagePayload): Promise<{ id: string }> {
    return await this.deps.queue(transportResourceId, async () =>
      await this.deps.guard().run({
        action: 'transport.message.send',
        actor,
        target: transportResourceId,
        execute: async () => {
          return await this.deps.transport().sendMessage({ transportResourceId: transportResourceId }, payload);
        }
      })
    );
  }

  async sendStatusUpdate(payload: RuntimeMessagePayload): Promise<void> {
    const surface = this.deps.getSurfaceState();
    if (!surface) {
      return;
    }
    await this.postMessage('runtime:status', surface.statusResourceId, payload);
  }
}
