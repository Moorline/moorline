interface KeyedDrainableWorkerOptions {
  maxPendingPerKey?: number;
  maxPendingTotal?: number;
}

export class KeyedDrainableWorker {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pendingByKey = new Map<string, number>();
  private readonly enqueuedAtByKey = new Map<string, number[]>();
  private pendingTotal = 0;
  private readonly maxPendingPerKey: number;
  private readonly maxPendingTotal: number;

  constructor(
    readonly name: string,
    options: KeyedDrainableWorkerOptions = {}
  ) {
    this.maxPendingPerKey = options.maxPendingPerKey ?? 256;
    this.maxPendingTotal = options.maxPendingTotal ?? 4_096;
  }

  push<T>(key: string, work: () => Promise<T>): Promise<T> {
    const pendingForKey = this.pendingByKey.get(key) ?? 0;
    if (pendingForKey >= this.maxPendingPerKey) {
      return Promise.reject(
        new Error(
          `${this.name} rejected work for key ${key}: queue depth ${pendingForKey} exceeds maxPendingPerKey ${this.maxPendingPerKey}.`
        )
      );
    }
    if (this.pendingTotal >= this.maxPendingTotal) {
      return Promise.reject(
        new Error(
          `${this.name} rejected work for key ${key}: total queue depth ${this.pendingTotal} exceeds maxPendingTotal ${this.maxPendingTotal}.`
        )
      );
    }

    this.pendingByKey.set(key, pendingForKey + 1);
    const enqueuedForKey = this.enqueuedAtByKey.get(key) ?? [];
    enqueuedForKey.push(Date.now());
    this.enqueuedAtByKey.set(key, enqueuedForKey);
    this.pendingTotal += 1;

    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, settled);
    void settled.finally(() => {
      const latestPendingForKey = this.pendingByKey.get(key) ?? 0;
      if (latestPendingForKey <= 1) {
        this.pendingByKey.delete(key);
      } else {
        this.pendingByKey.set(key, latestPendingForKey - 1);
      }
      const queuedTimestamps = this.enqueuedAtByKey.get(key);
      if (queuedTimestamps && queuedTimestamps.length > 0) {
        queuedTimestamps.shift();
        if (queuedTimestamps.length === 0) {
          this.enqueuedAtByKey.delete(key);
        } else {
          this.enqueuedAtByKey.set(key, queuedTimestamps);
        }
      }
      this.pendingTotal = Math.max(0, this.pendingTotal - 1);
      if (this.tails.get(key) === settled) {
        this.tails.delete(key);
      }
    });
    return run;
  }

  getStats(input: { nowMs?: number } = {}): {
    name: string;
    pendingTotal: number;
    keysWithPending: number;
    maxPendingPerKey: number;
    maxPendingTotal: number;
    oldestPendingAgeMs: number;
  } {
    const nowMs = input.nowMs ?? Date.now();
    let oldestPendingAgeMs = 0;
    for (const queue of this.enqueuedAtByKey.values()) {
      const oldestForKey = queue[0];
      if (oldestForKey === undefined) {
        continue;
      }
      oldestPendingAgeMs = Math.max(oldestPendingAgeMs, Math.max(0, nowMs - oldestForKey));
    }
    return {
      name: this.name,
      pendingTotal: this.pendingTotal,
      keysWithPending: this.pendingByKey.size,
      maxPendingPerKey: this.maxPendingPerKey,
      maxPendingTotal: this.maxPendingTotal,
      oldestPendingAgeMs
    };
  }

  async drain(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }
}
