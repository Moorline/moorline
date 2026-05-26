import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

interface ControlApiBootstrapRecord {
  version: 1;
  protocol: 'http';
  adapterPackageId: string;
  pid: number;
  url: string;
  token: string;
  startedAt: string;
  configPath: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function defaultMoorlineHomePath(): string {
  const override = process.env.MOORLINE_HOME?.trim();
  return resolve(override || homedir(), override ? '.' : '.moorline');
}

export function resolveControlApiConfigPath(customPath?: string): string {
  return customPath ? resolve(customPath) : resolve(defaultMoorlineHomePath(), 'config.json');
}

function runtimeRootForConfigPath(configPath: string): string {
  if (!existsSync(configPath)) {
    return resolve(defaultMoorlineHomePath(), 'runtime');
  }
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { runtimeRoot?: unknown };
  if (typeof parsed.runtimeRoot !== 'string' || parsed.runtimeRoot.trim().length === 0) {
    return resolve(defaultMoorlineHomePath(), 'runtime');
  }
  return resolve(parsed.runtimeRoot);
}

function controlApiStateDir(configPath: string): string {
  return join(runtimeRootForConfigPath(configPath), 'state');
}

function controlApiBootstrapPath(configPath?: string): string {
  return join(controlApiStateDir(resolveControlApiConfigPath(configPath)), 'control-api-bootstrap.json');
}

export function readControlApiBootstrapRecord(configPath?: string): ControlApiBootstrapRecord | null {
  const path = controlApiBootstrapPath(configPath);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ControlApiBootstrapRecord>;
    if (
      typeof parsed.pid !== 'number' ||
      parsed.version !== 1 ||
      parsed.protocol !== 'http' ||
      typeof parsed.adapterPackageId !== 'string' ||
      typeof parsed.url !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.configPath !== 'string'
    ) {
      return null;
    }
    return {
      version: 1,
      protocol: 'http',
      adapterPackageId: parsed.adapterPackageId,
      pid: parsed.pid,
      url: parsed.url,
      token: parsed.token,
      startedAt: parsed.startedAt,
      configPath: parsed.configPath
    };
  } catch {
    return null;
  }
}

export function writeControlApiBootstrapRecord(record: ControlApiBootstrapRecord): void {
  const path = controlApiBootstrapPath(record.configPath);
  mkdirSync(controlApiStateDir(record.configPath), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

export function clearControlApiBootstrapRecord(configPath?: string): void {
  rmSync(controlApiBootstrapPath(configPath), { force: true });
}

async function isAuthenticated(url: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/state/configure`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class ApiBootstrapResolver {
  constructor(
    private readonly input: {
      configPath?: string;
      entrypoint?: string;
    }
  ) {}

  async resolveConnection(input: {
    url?: string;
    token?: string;
    configPath?: string;
    autoStart?: boolean;
  } = {}): Promise<{ url: string; token: string; configPath: string }> {
    const configPath = resolveControlApiConfigPath(input.configPath ?? this.input.configPath);
    const url = input.url ?? process.env.MOORLINE_API_URL;
    const token = input.token ?? process.env.MOORLINE_API_TOKEN;
    if (url && token) {
      return { url, token, configPath };
    }
    if (url && !token) {
      throw new Error('Control API token is required when using a remote --url or MOORLINE_API_URL.');
    }

    const record = readControlApiBootstrapRecord(configPath);
    if (record && (await isAuthenticated(record.url, record.token))) {
      return {
        url: record.url,
        token: record.token,
        configPath
      };
    }

    const shouldAutoStart = input.autoStart ?? false;
    if (!shouldAutoStart) {
      throw new Error('Control API is not available. Start it with `moorline api start` or provide --url and --token.');
    }
    if (!this.input.entrypoint) {
      throw new Error('Control API auto-start requires a Moorline CLI entrypoint.');
    }

    const started = await this.startLocalApiInBackground(configPath);
    return {
      url: started.url,
      token: started.token,
      configPath
    };
  }

  async startLocalApiInBackground(configPath = resolveControlApiConfigPath(this.input.configPath)): Promise<ControlApiBootstrapRecord> {
    const existing = readControlApiBootstrapRecord(configPath);
    if (existing && (await isAuthenticated(existing.url, existing.token))) {
      return existing;
    }

    if (!this.input.entrypoint) {
      throw new Error('Control API auto-start requires a Moorline CLI entrypoint.');
    }
    const child = spawn(process.execPath, [this.input.entrypoint, 'api-run-foreground', '--config', configPath], {
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();

    const timeoutAt = Date.now() + 20_000;
    while (Date.now() < timeoutAt) {
      const record = readControlApiBootstrapRecord(configPath);
      if (record && (await isAuthenticated(record.url, record.token))) {
        return record;
      }
      await sleep(250);
    }

    throw new Error('Timed out waiting for the Control API to start.');
  }
}
