import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: string | null;
}

export interface CommandRunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: string | CommandRunOptions): Promise<CommandResult>;
}

interface ExecFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

export class ChildProcessRunner implements CommandRunner {
  async run(command: string, args: string[], options: string | CommandRunOptions = {}): Promise<CommandResult> {
    const normalized: CommandRunOptions = typeof options === 'string' ? { cwd: options } : options;
    const timeoutMs = normalized.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    try {
      const result = await execFileAsync(command, args, {
        cwd: normalized.cwd,
        env: normalized.env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 8,
        timeout: timeoutMs,
        killSignal: 'SIGTERM'
      });

      return {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr
      };
    } catch (error) {
      const failure = error as ExecFailure;

      if (typeof failure.code === 'string' && failure.code === 'ENOENT') {
        return {
          exitCode: 127,
          stdout: '',
          stderr: `${command} not found`
        };
      }

      if (failure.killed === true && (failure.signal === 'SIGTERM' || failure.code === 'ETIMEDOUT')) {
        return {
          exitCode: 124,
          stdout: failure.stdout ?? '',
          stderr: `Command timed out after ${timeoutMs}ms: ${command}`,
          timedOut: true,
          signal: failure.signal ?? null
        };
      }

      return {
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? failure.message,
        signal: failure.signal ?? null
      };
    }
  }
}
