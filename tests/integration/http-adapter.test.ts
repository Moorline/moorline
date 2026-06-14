import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultAdminConfig,
  defaultHttpApiAdapterConfig,
  defaultMainProcessConfig,
  defaultSurfaceNames,
  type MoorlineConfig
} from '../../packages/core/src/types/config.js';
import { saveMoorlineConfig } from '../../packages/core/src/core/system/config/configStore.js';
import { readControlApiBootstrapRecord } from '../../packages/control-api/src/bootstrap.js';
import { createTempRoot } from '../helpers/temp.js';

const controlPlaneState = vi.hoisted(() => ({
  backupPath: '',
  importBytes: 0,
  importError: null as Error | null,
  directSessionError: null as Error | null,
  accepting: null as boolean | null,
  leaseCounter: 0,
  starts: 0,
  stops: 0,
  stopGate: null as Promise<void> | null
}));

vi.mock('@moorline/core/app/control-api/services/controlPlane.js', () => ({
  ControlPlane: class {
    async start() {
      controlPlaneState.starts += 1;
    }
    async stop() {
      controlPlaneState.stops += 1;
      if (controlPlaneState.stopGate) {
        await controlPlaneState.stopGate;
      }
    }
    mode() {
      return 'management';
    }
    readModel() {
      return {
        generatedAt: '2026-05-20T00:00:00.000Z',
        session: {},
        controls: [],
        objects: [],
        packages: {
          installed: [],
          applyPlan: { operations: [], errors: [] }
        },
        configure: {
          packages: {
            installed: [],
            applyPlan: { operations: [], errors: [] }
          },
          history: {
            status: {},
            entries: []
          }
        },
        operations: {
          pendingRequests: []
        }
      };
    }
    async setAcceptingNewWork(accepting: boolean) {
      controlPlaneState.accepting = accepting;
      return { accepting };
    }
    async createLease(input: { client: string; policy: string; ttlMs?: number }) {
      controlPlaneState.leaseCounter += 1;
      return {
        leaseId: `lease-${controlPlaneState.leaseCounter}`,
        client: input.client,
        policy: input.policy,
        ttlMs: input.ttlMs ?? null
      };
    }
    async heartbeatLease(input: { leaseId: string; ttlMs?: number }) {
      return { leaseId: input.leaseId, ttlMs: input.ttlMs ?? null };
    }
    async releaseLease(leaseId: string) {
      return { leaseId, released: true };
    }
    async createBackupArchive() {
      return {
        archivePath: controlPlaneState.backupPath,
        filename: 'moorline-backup.tar.gz'
      };
    }
    async importBackupArchive(input: { archiveBytes: Buffer; force: boolean }) {
      if (controlPlaneState.importError) {
        throw controlPlaneState.importError;
      }
      controlPlaneState.importBytes = input.archiveBytes.byteLength;
      return {
        imported: true,
        force: input.force,
        bytes: input.archiveBytes.byteLength
      };
    }
    async directSession() {
      if (controlPlaneState.directSessionError) {
        throw controlPlaneState.directSessionError;
      }
      return { directed: true };
    }
  }
}));

async function importServer() {
  return await import('../../packages/http/src/server.js');
}

async function importHttpAdapter() {
  return await import('../../packages/http/src/index.js');
}

function writeConfig(root: string, apiConfig: Record<string, unknown> = defaultHttpApiAdapterConfig()): string {
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  const surface = defaultSurfaceNames();
  const config: MoorlineConfig = {
    version: 4,
    runtimeRoot,
    admin: defaultAdminConfig(),
    main: defaultMainProcessConfig(),
    defaults: {
      runtimeMode: 'full-access',
      model: 'latest'
    },
    surface: surface,
    setup: {
      completed: false
    },
    surfaces: {
      apiAdapter: {
        activePackageId: 'moorline/http',
        config: apiConfig,
        configByPackageId: {}
      },
      transport: {
        activePackageId: null,
        config: {},
        configByPackageId: {}
      },
      provider: {
        activePackageId: null,
        config: {},
        configByPackageId: {}
      },
      plugins: {
        enabledPackageIds: [],
        configByPackageId: {}
      },
      skills: {
        enabledPackageIds: [],
        configByPackageId: {}
      }
    }
  };
  const configPath = join(root, 'config.json');
  saveMoorlineConfig(config, configPath);
  return configPath;
}

async function readJson(response: Awaited<ReturnType<typeof fetch>>): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function waitForFetchFailure(url: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer().catch(() => undefined);
    } catch {
      return;
    }
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 25);
    });
  }
  throw new Error(`Endpoint still accepted requests: ${url}`);
}

function createFakeJsonResponse(): {
  response: {
    writeHead(statusCode: number, headers: Record<string, string>): void;
    end(chunk?: string | Buffer): void;
    statusCode: number;
    headers: Record<string, string>;
  };
  json(): Record<string, unknown>;
} {
  const responseBody: Buffer[] = [];
  return {
    response: {
      writeHead(statusCode: number, headers: Record<string, string>) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(chunk?: string | Buffer) {
        if (chunk) {
          responseBody.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      },
      statusCode: 0,
      headers: {}
    },
    json() {
      return JSON.parse(Buffer.concat(responseBody).toString('utf8')) as Record<string, unknown>;
    }
  };
}

async function dispatchFakeRequest(
  server: unknown,
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
  },
  response: unknown
): Promise<void> {
  await (server as {
    handle(request: unknown, response: unknown): Promise<void>;
  }).handle(request, response);
}

describe('HTTP API adapter behavior', () => {
  let previousToken: string | undefined;

  beforeEach(() => {
    previousToken = process.env.MOORLINE_API_TOKEN;
    process.env.MOORLINE_API_TOKEN = 'test-token';
    controlPlaneState.backupPath = '';
    controlPlaneState.importBytes = 0;
    controlPlaneState.importError = null;
    controlPlaneState.accepting = null;
    controlPlaneState.leaseCounter = 0;
    controlPlaneState.starts = 0;
    controlPlaneState.stops = 0;
    controlPlaneState.stopGate = null;
  });

  afterEach(() => {
    if (previousToken === undefined) {
      delete process.env.MOORLINE_API_TOKEN;
    } else {
      process.env.MOORLINE_API_TOKEN = previousToken;
    }
  });

  it('starts from the required runtime adapter config without a config file', async () => {
    const { createAdapter } = await importHttpAdapter();
    const adapter = createAdapter({
      host: '127.0.0.1',
      port: 0,
      config: {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        exposure: 'loopback',
        auth: {
          mode: 'bearer'
        },
        tls: {
          enabled: false
        }
      },
      entrypoint: process.execPath
    });
    const started = await adapter.start();
    try {
      expect(started.endpoints).toHaveLength(1);
      expect(started.endpoints[0]).toMatchObject({
        protocol: 'http',
        token: 'test-token',
        metadata: {
          adapterPackageId: 'moorline/http'
        }
      });
      const health = await fetch(`${started.endpoints[0]?.url}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await adapter.stop();
    }
  });

  it('serves health without auth and rejects API calls without the bearer token', async () => {
    const root = createTempRoot('moorline-http-auth-');
    const { ControlApiServer } = await importServer();
    const server = new ControlApiServer({
      host: '127.0.0.1',
      port: 0,
      configPath: writeConfig(root),
      entrypoint: process.execPath
    });
    await server.start();
    try {
      const health = await fetch(`${server.getUrl()}/healthz`);
      expect(health.status).toBe(200);
      expect(await readJson(health)).toMatchObject({ ok: true, tokenAvailable: true });

      const unauthenticated = await fetch(`${server.getUrl()}/api/state`);
      expect(unauthenticated.status).toBe(401);

      const authenticated = await fetch(`${server.getUrl()}/api/runtime/accepting`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ accepting: true })
      });
      expect(authenticated.status).toBe(200);
      expect(await readJson(authenticated)).toMatchObject({ accepting: true });
    } finally {
      await server.stop();
    }
  });

  it('stops the control plane when HTTP listen fails', async () => {
    const root = createTempRoot('moorline-http-listen-fail-');
    const { ControlApiServer } = await importServer();
    const server = new ControlApiServer({
      host: '203.0.113.1',
      port: 45173,
      configPath: writeConfig(root, {
        ...defaultHttpApiAdapterConfig(),
        host: '203.0.113.1',
        exposure: 'remote'
      }),
      entrypoint: process.execPath
    });

    await expect(server.start()).rejects.toThrow();
    expect(controlPlaneState.starts).toBe(1);
    expect(controlPlaneState.stops).toBe(1);
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('closes the HTTP listener before awaiting a slow control plane stop', async () => {
    const root = createTempRoot('moorline-http-stop-order-');
    const { ControlApiServer } = await importServer();
    const server = new ControlApiServer({
      host: '127.0.0.1',
      port: 0,
      configPath: writeConfig(root),
      entrypoint: process.execPath
    });
    let releaseStop!: () => void;
    controlPlaneState.stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });

    await server.start();
    const url = server.getUrl();
    expect(url).toBeTruthy();
    const stopPromise = server.stop();
    await waitForFetchFailure(`${url}/healthz`);
    expect(controlPlaneState.stops).toBe(1);
    releaseStop();
    await expect(stopPromise).resolves.toBeUndefined();
  });

  it('dispatches JSON API routes and lease commands', async () => {
    const root = createTempRoot('moorline-http-routes-');
    const { ControlApiServer } = await importServer();
    const server = new ControlApiServer({
      host: '127.0.0.1',
      port: 0,
      configPath: writeConfig(root),
      entrypoint: process.execPath
    });
    await server.start();
    try {
      const accepting = await fetch(`${server.getUrl()}/api/runtime/accepting`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ accepting: false })
      });
      expect(accepting.status).toBe(200);
      expect(controlPlaneState.accepting).toBe(false);

      const lease = await fetch(`${server.getUrl()}/api/leases/create`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ client: 'test-client', policy: 'stop_on_last_lease', ttlMs: 1000 })
      });
      expect(lease.status).toBe(200);
      expect(await readJson(lease)).toMatchObject({
        leaseId: 'lease-1',
        client: 'test-client',
        policy: 'stop_on_last_lease',
        ttlMs: 1000
      });

      const invalidLease = await fetch(`${server.getUrl()}/api/leases/create`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ client: 'test-client', policy: 'stopOnLastLease' })
      });
      expect(invalidLease.status).toBe(422);
      expect(await readJson(invalidLease)).toMatchObject({
        error: 'policy must be "detached" or "stop_on_last_lease" when provided.'
      });
    } finally {
      await server.stop();
    }
  });

  it('handles binary backup export and import routes', async () => {
    const root = createTempRoot('moorline-http-binary-');
    controlPlaneState.backupPath = join(root, 'backup.tar.gz');
    writeFileSync(controlPlaneState.backupPath, Buffer.from([1, 2, 3, 4]));
    const { ControlApiServer } = await importServer();
    const configPath = writeConfig(root);
    const server = new ControlApiServer({
      host: '127.0.0.1',
      port: 0,
      configPath,
      entrypoint: process.execPath
    });
    await server.start();
    try {
      const backup = await fetch(`${server.getUrl()}/api/management/backup`, {
        headers: {
          authorization: 'Bearer test-token'
        }
      });
      expect(backup.status).toBe(200);
      expect(backup.headers.get('content-type')).toBe('application/gzip');
      expect(new Uint8Array(await backup.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));

      const imported = await fetch(`${server.getUrl()}/api/management/import?force=1`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token'
        },
        body: Buffer.from([9, 8, 7])
      });
      expect(imported.status).toBe(200);
      expect(await readJson(imported)).toMatchObject({ imported: true, force: true, bytes: 3 });
      expect(controlPlaneState.importBytes).toBe(3);
      expect(readControlApiBootstrapRecord(configPath)).toMatchObject({
        url: server.getUrl(),
        token: 'test-token',
        configPath
      });

      controlPlaneState.importError = new Error('Import target already contains state. Re-run with --force after confirming you want to delete existing local state.');
      const nonForced = await fetch(`${server.getUrl()}/api/management/import`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token'
        },
        body: Buffer.from([1])
      });
      expect(nonForced.status).toBe(409);

      controlPlaneState.importError = new Error('TAR_BAD_ARCHIVE: Unrecognized archive format');
      const malformed = await fetch(`${server.getUrl()}/api/management/import?force=1`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token'
        },
        body: Buffer.from([1])
      });
      expect(malformed.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it('preserves status-bearing runtime errors on session routes', async () => {
    const root = createTempRoot('moorline-http-session-status-error-');
    const { MoorlineStatusError } = await import('../../packages/core/src/core/shared/errors/statusError.js');
    const { ControlApiServer } = await importServer();
    const server = new ControlApiServer({
      host: '127.0.0.1',
      port: 0,
      configPath: writeConfig(root),
      entrypoint: process.execPath
    });
    controlPlaneState.directSessionError = new MoorlineStatusError(404, 'No matching managed worker session found.');
    await server.start();
    try {
      const response = await fetch(`${server.getUrl()}/api/work/session/direct`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sessionId: 'missing-session',
          instruction: 'hello'
        })
      });
      expect(response.status).toBe(404);
      expect(await readJson(response)).toMatchObject({
        error: 'No matching managed worker session found.'
      });
    } finally {
      controlPlaneState.directSessionError = null;
      await server.stop();
    }
  });

  it('reports inactive runtime session operations as conflicts', async () => {
    const root = createTempRoot('moorline-http-session-conflict-');
    const { MoorlineStatusError } = await import('../../packages/core/src/core/shared/errors/statusError.js');
    const { ControlApiServer } = await importServer();
    const server = new ControlApiServer({
      host: '127.0.0.1',
      port: 0,
      configPath: writeConfig(root),
      entrypoint: process.execPath
    });
    controlPlaneState.directSessionError = new MoorlineStatusError(409, 'Main process is not active.');
    await server.start();
    try {
      const response = await fetch(`${server.getUrl()}/api/work/session/direct`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sessionId: 'missing-session',
          instruction: 'hello'
        })
      });
      expect(response.status).toBe(409);
      expect(await readJson(response)).toMatchObject({
        error: 'Main process is not active.'
      });
    } finally {
      controlPlaneState.directSessionError = null;
      await server.stop();
    }
  });

  it('rejects non-loopback requests unless remote exposure is explicit', async () => {
    const root = createTempRoot('moorline-http-loopback-');
    const { ControlApiServer } = await importServer();
    const server = new ControlApiServer({
      host: '127.0.0.1',
      port: 0,
      configPath: writeConfig(root),
      entrypoint: process.execPath
    });
    const blocked = createFakeJsonResponse();
    await dispatchFakeRequest(server, {
      method: 'GET',
      url: '/healthz',
      headers: {},
      socket: {
        remoteAddress: '203.0.113.10'
      }
    }, blocked.response);

    expect(blocked.response.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({
      error: 'Control API only accepts loopback connections.'
    });

    const remote = new ControlApiServer({
      host: '127.0.0.1',
      port: 0,
      configPath: writeConfig(join(root, 'remote'), {
        ...defaultHttpApiAdapterConfig(),
        exposure: 'remote'
      }),
      entrypoint: process.execPath
    });
    await remote.start();
    try {
      const allowed = createFakeJsonResponse();
      await dispatchFakeRequest(remote, {
        method: 'GET',
        url: '/healthz',
        headers: {},
        socket: {
          remoteAddress: '203.0.113.10'
        }
      }, allowed.response);
      expect(allowed.response.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ ok: true });
    } finally {
      await remote.stop();
    }
  });
});
