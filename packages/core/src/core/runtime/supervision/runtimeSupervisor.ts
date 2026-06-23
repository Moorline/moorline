import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RuntimeActorIdentity } from '../../../types/transport.js';
import type {
  RuntimeControlAction,
  RuntimeControlExecutionRequest,
  RuntimeControlRequest,
  RuntimeReloadMode
} from './runtimeControl.js';

interface WorkerControlRequestMessage {
  type: 'worker.control.request';
  requestId: string;
  action: RuntimeControlAction;
  mode?: RuntimeReloadMode;
  accepting?: boolean;
  threadId?: string;
  reason: string;
  requestedBy: RuntimeActorIdentity;
}

interface WorkerLifecycleReadyMessage {
  type: 'worker.lifecycle.ready';
}

interface WorkerManagementReadyMessage {
  type: 'worker.management.ready';
  url: string | null;
  accessUrl: string | null;
}

interface WorkerLifecycleStartFailedMessage {
  type: 'worker.lifecycle.start_failed';
  detail: string;
}

interface WorkerControlResponseMessage {
  type: 'worker.control.response';
  requestId: string;
  accepted: boolean;
  detail: string;
}

interface SupervisorControlExecuteMessage {
  type: 'supervisor.control.execute';
  requestId: string;
  action: Exclude<RuntimeControlAction, 'reload'>;
  accepting?: boolean;
  threadId?: string;
  reason: string;
  requestedBy: RuntimeActorIdentity;
}

interface WorkerControlExecutedMessage {
  type: 'worker.control.executed';
  requestId: string;
  accepted: boolean;
  detail: string;
}

interface SupervisorShutdownMessage {
  type: 'supervisor.shutdown';
  mode: RuntimeReloadMode;
  timeoutMs: number;
}

type RuntimeSupervisorMessage =
  | WorkerManagementReadyMessage
  | WorkerLifecycleReadyMessage
  | WorkerLifecycleStartFailedMessage
  | WorkerControlRequestMessage
  | WorkerControlResponseMessage
  | SupervisorControlExecuteMessage
  | WorkerControlExecutedMessage
  | SupervisorShutdownMessage;

type ProcessSignal = Parameters<typeof process.kill>[1];

interface RuntimeSupervisorOptions {
  entrypoint: string;
  configPath: string;
  execArgv?: string[];
  shutdownTimeoutMs?: number;
  readyTimeoutMs?: number;
  staleWorkerCleanup?: RuntimeStaleWorkerCleanupOptions;
}

export interface RuntimeStaleWorkerProcess {
  pid: number;
  argv: string[];
}

export interface RuntimeStaleWorkerCleanupOptions {
  findWorkers?: (input: { configPath: string }) => Promise<RuntimeStaleWorkerProcess[]>;
  signalProcess?: (pid: number, signal: ProcessSignal) => void;
  isProcessAlive?: (pid: number) => boolean;
  waitMs?: number;
}

interface WorkerStartupState {
  active: boolean;
  ready: boolean;
  suppressRestartUntilReady: boolean;
  managementUrl?: string | null;
  managementAccessUrl?: string | null;
  resolve?: () => void;
  reject?: (error: Error) => void;
  timer?: ReturnType<typeof globalThis.setTimeout>;
}

export class RuntimeSupervisor {
  private worker: ChildProcess | null = null;
  private controlTail: Promise<void> = Promise.resolve();
  private stopping = false;
  private restarting = false;
  private readonly forwarded = new Map<string, ChildProcess>();
  private readonly startupStates = new Map<ChildProcess, WorkerStartupState>();

  constructor(private readonly options: RuntimeSupervisorOptions) {}

  async start(): Promise<{ url: string | null; accessUrl: string | null }> {
    if (this.worker) {
      const startup = this.startupStates.get(this.worker);
      return {
        url: startup?.managementUrl ?? null,
        accessUrl: startup?.managementAccessUrl ?? null
      };
    }
    const worker = await this.startWorker({ waitForReady: true, suppressRestartUntilReady: true, active: true });
    const startup = this.startupStates.get(worker);
    return {
      url: startup?.managementUrl ?? null,
      accessUrl: startup?.managementAccessUrl ?? null
    };
  }

  async stop(mode: RuntimeReloadMode = 'graceful'): Promise<void> {
    this.stopping = true;
    if (!this.worker) {
      return;
    }
    await this.shutdownWorker(mode, this.options.shutdownTimeoutMs ?? 30_000);
    this.worker = null;
  }

  private async restart(mode: RuntimeReloadMode): Promise<void> {
    if (this.restarting) {
      return;
    }
    this.restarting = true;
    try {
      if (this.worker) {
        await this.shutdownWorker(mode, this.options.shutdownTimeoutMs ?? 30_000);
      }
      this.worker = null;
      if (!this.stopping) {
        await this.startWorker({ waitForReady: true, suppressRestartUntilReady: true, active: true });
      }
    } finally {
      this.restarting = false;
    }
  }

  private async startWorker(options: {
    waitForReady?: boolean;
    suppressRestartUntilReady?: boolean;
    active?: boolean;
  } = {}): Promise<ChildProcess> {
    await cleanupStaleRuntimeWorkers({
      configPath: this.options.configPath,
      excludePids: [
        process.pid,
        ...[...this.startupStates.keys()]
          .map((child) => child.pid)
          .filter((pid): pid is number => typeof pid === 'number')
      ],
      ...(this.options.staleWorkerCleanup ?? {})
    });
    const child = fork(this.options.entrypoint, ['worker-run', '--config', this.options.configPath], {
      execArgv: this.options.execArgv ?? process.execArgv,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });
    if (options.active !== false) {
      this.worker = child;
    }
    let readyPromise = Promise.resolve();
    if (options.waitForReady) {
      readyPromise = new Promise<void>((resolve, reject) => {
        const timer = globalThis.setTimeout(() => {
          this.failWorkerStartup(child, 'Runtime worker did not become ready before the startup timeout elapsed.');
          if (child.exitCode === null && !child.killed) {
            child.kill('SIGTERM');
          }
        }, this.options.readyTimeoutMs ?? 30_000);
        this.startupStates.set(child, {
          active: options.active !== false,
          ready: false,
          suppressRestartUntilReady: options.suppressRestartUntilReady === true,
          resolve,
          reject,
          timer
        });
      });
    } else {
      this.startupStates.set(child, {
        active: options.active !== false,
        ready: false,
        suppressRestartUntilReady: options.suppressRestartUntilReady === true
      });
    }
    child.on('message', (message: RuntimeSupervisorMessage) => {
      void this.handleMessage(child, message);
    });
    child.on('exit', () => {
      const startup = this.startupStates.get(child);
      const wasActive = startup?.active === true;
      if (startup && !startup.ready) {
        this.failWorkerStartup(child, 'Runtime worker exited before becoming ready.');
      }
      this.failForwardedRequestsForWorker(child, 'Runtime worker exited before control request completed.');
      if (this.worker === child) {
        this.worker = null;
      }
      const suppressRestart = startup?.suppressRestartUntilReady === true && startup.ready !== true;
      this.startupStates.delete(child);
      if (wasActive && !this.stopping && !this.restarting && !suppressRestart) {
        void this.startWorker({ waitForReady: true, suppressRestartUntilReady: true, active: true }).catch((error: unknown) => {
          globalThis.console.error(
            `[moorline] worker restart failed before the replacement became ready: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }
    });
    await readyPromise;
    return child;
  }

  private failForwardedRequestsForWorker(child: ChildProcess, detail: string): void {
    for (const [requestId, requester] of [...this.forwarded.entries()]) {
      if (requester !== child) {
        continue;
      }
      this.forwarded.delete(requestId);
      try {
        requester.send?.({
          type: 'worker.control.response',
          requestId,
          accepted: false,
          detail
        } satisfies WorkerControlResponseMessage);
      } catch {
        // The requester may already be disconnected; cleanup still completed.
      }
    }
  }

  private async handleMessage(child: ChildProcess, message: RuntimeSupervisorMessage): Promise<void> {
    if (message.type === 'worker.management.ready') {
      const startup = this.startupStates.get(child);
      if (startup) {
        startup.managementUrl = message.url;
        startup.managementAccessUrl = message.accessUrl;
      }
      return;
    }

    if (message.type === 'worker.lifecycle.ready') {
      this.markWorkerReady(child);
      return;
    }

    if (message.type === 'worker.lifecycle.start_failed') {
      this.failWorkerStartup(child, message.detail);
      return;
    }

    if (message.type === 'worker.control.executed') {
      const requester = this.forwarded.get(message.requestId);
      this.forwarded.delete(message.requestId);
      requester?.send({
        type: 'worker.control.response',
        requestId: message.requestId,
        accepted: message.accepted,
        detail: message.detail
      } satisfies WorkerControlResponseMessage);
      return;
    }

    if (message.type !== 'worker.control.request') {
      return;
    }

    if (message.action === 'reload') {
      this.controlTail = this.controlTail.then(async () => {
        await this.reloadWorker(child, message);
      });
      await this.controlTail;
      return;
    }

    this.forwarded.set(message.requestId, child);
    child.send({
      type: 'supervisor.control.execute',
      requestId: message.requestId,
      action: message.action,
      ...(message.accepting === undefined ? {} : { accepting: message.accepting }),
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      reason: message.reason,
      requestedBy: message.requestedBy
    } satisfies SupervisorControlExecuteMessage);
  }

  private async reloadWorker(child: ChildProcess, message: WorkerControlRequestMessage): Promise<void> {
    const mode = message.mode ?? 'graceful';
    let replacement: ChildProcess | null = null;

    this.restarting = true;
    try {
      replacement = await this.startWorker({ waitForReady: true, suppressRestartUntilReady: true, active: false });
      this.setWorkerActive(child, false);
      this.setWorkerActive(replacement, true);
      child.send({
        type: 'worker.control.response',
        requestId: message.requestId,
        accepted: true,
        detail: `Runtime ${mode} reload completed. Replacement worker is ready.`
      } satisfies WorkerControlResponseMessage);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      child.send({
        type: 'worker.control.response',
        requestId: message.requestId,
        accepted: false,
        detail: `Runtime ${mode} reload failed: ${detail}`
      } satisfies WorkerControlResponseMessage);
      return;
    } finally {
      this.restarting = false;
    }

    if (child.exitCode !== null || child.killed) {
      return;
    }

    try {
      await this.shutdownWorker(mode, this.options.shutdownTimeoutMs ?? 30_000, child);
    } catch (error) {
      globalThis.console.error(
        `[moorline] previous worker did not shut down cleanly after reload: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async shutdownWorker(mode: RuntimeReloadMode, timeoutMs: number, child = this.worker): Promise<void> {
    if (!child) {
      return;
    }

    const waited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    child.send({
      type: 'supervisor.shutdown',
      mode,
      timeoutMs
    } satisfies SupervisorShutdownMessage);

    const timeout = new Promise<void>((resolve) => {
      globalThis.setTimeout(() => resolve(), timeoutMs);
    });
    await Promise.race([waited, timeout]);

    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await Promise.race([
        waited,
        new Promise<void>((resolve) => {
          globalThis.setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL');
            }
            resolve();
          }, 5_000);
        })
      ]);
    }
  }

  private setWorkerActive(child: ChildProcess, active: boolean): void {
    const startup = this.startupStates.get(child);
    if (!startup) {
      return;
    }
    startup.active = active;
    if (active) {
      this.worker = child;
    } else if (this.worker === child) {
      this.worker = null;
    }
  }

  private markWorkerReady(child: ChildProcess): void {
    const startup = this.startupStates.get(child);
    if (!startup || startup.ready) {
      return;
    }
    startup.ready = true;
    startup.suppressRestartUntilReady = false;
    if (startup.timer) {
      globalThis.clearTimeout(startup.timer);
      startup.timer = undefined;
    }
    startup.resolve?.();
    startup.resolve = undefined;
    startup.reject = undefined;
  }

  private failWorkerStartup(child: ChildProcess, detail: string): void {
    const startup = this.startupStates.get(child);
    if (!startup || startup.ready) {
      return;
    }
    if (startup.timer) {
      globalThis.clearTimeout(startup.timer);
      startup.timer = undefined;
    }
    const reject = startup.reject;
    startup.resolve = undefined;
    startup.reject = undefined;
    reject?.(new Error(detail));
  }
}

export async function cleanupStaleRuntimeWorkers(input: {
  configPath: string;
  excludePids?: number[];
} & RuntimeStaleWorkerCleanupOptions): Promise<number[]> {
  const excluded = new Set([process.pid, ...(input.excludePids ?? [])]);
  const findWorkers = input.findWorkers ?? findLinuxRuntimeWorkers;
  const signalProcess = input.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  const isProcessAlive = input.isProcessAlive ?? ((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const staleWorkers = (await findWorkers({ configPath: input.configPath })).filter((worker) => !excluded.has(worker.pid));
  const killed: number[] = [];
  for (const worker of staleWorkers) {
    try {
      signalProcess(worker.pid, 'SIGTERM');
      killed.push(worker.pid);
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code !== 'ESRCH') {
        globalThis.console.warn(`[moorline] failed to terminate stale worker ${worker.pid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (killed.length > 0) {
    await new Promise<void>((resolveDelay) => {
      globalThis.setTimeout(resolveDelay, input.waitMs ?? 500);
    });
  }
  for (const pid of killed) {
    if (!isProcessAlive(pid)) {
      continue;
    }
    try {
      signalProcess(pid, 'SIGKILL');
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code !== 'ESRCH') {
        globalThis.console.warn(`[moorline] failed to kill stale worker ${pid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return killed;
}

async function findLinuxRuntimeWorkers(input: { configPath: string }): Promise<RuntimeStaleWorkerProcess[]> {
  if (process.platform !== 'linux') {
    return [];
  }
  const expectedConfigPath = resolve(input.configPath);
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return [];
  }
  const workers: RuntimeStaleWorkerProcess[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) {
        return;
      }
      const pid = Number.parseInt(entry, 10);
      let raw: Buffer;
      try {
        raw = await readFile(`/proc/${entry}/cmdline`);
      } catch {
        return;
      }
      const argv = raw
        .toString('utf8')
        .split('\0')
        .filter((value) => value.length > 0);
      if (!argv.includes('worker-run')) {
        return;
      }
      const configIndex = argv.indexOf('--config');
      if (configIndex === -1 || !argv[configIndex + 1]) {
        return;
      }
      if (resolve(argv[configIndex + 1]) !== expectedConfigPath) {
        return;
      }
      workers.push({ pid, argv });
    })
  );
  return workers;
}

interface WorkerControlBridgeProcessRef {
  on(event: 'message', listener: (message: RuntimeSupervisorMessage) => void): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
  on(event: 'exit', listener: () => void): unknown;
  send?: (message: RuntimeSupervisorMessage) => boolean;
}

export function createWorkerControlBridge(input: {
  requestTimeoutMs?: number;
  processRef?: WorkerControlBridgeProcessRef;
} = {}): {
  requestControl(input: RuntimeControlRequest): Promise<{ accepted: boolean; detail: string }>;
  attachShutdownHandler(handler: (input: { mode: RuntimeReloadMode; timeoutMs: number }) => Promise<void>): void;
  attachControlHandler(handler: (input: RuntimeControlExecutionRequest) => Promise<{ accepted: boolean; detail: string }>): void;
} {
  const CONTROL_REQUEST_TIMEOUT_MS = input.requestTimeoutMs ?? 30_000;
  const processRef = (input.processRef ?? process) as WorkerControlBridgeProcessRef;
  const pending = new Map<
    string,
    {
      resolve(value: { accepted: boolean; detail: string }): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof globalThis.setTimeout>;
    }
  >();

  const rejectPending = (requestId: string, reason: string): void => {
    const entry = pending.get(requestId);
    if (!entry) {
      return;
    }
    pending.delete(requestId);
    globalThis.clearTimeout(entry.timeout);
    entry.reject(new Error(reason));
  };

  const rejectAllPending = (reason: string): void => {
    for (const requestId of [...pending.keys()]) {
      rejectPending(requestId, reason);
    }
  };

  processRef.on('message', (message: RuntimeSupervisorMessage) => {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type !== 'worker.control.response') {
      return;
    }
    const entry = pending.get(message.requestId);
    if (!entry) {
      return;
    }
    pending.delete(message.requestId);
    globalThis.clearTimeout(entry.timeout);
    entry.resolve({
      accepted: message.accepted,
      detail: message.detail
    });
  });
  processRef.on('disconnect', () => {
    rejectAllPending('Runtime supervisor disconnected before control response arrived.');
  });
  processRef.on('exit', () => {
    rejectAllPending('Runtime process exited before control response arrived.');
  });

  return {
    requestControl: async (input) => {
      if (typeof processRef.send !== 'function') {
        return {
          accepted: false,
          detail: 'No runtime supervisor is attached.'
        };
      }
      const requestId = randomUUID();
      const result = await new Promise<{ accepted: boolean; detail: string }>((resolve, reject) => {
        const timeout = globalThis.setTimeout(() => {
          rejectPending(requestId, `Runtime supervisor did not respond to control request within ${CONTROL_REQUEST_TIMEOUT_MS}ms.`);
        }, CONTROL_REQUEST_TIMEOUT_MS);
        pending.set(requestId, { resolve, reject, timeout });
        try {
          const sent = processRef.send?.({
            type: 'worker.control.request',
            requestId,
            action: input.action,
            ...(input.action === 'reload' ? { mode: input.mode } : {}),
            ...(input.action === 'set-accepting' ? { accepting: input.accepting } : {}),
            ...('threadId' in input && input.threadId !== undefined ? { threadId: input.threadId } : {}),
            reason: input.reason,
            requestedBy: input.requestedBy
          } satisfies WorkerControlRequestMessage);
          if (sent === false) {
            rejectPending(
              requestId,
              'Runtime supervisor could not accept the control request (IPC backpressure). Try again.'
            );
          }
        } catch (error) {
          rejectPending(
            requestId,
            `Runtime supervisor control request failed before dispatch: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      });
      return result;
    },
    attachShutdownHandler: (handler) => {
      processRef.on('message', (message: RuntimeSupervisorMessage) => {
        if (!message || typeof message !== 'object') {
          return;
        }
        if (message.type !== 'supervisor.shutdown') {
          return;
        }
        void handler({
          mode: message.mode,
          timeoutMs: message.timeoutMs
        });
      });
    },
    attachControlHandler: (handler) => {
      processRef.on('message', (message: RuntimeSupervisorMessage) => {
        if (!message || typeof message !== 'object') {
          return;
        }
        if (message.type !== 'supervisor.control.execute') {
          return;
        }
        void handler(
          message.action === 'set-accepting'
            ? {
                action: 'set-accepting',
                accepting: message.accepting === true,
                reason: message.reason,
                requestedBy: message.requestedBy
              }
            : {
                action: message.action,
                ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
                reason: message.reason,
                requestedBy: message.requestedBy
              }
        )
          .then((result) => {
            processRef.send?.({
              type: 'worker.control.executed',
              requestId: message.requestId,
              accepted: result.accepted,
              detail: result.detail
            } satisfies WorkerControlExecutedMessage);
          })
          .catch((error: unknown) => {
            processRef.send?.({
              type: 'worker.control.executed',
              requestId: message.requestId,
              accepted: false,
              detail: error instanceof Error ? error.message : String(error)
            } satisfies WorkerControlExecutedMessage);
          });
      });
    }
  };
}
