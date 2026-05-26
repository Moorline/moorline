import { existsSync } from 'node:fs';
import { runtimePaths } from '../../system/config/configStore.js';
import { SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import {
  ORCHESTRATION_STUCK_RUNNING_THRESHOLD_MS,
  summarizeOrchestrationQueueHealth,
  type RuntimeOrchestrationQueueHealth
} from './runtimeOrchestrationRequestService.js';

const ACTIVE_TURN_STUCK_THRESHOLD_MS = 5 * 60_000;

interface RuntimeActiveTurnHealth {
  activeTurns: number;
  staleActiveTurns: number;
  oldestActiveTurnAgeMs: number;
  staleActiveTurnThresholdMs: number;
}

interface RuntimeRetentionHealth {
  lastPrunedAt: string;
  policy: {
    runtimeEventTtlMs: number;
    domainEventTtlMs: number;
    resolvedRequestTtlMs: number;
    orchestrationTtlMs: number;
    imageTtlMs: number;
  };
  stats: {
    runtimeEventsDeleted: number;
    domainEventsDeleted: number;
    resolvedRequestsDeleted: number;
    closedOrchestrationRequestsDeleted: number;
    removedInputImageFiles: number;
    removedInputImageDirectories: number;
  };
}

interface RuntimeForcedDrainSignal {
  timeoutMs: number;
  inFlightRequestIds: string[];
  oldestInFlightAgeMs: number;
  at: string;
}

interface RuntimeOrchestrationHealthReport {
  available: boolean;
  healthy: boolean;
  detail: string;
  queue: RuntimeOrchestrationQueueHealth | null;
  turns: RuntimeActiveTurnHealth | null;
  retention: RuntimeRetentionHealth | null;
}

function ageMs(nowMs: number, iso: string): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, nowMs - parsed);
}

export function summarizeActiveTurnHealth(
  sessions: Array<{ activeTurnId: string | null; updatedAt: string }>,
  input: { nowMs?: number; staleActiveTurnThresholdMs?: number } = {}
): RuntimeActiveTurnHealth {
  const nowMs = input.nowMs ?? Date.now();
  const staleActiveTurnThresholdMs = input.staleActiveTurnThresholdMs ?? ACTIVE_TURN_STUCK_THRESHOLD_MS;
  let activeTurns = 0;
  let staleActiveTurns = 0;
  let oldestActiveTurnAgeMs = 0;

  for (const session of sessions) {
    if (!session.activeTurnId) {
      continue;
    }
    activeTurns += 1;
    const age = ageMs(nowMs, session.updatedAt);
    oldestActiveTurnAgeMs = Math.max(oldestActiveTurnAgeMs, age);
    if (age >= staleActiveTurnThresholdMs) {
      staleActiveTurns += 1;
    }
  }

  return {
    activeTurns,
    staleActiveTurns,
    oldestActiveTurnAgeMs,
    staleActiveTurnThresholdMs
  };
}

export function readRuntimeOrchestrationHealth(
  runtimeRoot: string,
  input: {
    staleRunningThresholdMs?: number;
    staleActiveTurnThresholdMs?: number;
  } = {}
): RuntimeOrchestrationHealthReport {
  const sqlitePath = runtimePaths(runtimeRoot).sqlitePath;
  const staleRunningThresholdMs = input.staleRunningThresholdMs ?? ORCHESTRATION_STUCK_RUNNING_THRESHOLD_MS;
  const staleActiveTurnThresholdMs = input.staleActiveTurnThresholdMs ?? ACTIVE_TURN_STUCK_THRESHOLD_MS;
  if (!existsSync(sqlitePath)) {
    return {
      available: false,
      healthy: true,
      detail: `Runtime state database not found at ${sqlitePath}.`,
      queue: null,
      turns: null,
      retention: null
    };
  }

  const store = new SqliteSessionStore(sqlitePath);
  try {
    const queue = summarizeOrchestrationQueueHealth(store.listOpenOrchestrationRequests(), {
      staleRunningThresholdMs
    });
    const turns = summarizeActiveTurnHealth(store.listSessions(), {
      staleActiveTurnThresholdMs
    });
    const retention = store.getMetadata<RuntimeRetentionHealth>('runtime.retention.last_prune');
    const forcedDrain = store.getMetadata<RuntimeForcedDrainSignal>('runtime.orchestration.last_forced_drain');
    const hasForcedDrainPressure = Boolean(forcedDrain && queue.runningRequests > 0);
    if (queue.staleRunningRequests > 0 || turns.staleActiveTurns > 0 || hasForcedDrainPressure) {
      const staleParts: string[] = [];
      if (hasForcedDrainPressure && forcedDrain) {
        staleParts.push(
          `forced drain recorded at ${forcedDrain.at} after ${forcedDrain.timeoutMs}ms with ${forcedDrain.inFlightRequestIds.length} in-flight request(s)`
        );
      }
      if (queue.staleRunningRequests > 0) {
        staleParts.push(
          `${queue.staleRunningRequests} orchestration request(s) exceeded ${staleRunningThresholdMs}ms`
        );
      }
      if (turns.staleActiveTurns > 0) {
        staleParts.push(`${turns.staleActiveTurns} active turn(s) exceeded ${staleActiveTurnThresholdMs}ms`);
      }
      return {
        available: true,
        healthy: false,
        detail: staleParts.join('; '),
        queue,
        turns,
        retention
      };
    }
    return {
      available: true,
      healthy: true,
      detail: `Runtime queue healthy (${queue.openRequests} open requests, ${turns.activeTurns} active turns).`,
      queue,
      turns,
      retention
    };
  } finally {
    store.close();
  }
}
