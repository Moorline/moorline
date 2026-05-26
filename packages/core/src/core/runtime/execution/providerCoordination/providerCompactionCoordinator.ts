const THREAD_COMPACTION_LATCH_TIMEOUT_MS = 30_000;

export class ProviderCompactionCoordinator {
  private readonly compactingThreads = new Set<string>();
  private readonly compactionLatchTimeouts = new Map<string, ReturnType<typeof globalThis.setTimeout>>();

  isCompacting(threadId: string): boolean {
    return this.compactingThreads.has(threadId);
  }

  start(threadId: string, onTimeout: () => void): void {
    this.clear(threadId);
    this.compactingThreads.add(threadId);
    this.compactionLatchTimeouts.set(
      threadId,
      globalThis.setTimeout(() => {
        this.clear(threadId);
        onTimeout();
      }, THREAD_COMPACTION_LATCH_TIMEOUT_MS)
    );
  }

  clear(threadId: string): void {
    this.compactingThreads.delete(threadId);
    const timeout = this.compactionLatchTimeouts.get(threadId);
    if (timeout) {
      globalThis.clearTimeout(timeout);
      this.compactionLatchTimeouts.delete(threadId);
    }
  }
}
