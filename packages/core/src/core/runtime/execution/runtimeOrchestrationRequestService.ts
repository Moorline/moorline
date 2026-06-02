import { randomUUID } from 'node:crypto';
import type { RuntimePluginContext } from '../../../types/plugin.js';
import type {
  AnswerPendingRequestOrchestrationPayload,
  ArchiveSessionOrchestrationPayload,
  CreateSessionOrchestrationPayload,
  DeleteSessionOrchestrationPayload,
  DirectSessionOrchestrationPayload,
  ProviderSessionControlOrchestrationPayload,
  ProviderTestOrchestrationPayload,
  PostMessageOrchestrationPayload,
  RuntimeReloadOrchestrationPayload,
  RuntimeSetAcceptingOrchestrationPayload,
  ResolvePendingRequestOrchestrationPayload
} from './runtimeOrchestrationRequests.js';
import { decodeOrchestrationPayload } from './runtimeOrchestrationRequests.js';
import type { RuntimeAttachmentPayload, RuntimeMessagePayload } from '../../../types/transport.js';
import type { RuntimeOrchestrationRequestRow, SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import type { RuntimeWorkManagementService } from '../../domain/sessions/runtimeWorkManagementService.js';

const ORCHESTRATION_POLL_MS = 250;
export const ORCHESTRATION_STUCK_RUNNING_THRESHOLD_MS = 5 * 60_000;
const ORCHESTRATION_DRAIN_WAIT_TIMEOUT_MS = 30_000;
const ORCHESTRATION_REPLAY_SAFETY_BLOCK_ERROR =
  '[ORCH_REPLAY_SAFETY_BLOCK] Found an abandoned running orchestration request after restart. ' +
  'The request was marked failed to avoid replaying non-idempotent side effects.';
const CLI_RUNTIME_CONTROL_REQUESTED_BY = {
  actorId: 'cli:runtime-control',
  accessGroupIds: [],
  isSurfaceAdmin: false
};
const CLI_RUNTIME_CONTROL_REASON = 'Moorline CLI runtime control request';

interface ForcedDrainSignal {
  timeoutMs: number;
  inFlightRequestIds: string[];
  oldestInFlightAgeMs: number;
  at: string;
}

export interface RuntimeOrchestrationQueueHealth {
  openRequests: number;
  runningRequests: number;
  pendingRequests: number;
  staleRunningRequests: number;
  oldestOpenAgeMs: number;
  oldestRunningAgeMs: number;
  inFlightRequests: number;
  staleRunningThresholdMs: number;
}

function ageMs(nowMs: number, iso: string): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, nowMs - parsed);
}

export function summarizeOrchestrationQueueHealth(
  requests: RuntimeOrchestrationRequestRow[],
  input: { nowMs?: number; staleRunningThresholdMs?: number; inFlightRequests?: number } = {}
): RuntimeOrchestrationQueueHealth {
  const nowMs = input.nowMs ?? Date.now();
  const staleRunningThresholdMs = input.staleRunningThresholdMs ?? ORCHESTRATION_STUCK_RUNNING_THRESHOLD_MS;
  let oldestOpenAgeMs = 0;
  let oldestRunningAgeMs = 0;
  let runningRequests = 0;
  let pendingRequests = 0;
  let staleRunningRequests = 0;

  for (const request of requests) {
    const age = ageMs(nowMs, request.updatedAt);
    oldestOpenAgeMs = Math.max(oldestOpenAgeMs, age);
    if (request.status === 'running') {
      runningRequests += 1;
      oldestRunningAgeMs = Math.max(oldestRunningAgeMs, age);
      if (age >= staleRunningThresholdMs) {
        staleRunningRequests += 1;
      }
      continue;
    }
    if (request.status === 'pending') {
      pendingRequests += 1;
    }
  }

  return {
    openRequests: requests.length,
    runningRequests,
    pendingRequests,
    staleRunningRequests,
    oldestOpenAgeMs,
    oldestRunningAgeMs,
    inFlightRequests: input.inFlightRequests ?? 0,
    staleRunningThresholdMs
  };
}

interface RuntimeOrchestrationRequestServiceDeps {
  store: SqliteSessionStore;
  workManagement: RuntimeWorkManagementService;
  createPluginContext(actorId: string): RuntimePluginContext;
  now(): string;
  validateLocalFiles(
    files: RuntimeAttachmentPayload[] | undefined,
    input: { requestedByThreadId: string | null }
  ): void;
  postTransportMessage(actor: string, transportResourceId: string, payload: RuntimeMessagePayload): Promise<{ id: string }>;
  nowMs?(): number;
  drainWaitTimeoutMs?: number;
  onForcedDrain?(signal: ForcedDrainSignal): void;
}

export class RuntimeOrchestrationRequestService {
  private poller: ReturnType<typeof globalThis.setInterval> | null = null;
  private draining = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly inFlightStartedAt = new Map<string, number>();
  private readonly executionOwner = randomUUID();
  private abandonedRunningRecovered = false;

  constructor(private readonly deps: RuntimeOrchestrationRequestServiceDeps) {}

  start(): void {
    this.stop();
    this.poller = setInterval(() => {
      void this.drain(false);
    }, ORCHESTRATION_POLL_MS);
  }

  stop(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  async drain(waitForCompletion = true): Promise<void> {
    if (this.draining) {
      if (waitForCompletion) {
        await this.waitForInFlight();
      }
      return;
    }
    this.draining = true;
    try {
      if (!this.abandonedRunningRecovered) {
        this.recoverAbandonedRunningRequests();
        this.abandonedRunningRecovered = true;
      }
      for (const request of this.deps.store.listOpenOrchestrationRequests()) {
        if (this.inFlight.has(request.requestId)) {
          continue;
        }
        const claimed = this.deps.store.claimPendingOrchestrationRequest({
          requestId: request.requestId,
          executionOwner: this.executionOwner,
          nowIso: this.deps.now()
        });
        if (!claimed) {
          continue;
        }
        const inFlight = this.process(claimed).finally(() => {
          this.inFlight.delete(request.requestId);
          this.inFlightStartedAt.delete(request.requestId);
        });
        this.inFlight.set(request.requestId, inFlight);
        this.inFlightStartedAt.set(request.requestId, this.nowMs());
      }
    } finally {
      this.draining = false;
    }
    if (waitForCompletion) {
      await this.waitForInFlight();
    }
  }

  getQueueHealth(input: { staleRunningThresholdMs?: number } = {}): RuntimeOrchestrationQueueHealth {
    return summarizeOrchestrationQueueHealth(this.deps.store.listOpenOrchestrationRequests(), {
      staleRunningThresholdMs: input.staleRunningThresholdMs,
      inFlightRequests: this.inFlight.size
    });
  }

  private async process(request: RuntimeOrchestrationRequestRow): Promise<void> {
    const executionToken = `${this.executionOwner}:${request.requestId}:${request.executionAttempt}`;

    try {
      const result = await this.executeRequest(request, executionToken);
      this.deps.store.upsertOrchestrationRequest({
        ...request,
        status: 'completed',
        resultJson: JSON.stringify(result),
        error: null,
        completionToken: executionToken,
        completedAt: this.deps.now(),
        updatedAt: this.deps.now()
      });
    } catch (error) {
      this.deps.store.upsertOrchestrationRequest({
        ...request,
        status: 'failed',
        resultJson: null,
        error: error instanceof Error ? error.message : String(error),
        completionToken: null,
        completedAt: this.deps.now(),
        updatedAt: this.deps.now()
      });
    }
  }

  private async executeRequest(request: RuntimeOrchestrationRequestRow, executionToken: string): Promise<unknown> {
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(request.payloadJson) as unknown;
    } catch {
      throw new Error(`[ORCH_PAYLOAD_JSON_INVALID] orchestration payload for ${request.type} is not valid JSON.`);
    }
    switch (request.type) {
      case 'create_session':
        return await this.deps.workManagement.createManagedSession({
          actorId: request.actorId,
          ...(decodeOrchestrationPayload('create_session', parsedPayload) as CreateSessionOrchestrationPayload)
        });
      case 'direct_session':
        return await this.deps.workManagement.directManagedSession({
          actorId: request.actorId,
          ...(decodeOrchestrationPayload('direct_session', parsedPayload) as DirectSessionOrchestrationPayload)
        });
      case 'archive_session':
        return await this.deps.workManagement.archiveManagedSession({
          actorId: request.actorId,
          ...(decodeOrchestrationPayload('archive_session', parsedPayload) as ArchiveSessionOrchestrationPayload)
        });
      case 'delete_session':
        return await this.deps.workManagement.deleteManagedSession({
          actorId: request.actorId,
          ...(decodeOrchestrationPayload('delete_session', parsedPayload) as DeleteSessionOrchestrationPayload)
        });
      case 'post_message': {
        const payload = decodeOrchestrationPayload('post_message', parsedPayload) as PostMessageOrchestrationPayload;
        const attachments = payload.files?.map((file) => ({
          kind: 'file' as const,
          path: file.path,
          ...(file.name ? { name: file.name } : {}),
          ...(file.description ? { description: file.description } : {})
        }));
        this.deps.validateLocalFiles(attachments, {
          requestedByThreadId: request.requestedByThreadId
        });
        return await this.deps.postTransportMessage(request.actorId, payload.transportResourceId, {
          ...(payload.content ? { text: payload.content } : {}),
          ...(attachments ? { attachments } : {}),
          metadata: {
            orchestrationRequestId: request.requestId,
            orchestrationExecutionToken: executionToken
          }
        });
      }
      case 'runtime_set_accepting': {
        const payload = decodeOrchestrationPayload(
          'runtime_set_accepting',
          parsedPayload
        ) as RuntimeSetAcceptingOrchestrationPayload;
        await this.deps.createPluginContext(request.actorId).setRuntimeAcceptingNewWork({
          accepting: payload.accepting,
          reason: CLI_RUNTIME_CONTROL_REASON,
          requestedBy: CLI_RUNTIME_CONTROL_REQUESTED_BY
        });
        return {
          accepting: payload.accepting
        };
      }
      case 'runtime_reload': {
        const payload = decodeOrchestrationPayload(
          'runtime_reload',
          parsedPayload
        ) as RuntimeReloadOrchestrationPayload;
        return await this.deps.createPluginContext(request.actorId).requestRuntimeReload({
          mode: payload.mode,
          reason: CLI_RUNTIME_CONTROL_REASON,
          requestedBy: CLI_RUNTIME_CONTROL_REQUESTED_BY
        });
      }
      case 'provider_test': {
        const payload = decodeOrchestrationPayload(
          'provider_test',
          parsedPayload
        ) as ProviderTestOrchestrationPayload;
        return await this.deps.createPluginContext(request.actorId).testProvider({
          ...(payload.sendTurn === true ? { sendTurn: true } : {}),
          ...(payload.prompt ? { prompt: payload.prompt } : {}),
          reason: CLI_RUNTIME_CONTROL_REASON,
          requestedBy: CLI_RUNTIME_CONTROL_REQUESTED_BY
        });
      }
      case 'provider_stop': {
        const payload = decodeOrchestrationPayload(
          'provider_stop',
          parsedPayload
        ) as ProviderSessionControlOrchestrationPayload;
        return await this.deps.createPluginContext(request.actorId).stopProvider({
          ...(payload.threadId ? { threadId: payload.threadId } : {}),
          reason: CLI_RUNTIME_CONTROL_REASON,
          requestedBy: CLI_RUNTIME_CONTROL_REQUESTED_BY
        });
      }
      case 'provider_start': {
        const payload = decodeOrchestrationPayload(
          'provider_start',
          parsedPayload
        ) as ProviderSessionControlOrchestrationPayload;
        return await this.deps.createPluginContext(request.actorId).startProvider({
          ...(payload.threadId ? { threadId: payload.threadId } : {}),
          reason: CLI_RUNTIME_CONTROL_REASON,
          requestedBy: CLI_RUNTIME_CONTROL_REQUESTED_BY
        });
      }
      case 'resolve_pending_request': {
        const payload = decodeOrchestrationPayload(
          'resolve_pending_request',
          parsedPayload
        ) as ResolvePendingRequestOrchestrationPayload;
        const context = this.deps.createPluginContext(request.actorId);
        const pending = context.getRuntimeOverview().openRequests.find((entry) => entry.requestId === payload.requestId);
        if (!pending || pending.status !== 'open') {
          throw new Error(`Open pending request not found: ${payload.requestId}`);
        }
        if (payload.decision === 'cancel') {
          await context.cancelRuntimeRequest({
            threadId: pending.threadId,
            requestId: pending.requestId,
            requestType: pending.requestType
          });
          return {
            requestId: pending.requestId,
            decision: payload.decision
          };
        }
        await context.respondToRuntimeRequest({
          threadId: pending.threadId,
          requestId: pending.requestId,
          decision: payload.decision
        });
        return {
          requestId: pending.requestId,
          decision: payload.decision
        };
      }
      case 'answer_pending_request': {
        const payload = decodeOrchestrationPayload(
          'answer_pending_request',
          parsedPayload
        ) as AnswerPendingRequestOrchestrationPayload;
        const context = this.deps.createPluginContext(request.actorId);
        const pending = context.getRuntimeOverview().openRequests.find((entry) => entry.requestId === payload.requestId);
        if (!pending || pending.status !== 'open') {
          throw new Error(`Open pending request not found: ${payload.requestId}`);
        }
        await context.respondToRuntimeUserInput({
          threadId: pending.threadId,
          requestId: pending.requestId,
          answers: payload.answers
        });
        return {
          requestId: pending.requestId
        };
      }
      default:
        throw new Error(`Unknown orchestration request type: ${String(request.type)}`);
    }
  }

  private async waitForInFlight(): Promise<void> {
    const startedAt = this.nowMs();
    const timeoutMs = this.deps.drainWaitTimeoutMs ?? ORCHESTRATION_DRAIN_WAIT_TIMEOUT_MS;
    while (this.inFlight.size > 0) {
      const elapsedMs = this.nowMs() - startedAt;
      const remainingMs = timeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        this.signalForcedDrain(timeoutMs);
        return;
      }
      await Promise.race([
        Promise.race(this.inFlight.values()),
        new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, Math.min(ORCHESTRATION_POLL_MS, remainingMs));
        })
      ]);
    }
  }

  private recoverAbandonedRunningRequests(): void {
    const nowIso = this.deps.now();
    const recovered = this.deps.store.failAbandonedRunningOrchestrationRequests({
      executionOwner: this.executionOwner,
      nowIso,
      error: ORCHESTRATION_REPLAY_SAFETY_BLOCK_ERROR
    });
    if (recovered > 0) {
      this.deps.store.putMetadata(
        'runtime.orchestration.last_replay_safety_block',
        {
          recovered,
          executionOwner: this.executionOwner,
          at: nowIso
        },
        nowIso
      );
    }
  }

  private nowMs(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  private signalForcedDrain(timeoutMs: number): void {
    const nowIso = this.deps.now();
    const ages = [...this.inFlightStartedAt.values()].map((startedAt) => Math.max(0, this.nowMs() - startedAt));
    const signal: ForcedDrainSignal = {
      timeoutMs,
      inFlightRequestIds: [...this.inFlight.keys()],
      oldestInFlightAgeMs: ages.length > 0 ? Math.max(...ages) : 0,
      at: nowIso
    };

    this.deps.store.putMetadata('runtime.orchestration.last_forced_drain', signal, nowIso);
    this.deps.onForcedDrain?.(signal);
  }
}
