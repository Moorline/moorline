export class ProviderRequestAttributionService {
  private readonly threadRequesters = new Map<string, string>();

  setThreadRequester(threadId: string, requesterUserId: string | null | undefined): void {
    const normalized = this.normalizeRequesterUserId(requesterUserId);
    if (!normalized) {
      this.threadRequesters.delete(threadId);
      return;
    }
    this.threadRequesters.set(threadId, normalized);
  }

  getThreadRequester(threadId: string): string | undefined {
    return this.threadRequesters.get(threadId);
  }

  deleteThread(threadId: string): void {
    this.threadRequesters.delete(threadId);
  }

  clear(): void {
    this.threadRequesters.clear();
  }

  hasThread(threadId: string): boolean {
    return this.threadRequesters.has(threadId);
  }

  get map(): Map<string, string> {
    return this.threadRequesters;
  }

  private normalizeRequesterUserId(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    return value.includes(':') ? null : value;
  }
}
