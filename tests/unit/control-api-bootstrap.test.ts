import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiBootstrapResolver,
  readControlApiBootstrapRecord,
  writeControlApiBootstrapRecord
} from '../../packages/control-api/src/bootstrap.js';
import { createTempRoot } from '../helpers/temp.js';

const originalMoorlineHome = process.env.MOORLINE_HOME;

afterEach(() => {
  if (originalMoorlineHome === undefined) {
    delete process.env.MOORLINE_HOME;
  } else {
    process.env.MOORLINE_HOME = originalMoorlineHome;
  }
  vi.restoreAllMocks();
});

function writeConfig(root: string): string {
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, `${JSON.stringify({ runtimeRoot }, null, 2)}\n`, 'utf8');
  return configPath;
}

describe('Control API bootstrap records', () => {
  it('writes local connection records with owner-only permissions', () => {
    const root = createTempRoot('moorline-bootstrap-mode-');
    const configPath = writeConfig(root);

    writeControlApiBootstrapRecord({
      version: 1,
      protocol: 'http',
      adapterPackageId: 'official/http',
      pid: 123,
      url: 'http://127.0.0.1:45173',
      token: 'secret',
      configPath,
      startedAt: '2026-05-20T00:00:00.000Z'
    });

    const mode = statSync(join(root, 'runtime', 'state', 'control-api-bootstrap.json')).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readControlApiBootstrapRecord(configPath)).toMatchObject({
      token: 'secret'
    });
  });

  it('authenticates stored bootstrap records before reusing them', async () => {
    const root = createTempRoot('moorline-bootstrap-auth-');
    const configPath = writeConfig(root);
    writeControlApiBootstrapRecord({
      version: 1,
      protocol: 'http',
      adapterPackageId: 'official/http',
      pid: 123,
      url: 'http://127.0.0.1:45173',
      token: 'stale-token',
      configPath,
      startedAt: '2026-05-20T00:00:00.000Z'
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401
    } as Awaited<ReturnType<typeof fetch>>);

    const resolver = new ApiBootstrapResolver({
      configPath,
      entrypoint: process.execPath
    });

    await expect(resolver.resolveConnection({ autoStart: false })).rejects.toThrow(/Control API is not available/);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:45173/api/state/configure', {
      headers: {
        authorization: 'Bearer stale-token'
      }
    });
  });

  it('does not auto-start by default for SDK callers', async () => {
    const root = createTempRoot('moorline-bootstrap-no-default-autostart-');
    const configPath = writeConfig(root);
    const resolver = new ApiBootstrapResolver({
      configPath,
      entrypoint: process.execPath
    });

    await expect(resolver.resolveConnection()).rejects.toThrow(/Control API is not available/);
  });

  it('reuses stored bootstrap records only when the bearer token is accepted', async () => {
    const root = createTempRoot('moorline-bootstrap-auth-ok-');
    const configPath = writeConfig(root);
    writeControlApiBootstrapRecord({
      version: 1,
      protocol: 'http',
      adapterPackageId: 'official/http',
      pid: 123,
      url: 'http://127.0.0.1:45173/',
      token: 'fresh-token',
      configPath,
      startedAt: '2026-05-20T00:00:00.000Z'
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true
    } as Awaited<ReturnType<typeof fetch>>);

    const resolver = new ApiBootstrapResolver({
      configPath,
      entrypoint: process.execPath
    });

    await expect(resolver.resolveConnection({ autoStart: false })).resolves.toMatchObject({
      url: 'http://127.0.0.1:45173/',
      token: 'fresh-token',
      configPath
    });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:45173/api/state/configure', {
      headers: {
        authorization: 'Bearer fresh-token'
      }
    });
  });
});
