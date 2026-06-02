import type { RuntimeMessagePayload } from './transport.js';
import type { RuntimeSessionRow } from './plugin-runtime.js';

export interface RuntimeExternalResourceRef {
  provider: string;
  kind: string;
  id: string;
  url?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeExternalResourceRecord extends RuntimeExternalResourceRef {
  state?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type RuntimeWorkItemStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'dead_lettered';

export interface RuntimeWorkItemRecord {
  workItemId: string;
  packageId: string;
  queue: string;
  status: RuntimeWorkItemStatus;
  priority: number;
  idempotencyKey?: string;
  externalResource?: RuntimeExternalResourceRef;
  sessionId?: string;
  payload: Record<string, unknown>;
  phase?: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RuntimeGateRunRecord {
  gateRunId: string;
  gateId: string;
  packageId: string;
  workItemId?: string;
  sessionId?: string;
  command: string;
  args: string[];
  cwd?: string;
  required: boolean;
  status: 'running' | 'passed' | 'failed' | 'error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string | null;
}

export interface RuntimeHeadlessRunResult {
  session: RuntimeSessionRow;
  reply: RuntimeMessagePayload;
  parsedOutput?: unknown;
}
