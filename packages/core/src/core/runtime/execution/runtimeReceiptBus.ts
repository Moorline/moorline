import { EventEmitter } from 'node:events';
import type { RuntimeReceiptRecord } from './runtimeDomain.js';
import { RuntimeReceiptStore } from '../../system/projection/runtimeReceiptStore.js';

interface RuntimeReceiptBusEvents {
  receipt: [receipt: RuntimeReceiptRecord];
  quiesced: [receipt: RuntimeReceiptRecord];
}

function isQuiesced(state: RuntimeReceiptRecord['state']): boolean {
  return state === 'idle' || state === 'completed' || state === 'failed' || state === 'interrupted' || state === 'cancelled';
}

export class RuntimeReceiptBus extends EventEmitter<RuntimeReceiptBusEvents> {
  constructor(private readonly store: RuntimeReceiptStore) {
    super();
  }

  publish(receipt: RuntimeReceiptRecord): void {
    this.store.upsert(receipt);
    this.emit('receipt', receipt);
    if (isQuiesced(receipt.state)) {
      this.emit('quiesced', receipt);
    }
  }

  current(threadId: string): RuntimeReceiptRecord | null {
    return this.store.get(threadId);
  }

  list(): RuntimeReceiptRecord[] {
    return this.store.list();
  }

  close(): void {
    this.removeAllListeners();
    this.store.close();
  }

  waitForQuiesced(threadId: string, timeoutMs = 30_000): Promise<RuntimeReceiptRecord> {
    const existing = this.store.get(threadId);
    if (existing && isQuiesced(existing.state)) {
      return Promise.resolve(existing);
    }

    return new Promise<RuntimeReceiptRecord>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.off('quiesced', onQuiesced);
        reject(new Error(`Timed out waiting for thread ${threadId} to quiesce.`));
      }, timeoutMs);

      const onQuiesced = (receipt: RuntimeReceiptRecord) => {
        if (receipt.threadId !== threadId) {
          return;
        }
        globalThis.clearTimeout(timer);
        this.off('quiesced', onQuiesced);
        resolve(receipt);
      };

      this.on('quiesced', onQuiesced);
    });
  }
}
