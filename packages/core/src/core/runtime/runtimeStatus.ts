import type { RuntimeSnapshotQuery } from '../system/projection/runtimeSnapshotQuery.js';

export interface MoorlineRuntimeStatus {
  uptimeSeconds: number;
  openSessions: number;
  coolSessions: number;
  archivedSessions: number;
  waitingSessions: number;
  runningSessions: number;
}

export function computeRuntimeStatus(input: {
  snapshots: RuntimeSnapshotQuery;
  startedAtIso: string | null;
  now: () => string;
}): MoorlineRuntimeStatus {
  const overview = input.snapshots.overview();
  const sessions = overview.sessions.map((entry) => entry.session).filter((session) => !session.sessionId.startsWith('coordination-'));
  const receipts = overview.receipts.filter((receipt) => receipt.sessionId && !receipt.sessionId.startsWith('coordination-'));
  const startedAtMs = input.startedAtIso ? Date.parse(input.startedAtIso) : Date.parse(input.now());
  const nowMs = Date.parse(input.now());
  return {
    uptimeSeconds: Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)),
    openSessions: sessions.filter((session) => session.lifecycleStatus !== 'archived').length,
    coolSessions: sessions.filter((session) => session.lifecycleStatus === 'cool').length,
    archivedSessions: sessions.filter((session) => session.lifecycleStatus === 'archived').length,
    waitingSessions: receipts.filter((receipt) => receipt.state === 'waiting_for_approval' || receipt.state === 'waiting_for_input').length,
    runningSessions: receipts.filter((receipt) => receipt.state === 'running').length
  };
}
