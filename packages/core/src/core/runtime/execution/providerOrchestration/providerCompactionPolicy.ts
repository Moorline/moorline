import { randomUUID } from 'node:crypto';
import type { ProviderRuntimeEvent } from '../../../../types/runtime.js';
import type { RuntimeSessionRow } from '../../../system/state/sqliteSessionStore.js';
import type { ProviderAuditPort, ProviderGuardPort, ProviderModelPort } from './ports.js';
import type { RuntimeProvider } from '../../../../types/provider.js';

const THREAD_COMPACTION_USAGE_THRESHOLD = 0.85;
const THREAD_COMPACTION_LATCH_TIMEOUT_MS = 30_000;

interface ProviderCompactionPolicyDeps extends ProviderAuditPort, ProviderGuardPort, ProviderModelPort {
  provider: RuntimeProvider;
  now(): string;
  getSessionByThreadId(threadId: string): RuntimeSessionRow | null;
}

export class ProviderCompactionPolicy {
  private readonly compactingThreads = new Set<string>();
  private readonly compactionLatchTimeouts = new Map<string, ReturnType<typeof globalThis.setTimeout>>();

  constructor(private readonly deps: ProviderCompactionPolicyDeps) {}

  async handleEvent(event: ProviderRuntimeEvent): Promise<void> {
    if (event.type === 'thread.state.changed' && event.payload.state === 'compacted') {
      this.clearLatch(event.threadId);
      return;
    }

    if (event.type !== 'thread.token-usage.updated') {
      return;
    }

    if (this.compactingThreads.has(event.threadId)) {
      return;
    }

    const session = this.deps.getSessionByThreadId(event.threadId);
    if (!session || session.lifecycleStatus === 'archived' || session.activeTurnId) {
      return;
    }

    if (session.providerStatus === 'running' || session.providerStatus === 'connecting') {
      return;
    }

    const { totalTokens, modelContextWindow } = event.payload;
    if (!modelContextWindow || modelContextWindow <= 0) {
      return;
    }

    const usageRatio = totalTokens / modelContextWindow;
    if (usageRatio < THREAD_COMPACTION_USAGE_THRESHOLD) {
      return;
    }

    this.armLatch(event.threadId);
    const detail = `usage=${Math.round(usageRatio * 100)}% | total=${totalTokens} | window=${modelContextWindow}`;
    try {
      await this.deps.runGuardedProviderAction({
        action: 'net.connect',
        actor: 'runtime:provider/compaction',
        target: this.deps.providerPolicyTarget(event.threadId, 'thread-compact'),
        payload: {
          totalTokens,
          modelContextWindow,
          threshold: THREAD_COMPACTION_USAGE_THRESHOLD
        },
        threadId: event.threadId,
        title: 'Provider thread compaction blocked',
        execute: async () => await this.deps.provider.compactThread(event.threadId)
      });
      this.deps.recordRuntimeActivity({
        threadId: event.threadId,
        sessionId: session.sessionId,
        spaceId: session.spaceId,
        sourceEventId: event.eventId,
        kind: 'thread.compaction.requested',
        severity: 'warning',
        title: 'Thread compaction requested',
        detail,
        createdAt: this.deps.now()
      });
      this.deps.appendAuditEvent('provider.thread_compaction.requested', {
        threadId: event.threadId,
        sessionId: session.sessionId,
        spaceId: session.spaceId,
        totalTokens,
        modelContextWindow,
        usageRatio,
        threshold: THREAD_COMPACTION_USAGE_THRESHOLD
      });
    } catch (error) {
      this.clearLatch(event.threadId);
      this.deps.appendAuditEvent('provider.thread_compaction.failed', {
        threadId: event.threadId,
        sessionId: session.sessionId,
        spaceId: session.spaceId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  clearLatch(threadId: string): void {
    const timeout = this.compactionLatchTimeouts.get(threadId);
    if (timeout) {
      globalThis.clearTimeout(timeout);
      this.compactionLatchTimeouts.delete(threadId);
    }
    this.compactingThreads.delete(threadId);
  }

  clearAllLatches(): void {
    for (const timeout of this.compactionLatchTimeouts.values()) {
      globalThis.clearTimeout(timeout);
    }
    this.compactionLatchTimeouts.clear();
    this.compactingThreads.clear();
  }

  private armLatch(threadId: string): void {
    this.clearLatch(threadId);
    this.compactingThreads.add(threadId);
    const timeout = globalThis.setTimeout(() => {
      this.compactionLatchTimeouts.delete(threadId);
      if (!this.compactingThreads.delete(threadId)) {
        return;
      }
      const session = this.deps.getSessionByThreadId(threadId);
      this.deps.recordRuntimeActivity({
        threadId,
        sessionId: session?.sessionId ?? null,
        spaceId: session?.spaceId ?? null,
        sourceEventId: randomUUID(),
        kind: 'thread.compaction.timeout',
        severity: 'warning',
        title: 'Thread compaction latch released',
        detail: `No provider compaction confirmation arrived within ${THREAD_COMPACTION_LATCH_TIMEOUT_MS}ms.`,
        createdAt: this.deps.now()
      });
      this.deps.appendAuditEvent('provider.thread_compaction.timeout', {
        threadId,
        sessionId: session?.sessionId ?? null,
        spaceId: session?.spaceId ?? null,
        timeoutMs: THREAD_COMPACTION_LATCH_TIMEOUT_MS
      });
    }, THREAD_COMPACTION_LATCH_TIMEOUT_MS);
    this.compactionLatchTimeouts.set(threadId, timeout);
  }
}
