import { randomUUID } from 'node:crypto';
import type { ProviderInputImage, ProviderRuntimeEvent } from '../../../../types/runtime.js';
import type { RuntimeMessagePayload } from '../../../../types/transport.js';
import type { RuntimeSessionRow } from '../../../system/state/sqliteSessionStore.js';
import { ProviderRequestAttributionService } from '../providerCoordination/providerRequestAttributionService.js';
import type {
  ProviderAuditPort,
  ProviderGuardPort,
  ProviderModelPort,
  ProviderTypingPort,
  ProviderTurnSurface,
  TurnCompletionState
} from './ports.js';
import type { RuntimeProvider } from '../../../../types/provider.js';
import type { ProviderSessionOrchestrator } from './providerSessionOrchestrator.js';

const DEFAULT_PROVIDER_TURN_WAIT_TIMEOUT_MS = 10 * 60_000;
const MAX_SEALED_TURN_KEYS = 2_048;

interface Waiter {
  threadId: string;
  turnId: string;
  transportResourceId: string;
  surface: ProviderTurnSurface;
  promptContent: string;
  session: RuntimeSessionRow | null;
  authorId: string;
  promptSource?: string;
  actorLabel?: string;
  timeout: ReturnType<typeof globalThis.setTimeout>;
  resolve(value: RuntimeMessagePayload): void;
  reject(error: Error): void;
}

interface TurnBuffer {
  chunks: string[];
  assistantItemOrder: string[];
  assistantItems: Map<
    string,
    {
      chunks: string[];
      completedText: string | null;
      phase: 'commentary' | 'final_answer' | null;
    }
  >;
  files: Array<{ path: string }>;
  completion: null | { state: TurnCompletionState; errorMessage?: string };
}

function appendAssistantChunk(buffer: TurnBuffer, itemId: string | undefined, delta: string): void {
  if (!itemId) {
    buffer.chunks.push(delta);
    return;
  }

  let entry = buffer.assistantItems.get(itemId);
  if (!entry) {
    entry = {
      chunks: [],
      completedText: null,
      phase: null
    };
    buffer.assistantItems.set(itemId, entry);
    buffer.assistantItemOrder.push(itemId);
  }
  entry.chunks.push(delta);
}

function finalizeAssistantItem(
  buffer: TurnBuffer,
  itemId: string,
  detail: string | undefined,
  phase: 'commentary' | 'final_answer' | undefined
): void {
  let entry = buffer.assistantItems.get(itemId);
  if (!entry) {
    entry = {
      chunks: [],
      completedText: null,
      phase: null
    };
    buffer.assistantItems.set(itemId, entry);
    buffer.assistantItemOrder.push(itemId);
  }
  if (detail !== undefined) {
    entry.completedText = detail;
  }
  if (phase) {
    entry.phase = phase;
  }
}

function resolveTurnBufferContent(buffer: TurnBuffer): string {
  const assistantItems = buffer.assistantItemOrder
    .map((itemId) => buffer.assistantItems.get(itemId))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  const finalAnswer = assistantItems
    .filter((entry) => entry.phase === 'final_answer')
    .map((entry) => entry.completedText ?? entry.chunks.join(''))
    .join('');
  if (finalAnswer.trim()) {
    return finalAnswer.trim();
  }

  const unknownPhase = assistantItems
    .filter((entry) => entry.phase === null && (entry.completedText !== null || entry.chunks.length > 0))
    .map((entry) => entry.completedText ?? entry.chunks.join(''))
    .join('');
  if (unknownPhase.trim()) {
    return unknownPhase.trim();
  }

  return buffer.chunks.join('').trim();
}

export interface RuntimeProviderTurnInput {
  actorId: string;
  session: RuntimeSessionRow;
  transportResourceId: string;
  surface: ProviderTurnSurface;
  promptContent: string;
  promptSource?: string;
  authorId: string;
  authorLabel?: string;
  providerInput: {
    text: string;
    images?: ProviderInputImage[];
  };
}

interface ProviderTurnBrokerDeps extends ProviderAuditPort, ProviderGuardPort, ProviderModelPort {
  provider: RuntimeProvider;
  sessions: ProviderSessionOrchestrator;
  typing: ProviderTypingPort;
  attribution: ProviderRequestAttributionService;
  now(): string;
  turnWaitTimeoutMs?: number;
}

export class ProviderTurnBroker {
  private readonly turnWaiters = new Map<string, Waiter>();
  private readonly turnBuffers = new Map<string, TurnBuffer>();
  private readonly sealedTurnKeys = new Set<string>();
  private readonly sealedTurnOrder: string[] = [];
  private readonly turnWaitTimeoutMs: number;

  constructor(private readonly deps: ProviderTurnBrokerDeps) {
    const configured = deps.turnWaitTimeoutMs;
    this.turnWaitTimeoutMs =
      typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_PROVIDER_TURN_WAIT_TIMEOUT_MS;
  }

  async runTurn(input: RuntimeProviderTurnInput): Promise<RuntimeMessagePayload> {
    const stoppedReply = this.deps.sessions.stoppedReplyIfDisabled(input.session);
    if (stoppedReply) {
      return stoppedReply;
    }

    this.deps.attribution.setThreadRequester(input.session.threadId, input.authorId);
    let turnId: string;
    try {
      await this.deps.sessions.ensureSession(input.session, input.actorId);
      ({ turnId } = await this.deps.runGuardedProviderAction({
        action: 'net.connect',
        actor: input.actorId,
        target: this.deps.providerPolicyTarget(input.session.threadId, 'turn'),
        payload: {
          surface: input.surface,
          runtimeMode: input.session.runtimeMode
        },
        threadId: input.session.threadId,
        title: 'Provider turn blocked',
        execute: async () =>
          await this.deps.provider.sendTurn(
            input.session.threadId,
            input.providerInput,
            this.deps.configuredProviderModel()
          )
      }));
    } catch (error) {
      this.deps.attribution.deleteThread(input.session.threadId);
      throw error;
    }

    const waiterKey = `${input.session.threadId}:${turnId}`;
    this.sealedTurnKeys.delete(waiterKey);
    const stopTyping = this.deps.typing.startTypingLoop(input.actorId, input.transportResourceId);
    try {
      return await new Promise<RuntimeMessagePayload>((resolve, reject) => {
        const timeout = globalThis.setTimeout(() => {
          this.turnWaiters.delete(waiterKey);
          this.turnBuffers.delete(waiterKey);
          this.markTurnKeySealed(waiterKey);
          this.deps.attribution.deleteThread(input.session.threadId);
          const detail = `Provider turn timed out after ${this.turnWaitTimeoutMs}ms waiting for completion events.`;
          this.deps.recordRuntimeActivity({
            threadId: input.session.threadId,
            sessionId: input.session.sessionId,
            transportResourceId: input.transportResourceId,
            sourceEventId: randomUUID(),
            kind: 'provider.turn.timeout',
            severity: 'warning',
            title: 'Provider turn timed out',
            detail,
            createdAt: this.deps.now()
          });
          this.deps.appendAuditEvent('provider.turn.timeout', {
            threadId: input.session.threadId,
            sessionId: input.session.sessionId,
            transportResourceId: input.transportResourceId,
            turnId,
            timeoutMs: this.turnWaitTimeoutMs
          });
          void this.deps
            .runGuardedProviderAction({
              action: 'net.connect',
              actor: 'runtime:provider/timeout',
              target: this.deps.providerPolicyTarget(input.session.threadId, 'interrupt'),
              threadId: input.session.threadId,
              title: 'Provider timeout interrupt blocked',
              execute: async () => await this.deps.provider.interruptTurn(input.session.threadId)
            })
            .then(() => {
              this.deps.appendAuditEvent('provider.turn.timeout.interrupt_sent', {
                threadId: input.session.threadId,
                sessionId: input.session.sessionId,
                transportResourceId: input.transportResourceId,
                turnId
              });
            })
            .catch((interruptError) => {
              this.deps.appendAuditEvent('provider.turn.timeout.interrupt_failed', {
                threadId: input.session.threadId,
                sessionId: input.session.sessionId,
                transportResourceId: input.transportResourceId,
                turnId,
                error: interruptError instanceof Error ? interruptError.message : String(interruptError)
              });
            });
          reject(new Error(detail));
        }, this.turnWaitTimeoutMs);
        this.turnWaiters.set(waiterKey, {
          threadId: input.session.threadId,
          turnId,
          transportResourceId: input.transportResourceId,
          surface: input.surface,
          promptContent: input.promptContent,
          session: input.session,
          authorId: input.authorId,
          promptSource: input.promptSource,
          actorLabel: input.authorLabel,
          timeout,
          resolve,
          reject
        });
        const threadFailure = this.deps.sessions.consumeThreadFailure(input.session.threadId);
        if (threadFailure) {
          this.rejectTurnWaiter(waiterKey, threadFailure);
          return;
        }
        this.flushTurnBuffer(waiterKey);
      });
    } finally {
      stopTyping();
    }
  }

  onContentDelta(event: ProviderRuntimeEvent & { type: 'content.delta' }): void {
    if (!event.turnId) {
      return;
    }
    const key = `${event.threadId}:${event.turnId}`;
    if (this.shouldTrackTurnEvent(key, event.threadId)) {
      appendAssistantChunk(this.getTurnBuffer(key), event.itemId, event.payload.delta);
    }
  }

  onItemCompleted(event: ProviderRuntimeEvent & { type: 'item.completed' }, attachmentPath: string | null): void {
    if (!event.turnId) {
      return;
    }
    const key = `${event.threadId}:${event.turnId}`;
    if (!this.shouldTrackTurnEvent(key, event.threadId)) {
      return;
    }
    const buffer = this.getTurnBuffer(key);
    if (event.itemId && event.payload.itemType === 'assistant_message') {
      finalizeAssistantItem(buffer, event.itemId, event.payload.detail, event.payload.phase);
    }
    if (attachmentPath && !buffer.files.some((entry) => entry.path === attachmentPath)) {
      buffer.files.push({ path: attachmentPath });
    }
  }

  onTurnCompleted(event: ProviderRuntimeEvent & { type: 'turn.completed' }): void {
    if (!event.turnId) {
      return;
    }
    this.deps.attribution.deleteThread(event.threadId);
    const key = `${event.threadId}:${event.turnId}`;
    if (this.shouldTrackTurnEvent(key, event.threadId)) {
      this.getTurnBuffer(key).completion = {
        state: event.payload.state,
        ...(event.payload.errorMessage ? { errorMessage: event.payload.errorMessage } : {})
      };
    }
    this.flushTurnBuffer(key);
  }

  onTurnAborted(event: ProviderRuntimeEvent & { type: 'turn.aborted' }): void {
    if (!event.turnId) {
      return;
    }
    this.deps.attribution.deleteThread(event.threadId);
    this.rejectTurnWaiter(`${event.threadId}:${event.turnId}`, event.payload.reason);
  }

  onProviderFailure(threadId: string, reason: string): void {
    this.deps.attribution.deleteThread(threadId);
    this.rejectThread(threadId, reason);
  }

  hasOpenTurn(threadId: string): boolean {
    for (const key of this.turnWaiters.keys()) {
      if (key.startsWith(`${threadId}:`)) {
        return true;
      }
    }
    return false;
  }

  flushThread(threadId: string): void {
    for (const key of [...this.turnWaiters.keys()]) {
      if (key.startsWith(`${threadId}:`)) {
        this.flushTurnBuffer(key);
      }
    }
  }

  rejectThread(threadId: string, reason: string): void {
    this.deps.sessions.markThreadFailure(threadId, reason);
    for (const key of [...this.turnWaiters.keys()]) {
      if (key.startsWith(`${threadId}:`)) {
        this.rejectTurnWaiter(key, reason);
      }
    }
  }

  rejectAll(reason: string): void {
    for (const threadId of new Set([...this.turnWaiters.values()].map((waiter) => waiter.threadId))) {
      this.deps.sessions.markThreadFailure(threadId, reason);
    }
    for (const key of [...this.turnWaiters.keys()]) {
      this.rejectTurnWaiter(key, reason);
    }
  }

  clearRequestAttribution(): void {
    this.deps.attribution.clear();
  }

  clearThreadState(threadId: string): void {
    this.deps.attribution.deleteThread(threadId);
    for (const key of [...this.turnBuffers.keys()]) {
      if (key.startsWith(`${threadId}:`)) {
        this.turnBuffers.delete(key);
      }
    }
  }

  private rejectTurnWaiter(key: string, reason: string): void {
    const waiter = this.turnWaiters.get(key);
    this.markTurnKeySealed(key);
    if (!waiter) {
      this.turnBuffers.delete(key);
      return;
    }
    globalThis.clearTimeout(waiter.timeout);
    this.turnWaiters.delete(key);
    this.turnBuffers.delete(key);
    waiter.reject(new Error(reason));
  }

  private getTurnBuffer(key: string): TurnBuffer {
    const existing = this.turnBuffers.get(key);
    if (existing) {
      return existing;
    }
    const created: TurnBuffer = {
      chunks: [],
      assistantItemOrder: [],
      assistantItems: new Map(),
      files: [],
      completion: null
    };
    this.turnBuffers.set(key, created);
    return created;
  }

  private flushTurnBuffer(key: string): void {
    const waiter = this.turnWaiters.get(key);
    const buffer = this.turnBuffers.get(key);
    if (!waiter || !buffer?.completion) {
      return;
    }

    this.turnWaiters.delete(key);
    this.turnBuffers.delete(key);
    this.markTurnKeySealed(key);
    globalThis.clearTimeout(waiter.timeout);

    if (buffer.completion.state === 'failed') {
      waiter.reject(new Error(buffer.completion.errorMessage ?? 'Provider turn failed'));
      return;
    }

    if (buffer.completion.state === 'cancelled' || buffer.completion.state === 'interrupted') {
      waiter.reject(new Error(`Provider turn ${buffer.completion.state}`));
      return;
    }

    const content = resolveTurnBufferContent(buffer);
    waiter.resolve({
      ...(content ? { text: content } : {}),
      ...(buffer.files.length > 0
        ? {
            attachments: buffer.files.map((file) => ({
              kind: 'file' as const,
              path: file.path
            }))
          }
        : {})
    });
  }

  private shouldTrackTurnEvent(key: string, threadId: string): boolean {
    if (this.sealedTurnKeys.has(key)) {
      return false;
    }
    if (this.turnWaiters.has(key) || this.turnBuffers.has(key)) {
      return true;
    }
    return this.deps.attribution.hasThread(threadId);
  }

  private markTurnKeySealed(key: string): void {
    if (this.sealedTurnKeys.has(key)) {
      return;
    }
    this.sealedTurnKeys.add(key);
    this.sealedTurnOrder.push(key);
    while (this.sealedTurnOrder.length > MAX_SEALED_TURN_KEYS) {
      const expired = this.sealedTurnOrder.shift();
      if (!expired) {
        break;
      }
      this.sealedTurnKeys.delete(expired);
    }
  }
}
