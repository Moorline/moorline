import { randomUUID } from 'node:crypto';
import type { RuntimeActivityRecord } from '../../system/projection/runtimeActivityStore.js';
import { KeyedDrainableWorker } from './drainableWorker.js';

interface WorkerQueueLimitDefaults {
  maxPendingPerKey: number;
  maxPendingTotal: number;
}

interface RuntimeWorkerQueueOverrides {
  provider?: {
    maxPendingPerKey?: number;
    maxPendingTotal?: number;
  };
  command?: {
    maxPendingPerKey?: number;
    maxPendingTotal?: number;
  };
  projection?: {
    maxPendingPerKey?: number;
    maxPendingTotal?: number;
  };
  transport?: {
    maxPendingPerKey?: number;
    maxPendingTotal?: number;
  };
}

interface RuntimeWorkerQueueCallbacks {
  now(): string;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  recordRuntimeActivity(input: Omit<RuntimeActivityRecord, 'activityId'>): void;
}

function resolveQueueLimits(
  override: { maxPendingPerKey?: number; maxPendingTotal?: number } | undefined,
  defaults: WorkerQueueLimitDefaults
): WorkerQueueLimitDefaults {
  const maxPendingPerKey =
    typeof override?.maxPendingPerKey === 'number' && Number.isFinite(override.maxPendingPerKey) && override.maxPendingPerKey > 0
      ? override.maxPendingPerKey
      : defaults.maxPendingPerKey;
  const maxPendingTotal =
    typeof override?.maxPendingTotal === 'number' && Number.isFinite(override.maxPendingTotal) && override.maxPendingTotal > 0
      ? override.maxPendingTotal
      : defaults.maxPendingTotal;
  return {
    maxPendingPerKey,
    maxPendingTotal
  };
}

export function createRuntimeWorkerQueues(
  overrides: RuntimeWorkerQueueOverrides | undefined,
  callbacks: RuntimeWorkerQueueCallbacks
): {
  providerQueue: KeyedDrainableWorker;
  commandQueue: KeyedDrainableWorker;
  projectionQueue: KeyedDrainableWorker;
  transportQueue: KeyedDrainableWorker;
  enqueueWithDiagnostics<T>(
    worker: KeyedDrainableWorker,
    key: string,
    source: string,
    work: () => Promise<T>
  ): Promise<T>;
} {
  const providerQueue = new KeyedDrainableWorker(
    'runtime.provider',
    resolveQueueLimits(overrides?.provider, { maxPendingPerKey: 512, maxPendingTotal: 8_192 })
  );
  const commandQueue = new KeyedDrainableWorker(
    'runtime.command',
    resolveQueueLimits(overrides?.command, { maxPendingPerKey: 256, maxPendingTotal: 4_096 })
  );
  const projectionQueue = new KeyedDrainableWorker(
    'runtime.projection',
    resolveQueueLimits(overrides?.projection, { maxPendingPerKey: 512, maxPendingTotal: 8_192 })
  );
  const transportQueue = new KeyedDrainableWorker(
    'runtime.transport',
    resolveQueueLimits(overrides?.transport, { maxPendingPerKey: 256, maxPendingTotal: 4_096 })
  );

  const enqueueWithDiagnostics = async <T>(
    worker: KeyedDrainableWorker,
    key: string,
    source: string,
    work: () => Promise<T>
  ): Promise<T> => {
    try {
      return await worker.push(key, work);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const queue = worker.getStats();
      callbacks.appendAuditEvent('runtime.queue.reject', {
        source,
        queue,
        key,
        error: message
      });
      callbacks.recordRuntimeActivity({
        threadId: key,
        sessionId: null,
        spaceId: null,
        sourceEventId: randomUUID(),
        kind: 'runtime.queue.reject',
        severity: 'warning',
        title: 'Runtime queue rejected work',
        detail: `${source} rejected queue item for key ${key}: ${message}`,
        createdAt: callbacks.now()
      });
      throw error;
    }
  };

  return {
    providerQueue,
    commandQueue,
    projectionQueue,
    transportQueue,
    enqueueWithDiagnostics
  };
}
