import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import { buildChildProcessEnv } from '../../shared/utils/childProcessEnv.js';
import {
  buildManagedSidecarId,
  normalizeSidecarScopeKey,
  type ManagedSidecarDefinition,
  type ManagedSidecarRecord,
  type SidecarScopeKind
} from './managedSidecar.js';
import { isSameLaunchDefinition, normalizeReadinessProbe } from './sidecarLaunchDefinition.js';

interface SidecarManagerDeps {
  runtimeRoot: string;
  store: SqliteSessionStore;
  now: () => string;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  stopGracePeriodMs?: number;
  killGracePeriodMs?: number;
}

interface RunningSidecar {
  child: ChildProcessWithoutNullStreams;
  record: ManagedSidecarRecord;
  expectedStop: boolean;
  forcedKill: boolean;
  ready: Promise<ManagedSidecarRecord>;
  resolveReady(value: ManagedSidecarRecord): void;
  rejectReady(error: Error): void;
  stopped: Promise<ManagedSidecarRecord>;
  resolveStopped(value: ManagedSidecarRecord): void;
}

const LOG_STREAM_MAX_BUFFER_BYTES = 256 * 1024;
const LOG_STREAM_RESUME_BUFFER_BYTES = 64 * 1024;

export class SidecarManager {
  private readonly sidecarsRoot: string;
  private readonly running = new Map<string, RunningSidecar>();
  private shuttingDown = false;
  private readonly stopGracePeriodMs: number;
  private readonly killGracePeriodMs: number;

  constructor(private readonly deps: SidecarManagerDeps) {
    this.sidecarsRoot = join(this.deps.runtimeRoot, 'sidecars');
    this.stopGracePeriodMs = this.deps.stopGracePeriodMs ?? 2_000;
    this.killGracePeriodMs = this.deps.killGracePeriodMs ?? 1_000;
    mkdirSync(this.sidecarsRoot, { recursive: true });
  }

  listSidecars(): ManagedSidecarRecord[] {
    return this.deps.store.listManagedSidecars();
  }

  async recover(): Promise<void> {
    const recoverable = this.deps.store
      .listManagedSidecars()
      .filter((sidecar) => sidecar.status === 'starting' || sidecar.status === 'ready');
    for (const sidecar of recoverable) {
      await this.startSidecar(sidecar, true);
    }
  }

  async ensure(definition: ManagedSidecarDefinition): Promise<ManagedSidecarRecord> {
    const scopeKey = normalizeSidecarScopeKey(definition.scope);
    const sidecarId = buildManagedSidecarId({
      pluginId: definition.pluginId,
      name: definition.name,
      scopeKind: definition.scope.kind,
      scopeKey
    });
    const cwd = definition.launch.cwd?.trim() || join(this.sidecarsRoot, sidecarId);
    mkdirSync(cwd, { recursive: true });

    const running = this.running.get(sidecarId);
    if (running && isSameLaunchDefinition(running.record, definition, cwd)) {
      return await running.ready;
    }

    const existing = this.deps.store.getManagedSidecar(sidecarId);
    if (existing && isSameLaunchDefinition(existing, definition, cwd)) {
      if (!running && (existing.status === 'ready' || existing.status === 'starting')) {
        return await this.startSidecar(existing, true);
      }
      if (existing.status === 'ready') {
        return existing;
      }
    }

    if (running) {
      await this.stopById(sidecarId, 'sidecar.replaced');
    }

    const now = this.deps.now();
    const record: ManagedSidecarRecord = {
      sidecarId,
      instanceId: randomUUID(),
      pluginId: definition.pluginId,
      name: definition.name,
      scopeKind: definition.scope.kind,
      scopeKey,
      status: 'starting',
      command: definition.launch.command,
      args: definition.launch.args ?? [],
      cwd,
      env: definition.launch.env ?? {},
      restartPolicy: definition.launch.restart?.policy ?? 'never',
      maxRestarts: definition.launch.restart?.maxRestarts ?? 0,
      readiness: normalizeReadinessProbe(definition.launch.readiness),
      artifactDir: cwd,
      pid: null,
      restartCount: existing?.restartCount ?? 0,
      startedAt: now,
      readyAt: null,
      stoppedAt: null,
      lastExitCode: null,
      lastExitSignal: null,
      lastError: null,
      updatedAt: now
    };
    return await this.startSidecar(record, false);
  }

  async stop(input: { pluginId: string; name: string; scopeKind: SidecarScopeKind; scopeKey: string }): Promise<ManagedSidecarRecord | null> {
    const sidecarId = buildManagedSidecarId(input);
    return await this.stopById(sidecarId, 'sidecar.stopped');
  }

  async cleanupScope(input: { scopeKind: SidecarScopeKind; scopeKey: string; reason: string }): Promise<ManagedSidecarRecord[]> {
    const sidecars = this.deps.store.listManagedSidecarsByScope(input.scopeKind, input.scopeKey);
    const stopped: ManagedSidecarRecord[] = [];
    for (const sidecar of sidecars) {
      const result = await this.stopById(sidecar.sidecarId, 'sidecar.cleaned_up', input.reason);
      if (result) {
        stopped.push(result);
      }
    }
    return stopped;
  }

  async shutdown(reason: string): Promise<void> {
    this.shuttingDown = true;
    const sidecarIds = [...this.running.keys()];
    for (const sidecarId of sidecarIds) {
      await this.stopById(sidecarId, 'sidecar.cleaned_up', reason);
    }
  }

  private attachLogStream(input: {
    source: Readable;
    path: string;
    onChunk(value: string): void;
  }): {
    close(): Promise<void>;
  } {
    const stream: WriteStream = createWriteStream(input.path, { flags: 'a' });
    let paused = false;
    const tryResume = (): void => {
      if (!paused || stream.writableLength > LOG_STREAM_RESUME_BUFFER_BYTES) {
        return;
      }
      paused = false;
      input.source.resume();
    };
    stream.on('drain', tryResume);
    input.source.on('data', (chunk: Buffer | string) => {
      const value = String(chunk);
      input.onChunk(value);
      stream.write(value, 'utf8');
      if (!paused && stream.writableLength >= LOG_STREAM_MAX_BUFFER_BYTES) {
        paused = true;
        input.source.pause();
      }
    });

    const close = async (): Promise<void> => {
      if (paused) {
        paused = false;
        input.source.resume();
      }
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    };

    return {
      close
    };
  }

  private async stopById(sidecarId: string, eventName: string, reason?: string): Promise<ManagedSidecarRecord | null> {
    const running = this.running.get(sidecarId);
    if (!running) {
      const existing = this.deps.store.getManagedSidecar(sidecarId);
      if (!existing) {
        return null;
      }
      const stopped = this.persist({
        ...existing,
        status: 'stopped',
        pid: null,
        stoppedAt: this.deps.now(),
        updatedAt: this.deps.now(),
        lastError: reason ?? existing.lastError
      });
      this.deps.appendAuditEvent(eventName, {
        sidecarId,
        instanceId: stopped.instanceId,
        reason: reason ?? null
      });
      return stopped;
    }

    running.expectedStop = true;
    const stopping = this.persist({
      ...running.record,
      status: 'stopping',
      updatedAt: this.deps.now(),
      lastError: reason ?? null
    });
    running.record = stopping;
    running.child.kill('SIGTERM');

    let stopped: ManagedSidecarRecord;
    try {
      stopped = await this.awaitStop(running, this.stopGracePeriodMs);
    } catch {
      running.forcedKill = true;
      running.child.kill('SIGKILL');
      try {
        stopped = await this.awaitStop(running, this.killGracePeriodMs);
      } catch {
        this.running.delete(sidecarId);
        stopped = this.persist({
          ...running.record,
          status: 'failed',
          pid: null,
          stoppedAt: this.deps.now(),
          lastExitCode: null,
          lastExitSignal: 'SIGKILL',
          lastError: `Sidecar did not exit within ${this.stopGracePeriodMs + this.killGracePeriodMs}ms.`,
          updatedAt: this.deps.now()
        });
      }
    }
    this.deps.appendAuditEvent(eventName, {
      sidecarId,
      instanceId: stopped.instanceId,
      reason: reason ?? null
    });
    return stopped;
  }

  private async startSidecar(record: ManagedSidecarRecord, recovered: boolean): Promise<ManagedSidecarRecord> {
    mkdirSync(record.artifactDir, { recursive: true });
    const child = spawn(record.command, record.args, {
      cwd: record.cwd,
      env: buildChildProcessEnv({ explicit: record.env }),
      stdio: 'pipe'
    });

    let resolveReady!: (value: ManagedSidecarRecord) => void;
    let rejectReady!: (error: Error) => void;
    let resolveStopped!: (value: ManagedSidecarRecord) => void;
    const ready = new Promise<ManagedSidecarRecord>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const stopped = new Promise<ManagedSidecarRecord>((resolve) => {
      resolveStopped = resolve;
    });
    const running: RunningSidecar = {
      child,
      record,
      expectedStop: false,
      forcedKill: false,
      ready,
      resolveReady,
      rejectReady,
      stopped,
      resolveStopped
    };
    this.running.set(record.sidecarId, running);
    const started = this.persist({
      ...record,
      status: 'starting',
      pid: child.pid ?? null,
      startedAt: this.deps.now(),
      readyAt: null,
      stoppedAt: null,
      lastExitCode: null,
      lastExitSignal: null,
      lastError: recovered ? 'Recovered after runtime restart.' : null,
      updatedAt: this.deps.now()
    });
    running.record = started;

    const stdoutLog = join(started.artifactDir, 'stdout.log');
    const stderrLog = join(started.artifactDir, 'stderr.log');
    let settled = false;
    const markReady = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      const current = this.persist({
        ...running.record,
        status: 'ready',
        readyAt: this.deps.now(),
        updatedAt: this.deps.now(),
        lastError: null
      });
      running.record = current;
      this.deps.appendAuditEvent('sidecar.started', {
        sidecarId: current.sidecarId,
        instanceId: current.instanceId,
        pluginId: current.pluginId,
        scopeKind: current.scopeKind,
        scopeKey: current.scopeKey,
        pid: current.pid,
        recovered
      });
      running.resolveReady(current);
    };

    const readiness = running.record.readiness;
    const readinessPattern = readiness.kind === 'stdio' ? new RegExp(readiness.pattern) : null;
    const readinessTimer =
      readiness.kind === 'stdio'
        ? globalThis.setTimeout(() => {
            if (!settled) {
              running.child.kill('SIGTERM');
              running.rejectReady(new Error(`Sidecar ${running.record.sidecarId} did not become ready before timeout.`));
            }
          }, readiness.timeoutMs ?? 15_000)
        : null;

    const inspectChunk = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (readiness.kind !== 'stdio' || !readinessPattern || settled) {
        return;
      }
      const allowedStream =
        readiness.stream === 'both' || readiness.stream === undefined ? true : readiness.stream === stream;
      if (!allowedStream) {
        return;
      }
      if (readinessPattern.test(chunk)) {
        if (readinessTimer) {
          globalThis.clearTimeout(readinessTimer);
        }
        markReady();
      }
    };

    const stdout = this.attachLogStream({
      source: running.child.stdout,
      path: stdoutLog,
      onChunk: (value) => {
        inspectChunk('stdout', value);
      }
    });
    const stderr = this.attachLogStream({
      source: running.child.stderr,
      path: stderrLog,
      onChunk: (value) => {
        inspectChunk('stderr', value);
      }
    });

    running.child.once('exit', (code, signal) => {
      if (readinessTimer) {
        globalThis.clearTimeout(readinessTimer);
      }
      void Promise.all([stdout.close(), stderr.close()]);
      const current = this.running.get(record.sidecarId);
      if (!current || current.record.instanceId !== started.instanceId) {
        return;
      }
      this.running.delete(record.sidecarId);
      const failed = current.forcedKill || (!current.expectedStop && !this.shuttingDown && code !== 0);
      const nextRecord = this.persist({
        ...current.record,
        status: failed ? 'failed' : 'stopped',
        pid: null,
        stoppedAt: this.deps.now(),
        lastExitCode: code,
        lastExitSignal: signal,
        lastError: failed ? `Sidecar exited unexpectedly with code ${code ?? 'null'}.` : current.record.lastError,
        updatedAt: this.deps.now()
      });
      current.resolveStopped(nextRecord);
      if (!settled) {
        settled = true;
        current.rejectReady(new Error(nextRecord.lastError ?? `Sidecar ${nextRecord.sidecarId} exited before readiness.`));
      }
      this.deps.appendAuditEvent(failed ? 'sidecar.failed' : 'sidecar.stopped', {
        sidecarId: nextRecord.sidecarId,
        instanceId: nextRecord.instanceId,
        exitCode: code,
        signal,
        restartCount: nextRecord.restartCount
      });
      if (
        failed &&
        !current.expectedStop &&
        nextRecord.restartPolicy === 'on-failure' &&
        nextRecord.restartCount < nextRecord.maxRestarts
      ) {
        const restarting = this.persist({
          ...nextRecord,
          instanceId: randomUUID(),
          status: 'starting',
          restartCount: nextRecord.restartCount + 1,
          pid: null,
          readyAt: null,
          stoppedAt: null,
          lastError: nextRecord.lastError,
          updatedAt: this.deps.now()
        });
        this.deps.appendAuditEvent('sidecar.restarted', {
          sidecarId: restarting.sidecarId,
          previousInstanceId: nextRecord.instanceId,
          instanceId: restarting.instanceId,
          restartCount: restarting.restartCount
        });
        void this.startSidecar(restarting, false).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const failedRestart = this.persist({
            ...restarting,
            status: 'failed',
            pid: null,
            stoppedAt: this.deps.now(),
            lastError: message,
            updatedAt: this.deps.now()
          });
          this.deps.appendAuditEvent('sidecar.restart.failed', {
            sidecarId: failedRestart.sidecarId,
            instanceId: failedRestart.instanceId,
            previousInstanceId: nextRecord.instanceId,
            restartCount: failedRestart.restartCount,
            error: message
          });
        });
      }
    });

    if (readiness.kind === 'none') {
      markReady();
    }

    return await ready;
  }

  private persist(record: ManagedSidecarRecord): ManagedSidecarRecord {
    this.deps.store.upsertManagedSidecar(record);
    return this.deps.store.getManagedSidecar(record.sidecarId) ?? record;
  }

  private async awaitStop(running: RunningSidecar, timeoutMs: number): Promise<ManagedSidecarRecord> {
    return await Promise.race([
      running.stopped,
      new Promise<ManagedSidecarRecord>((_, reject) => {
        globalThis.setTimeout(() => {
          reject(new Error(`Timed out waiting for ${running.record.sidecarId} to stop.`));
        }, timeoutMs);
      })
    ]);
  }
}
