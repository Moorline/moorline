import type { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type { RuntimeMessagePayload, RuntimeTransport } from '../../../types/transport.js';
import type { RuntimeSurfaceState } from '../../../types/config.js';

interface RuntimeTransportSurfaceServiceDeps {
  queue<T>(key: string, work: () => Promise<T>): Promise<T>;
  guard(): RuntimeActionGuard;
  transport(): RuntimeTransport;
  getNamespaceState(): RuntimeSurfaceState | null;
}

const TYPING_REFRESH_MS = 8_000;

export class RuntimeTransportSurfaceService {
  constructor(private readonly deps: RuntimeTransportSurfaceServiceDeps) {}

  startTypingLoop(actor: string, spaceId: string): () => void {
    const transport = this.deps.transport() as RuntimeTransport & {
      triggerTyping?(spaceId: string): Promise<void>;
    };
    if (typeof transport.triggerTyping === 'function') {
      let stopped = false;
      let interval: ReturnType<typeof globalThis.setInterval> | null = null;
      const trigger = async (): Promise<void> => {
        try {
          await this.deps.queue(spaceId, async () =>
            await this.deps.guard().run({
              action: 'transport.message.send',
              actor,
              target: `${spaceId}:typing`,
              execute: async () => {
                await transport.triggerTyping?.(spaceId);
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

    void this.setPresence(actor, spaceId, 'busy');
    return () => {
      void this.setPresence(actor, spaceId, 'online');
    };
  }

  async setPresence(actor: string, spaceId: string, status: 'online' | 'idle' | 'busy' | 'offline'): Promise<void> {
    const transport = this.deps.transport();
    if (!transport.capabilities().presence || !transport.setPresence) {
      return;
    }
    await this.deps.queue(spaceId, async () =>
      await this.deps.guard().run({
        action: 'transport.message.send',
        actor,
        target: `${spaceId}:presence`,
        execute: async () => {
          await transport.setPresence?.({
            spaceId: spaceId,
            status
          });
        }
      })
    );
  }

  async postMessage(actor: string, spaceId: string, payload: RuntimeMessagePayload): Promise<{ id: string }> {
    return await this.deps.queue(spaceId, async () =>
      await this.deps.guard().run({
        action: 'transport.message.send',
        actor,
        target: spaceId,
        execute: async () => {
          return await this.deps.transport().sendMessage({ spaceId: spaceId }, payload);
        }
      })
    );
  }

  async sendStatusUpdate(payload: RuntimeMessagePayload): Promise<void> {
    const namespace = this.deps.getNamespaceState();
    if (!namespace) {
      return;
    }
    await this.postMessage('runtime:status', namespace.statusChannelId, payload);
  }
}
