import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import type { ManagementReadModel } from '@moorline/core/types/app.js';
import {
  assertJsonContentType,
  isLoopback,
  readJsonBody,
  readRawBody,
  respondJson,
  securityHeaders
} from './http.js';
import { JsonBodyError } from '@moorline/control-api/errors.js';
import { writeControlApiBootstrapRecord } from '@moorline/control-api/bootstrap.js';
import {
  configuredApiAdapterConfig,
  defaultAdminConfig,
  defaultHttpApiAdapterConfig,
  defaultMainProcessConfig,
  defaultSurfaceNames,
  formatManagementHttpUrl,
  parseHttpApiAdapterConfig,
  type MoorlineConfig
} from '@moorline/core/types/config.js';
import { loadMoorlineConfig, resolveConfigPath, saveMoorlineConfig } from '@moorline/core/core/system/config/configStore.js';
import { redactSensitiveText } from '@moorline/core/core/shared/utils/payloadRedaction.js';
import { errorStatusCode } from '@moorline/core/core/shared/errors/statusError.js';
import { ControlPlane } from '@moorline/core/app/control-api/services/controlPlane.js';
import { projectConfigureState, projectOperationsState, type ControlApiState } from '@moorline/control-api/contracts/api.js';
import {
  parseHistoryDiffQuery,
  parseHistoryShowQuery,
  parseControlApiPostRoute,
  parsePendingInspectQuery
} from '@moorline/control-api/contracts/routes.js';
import manifest from '../manifest.json' with { type: 'json' };

interface ControlApiServerOptions {
  host: string;
  port: number;
  config?: Record<string, unknown>;
  configPath?: string;
  entrypoint: string;
}

function parseBearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || null;
}

export class ControlApiServer {
  private readonly apiToken = process.env.MOORLINE_API_TOKEN?.trim() || randomUUID();
  private readonly configPath: string;
  private readonly temporaryConfigRoot: string | null = null;
  private readonly controlPlane: ControlPlane;
  private readonly server = createServer(async (request, response) => {
    try {
      await this.handle(request, response);
    } catch (error) {
      if (error instanceof JsonBodyError) {
        respondJson(response, error.statusCode, { error: redactSensitiveText(error.message) });
        return;
      }
      const statusCode = errorStatusCode(error);
      if (statusCode) {
        respondJson(response, statusCode, { error: redactSensitiveText(error instanceof Error ? error.message : String(error)) });
        return;
      }
      const name = error instanceof Error ? error.name : 'UnknownError';
      const detail = redactSensitiveText(error instanceof Error ? error.message : String(error));
      globalThis.console.error('[moorline:control-api] request failed', { name, detail });
      respondJson(response, 500, { error: detail || 'Internal server error.', detail, name });
    }
  });
  private activePort: number | null = null;
  private controlPlaneStarted = false;
  private exposure: 'loopback' | 'remote' = 'loopback';
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: ControlApiServerOptions) {
    const preparedConfig = this.prepareConfigPath(options);
    this.configPath = preparedConfig.configPath;
    this.temporaryConfigRoot = preparedConfig.temporaryConfigRoot;
    this.controlPlane = new ControlPlane({
      configPath: this.configPath,
      entrypoint: options.entrypoint
    });
  }

  async start(): Promise<void> {
    if (this.activePort !== null) {
      return;
    }

    const api = this.loadApiConfig();
    if (api?.enabled === false) {
      return;
    }
    if (api?.tls?.enabled) {
      throw new Error('HTTP API adapter tls.enabled is not supported by this adapter package.');
    }
    this.exposure = api?.exposure ?? 'loopback';

    await this.controlPlane.start();
    this.controlPlaneStarted = true;
    try {
      await this.listen(this.options.port).catch(async (error: unknown) => {
        const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : null;
        if (code === 'EADDRINUSE' && this.options.port !== 0) {
          await this.listen(0);
          return;
        }
        throw error;
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return await this.stopPromise;
    }
    this.stopPromise = this.stopInternal();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.activePort === null && !this.controlPlaneStarted) {
      this.cleanupTemporaryConfig();
      return;
    }
    if (this.activePort !== null) {
      await this.closeServer();
    }
    if (this.controlPlaneStarted) {
      await this.controlPlane.stop();
      this.controlPlaneStarted = false;
    }
    this.cleanupTemporaryConfig();
  }

  private async closeServer(): Promise<void> {
    if (this.activePort === null) {
      return;
    }
    if (this.activePort !== null) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let forceTimer: ReturnType<typeof globalThis.setTimeout> | null = globalThis.setTimeout(() => {
          forceTimer = null;
          this.server.closeAllConnections?.();
        }, 2_000);
        this.server.closeIdleConnections?.();
        this.server.close((error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (forceTimer) {
            globalThis.clearTimeout(forceTimer);
            forceTimer = null;
          }
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.activePort = null;
    }
  }

  getUrl(): string | null {
    if (this.activePort === null) {
      return null;
    }
    return formatManagementHttpUrl(this.options.host, this.activePort);
  }

  getApiToken(): string {
    return this.apiToken;
  }

  private loadConfig(): MoorlineConfig {
    return loadMoorlineConfig(this.configPath);
  }

  private cleanupTemporaryConfig(): void {
    if (this.temporaryConfigRoot) {
      rmSync(this.temporaryConfigRoot, { recursive: true, force: true });
    }
  }

  private loadApiConfig() {
    if (this.options.config) {
      return parseHttpApiAdapterConfig(this.options.config);
    }
    return configuredApiAdapterConfig(this.loadConfig());
  }

  private prepareConfigPath(options: ControlApiServerOptions): {
    configPath: string;
    temporaryConfigRoot: string | null;
  } {
    if (options.configPath) {
      return {
        configPath: resolveConfigPath(options.configPath),
        temporaryConfigRoot: null
      };
    }

    const root = mkdtempSync(join(tmpdir(), 'moorline-http-adapter-'));
    const configPath = join(root, 'config.json');
    const adapterConfig: Record<string, unknown> = options.config ?? { ...defaultHttpApiAdapterConfig() };
    // Adapter-local fallback for standalone HTTP server use, where no host config
    // exists yet. Regular host startup still reads the selected package from config.
    const config: MoorlineConfig = {
      version: 4,
      runtimeRoot: join(root, 'runtime'),
      admin: defaultAdminConfig(),
      main: defaultMainProcessConfig(),
      defaults: {
        runtimeMode: 'full-access',
        model: 'latest'
      },
      surface: defaultSurfaceNames(),
      setup: {
        completed: false
      },
      surfaces: {
        apiAdapter: {
          activePackageId: manifest.id,
          config: adapterConfig,
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
    saveMoorlineConfig(config, configPath);
    return {
      configPath,
      temporaryConfigRoot: root
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.exposure !== 'remote' && !isLoopback(request)) {
      respondJson(response, 403, { error: 'Control API only accepts loopback connections.' });
      return;
    }

    const url = new URL(request.url ?? '/', this.getUrl() ?? formatManagementHttpUrl(this.options.host, this.options.port));

    if (request.method === 'GET' && url.pathname === '/healthz') {
      respondJson(response, 200, {
        ok: true,
        mode: this.controlPlane.mode(),
        url: this.getUrl(),
        tokenAvailable: true
      });
      return;
    }

    if (url.pathname === '/') {
      respondJson(response, 200, {
        ok: true,
        name: 'Moorline HTTP API adapter',
        health: '/healthz',
        api: '/api/state'
      });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (parseBearerToken(request) !== this.apiToken) {
        respondJson(response, 401, { error: 'Control API requires a bearer token.' });
        return;
      }
      await this.handleApiRoute(request, response, url);
      return;
    }

    respondJson(response, 404, { error: 'Not found' });
  }

  private async handleApiRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      await this.handleApiGet(response, url);
      return;
    }

    if (method !== 'POST') {
      respondJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    if (url.pathname === '/api/management/import') {
      const force = url.searchParams.get('force') === '1';
      const body = await readRawBody(request, { errorLabel: 'backup archive' });
      const payload = await this.importBackupArchive(body, force);
      this.writeBootstrapRecord();
      respondJson(response, 200, payload);
      return;
    }

    assertJsonContentType(request, url.pathname);
    const body = await readJsonBody(request);
    const payload = await this.handleApiPost(request, url.pathname, body);
    respondJson(response, 200, payload === undefined ? { ok: true } : payload);
  }

  private async importBackupArchive(body: Buffer, force: boolean): Promise<unknown> {
    try {
      return await this.controlPlane.importBackupArchive({ archiveBytes: body, force });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Import target already contains state/u.test(message)) {
        throw new JsonBodyError(409, message);
      }
      if (/Backup archive|TAR_BAD_ARCHIVE|Unrecognized archive format|invalid.*archive|Unsupported backup manifest/iu.test(message)) {
        throw new JsonBodyError(400, message);
      }
      throw error;
    }
  }

  private writeBootstrapRecord(): void {
    const url = this.getUrl();
    if (!url) {
      return;
    }
    writeControlApiBootstrapRecord({
      version: 1,
      protocol: 'http',
      adapterPackageId: manifest.id,
      pid: process.pid,
      url,
      token: this.apiToken,
      startedAt: new Date().toISOString(),
      configPath: this.configPath
    });
  }

  private async handleApiGet(response: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === '/api/state') {
      respondJson(response, 200, await this.buildState());
      return;
    }
    if (url.pathname === '/api/main/status') {
      respondJson(response, 200, await this.controlPlane.mainStatus());
      return;
    }
    if (url.pathname === '/api/state/operations') {
      respondJson(response, 200, (await this.buildState()).operations);
      return;
    }
    if (url.pathname === '/api/state/configure') {
      respondJson(response, 200, (await this.buildState()).configure);
      return;
    }
    if (url.pathname === '/api/packages/search') {
      respondJson(response, 200, await this.controlPlane.searchPackages(parsePackageSearchQuery(url)));
      return;
    }
    if (url.pathname === '/api/packages/info') {
      respondJson(response, 200, await this.controlPlane.packageInfo(parsePackageInfoQuery(url)));
      return;
    }
    if (url.pathname === '/api/packages/installed') {
      const state = await this.buildState();
      respondJson(response, 200, state.configure.packages.installed);
      return;
    }
    if (url.pathname === '/api/history/status') {
      const state = await this.buildState();
      respondJson(response, 200, state.configure.history.status);
      return;
    }
    if (url.pathname === '/api/history/list') {
      const state = await this.buildState();
      respondJson(response, 200, state.configure.history.entries);
      return;
    }
    if (url.pathname === '/api/history/show') {
      const { commitish } = parseHistoryShowQuery(url);
      respondJson(response, 200, this.controlPlane.showHistoryEntry(commitish));
      return;
    }
    if (url.pathname === '/api/history/diff') {
      const { from, to, path } = parseHistoryDiffQuery(url);
      respondJson(response, 200, this.controlPlane.diffHistory({ from, to, path }));
      return;
    }
    if (url.pathname === '/api/pending-requests/list') {
      respondJson(response, 200, this.controlPlane.listPendingRequests());
      return;
    }
    if (url.pathname === '/api/pending-requests/inspect') {
      const { requestId } = parsePendingInspectQuery(url);
      const payload = this.controlPlane.listPendingRequests();
      if (!Array.isArray(payload)) {
        throw new JsonBodyError(500, 'Pending requests response was malformed.');
      }
      const request = payload.find((entry) => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }
        return (entry as { id?: unknown }).id === requestId;
      });
      if (!request) {
        throw new JsonBodyError(404, `Pending request ${requestId} was not found.`);
      }
      respondJson(response, 200, request);
      return;
    }
    if (url.pathname === '/api/management/diagnostics-export') {
      respondJson(response, 200, this.controlPlane.diagnosticsExport());
      return;
    }
    if (url.pathname === '/api/management/setup-export') {
      const body = JSON.stringify(this.controlPlane.exportSetupBundle(), null, 2);
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': 'attachment; filename="moorline-setup.share.json"',
        ...securityHeaders()
      });
      response.end(body);
      return;
    }
    if (url.pathname === '/api/management/backup') {
      const includeWorkspaces = url.searchParams.get('includeWorkspaces') === '1';
      const archive = await this.controlPlane.createBackupArchive({ includeWorkspaces });
      const bytes = readFileSync(archive.archivePath);
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${archive.filename}"`,
        ...securityHeaders()
      });
      response.end(bytes);
      return;
    }
    respondJson(response, 404, { error: 'Not found' });
  }

  private async handleApiPost(request: IncomingMessage | null, pathname: string, body: Record<string, unknown>): Promise<unknown> {
    const route = parseControlApiPostRoute(pathname, body);
    switch (route.path) {
      case '/api/main/start':
        return await this.controlPlane.startMain();
      case '/api/main/stop':
        return await this.controlPlane.stopMain();
      case '/api/main/restart':
        return await this.controlPlane.restartMain();
      case '/api/shutdown':
        globalThis.setTimeout(() => {
          void this.stop();
        }, 10);
        return {
          accepted: true,
          detail: 'Control API shutdown requested.'
        };
      case '/api/leases/create':
        return await this.controlPlane.createLease({
          client: route.payload.client ?? 'unknown-client',
          policy: route.payload.policy ?? 'detached',
          ttlMs: route.payload.ttlMs
        });
      case '/api/leases/heartbeat':
        return await this.controlPlane.heartbeatLease(route.payload);
      case '/api/leases/release':
        return await this.controlPlane.releaseLease(route.payload.leaseId);
      case '/api/runtime/accepting':
        return await this.controlPlane.setAcceptingNewWork(Boolean(route.payload.accepting));
      case '/api/runtime/reload':
        return await this.controlPlane.requestRuntimeReload(route.payload.mode === 'force' ? 'force' : 'graceful');
      case '/api/provider/test':
        return await this.controlPlane.testProvider(route.payload);
      case '/api/provider/start':
        return await this.controlPlane.startProvider(typeof route.payload.threadId === 'string' ? route.payload.threadId : undefined);
      case '/api/provider/stop':
        return await this.controlPlane.stopProvider(typeof route.payload.threadId === 'string' ? route.payload.threadId : undefined);
      case '/api/work/session/create':
        return await this.controlPlane.createSession(route.payload);
      case '/api/work/session/direct':
        return await this.controlPlane.directSession(route.payload);
      case '/api/work/session/archive':
        return await this.controlPlane.archiveSession(route.payload);
      case '/api/work/session/delete':
        return await this.controlPlane.deleteArchivedSession(route.payload);
      case '/api/packages/install':
        return this.controlPlane.installPackage(route.payload);
      case '/api/packages/remove':
        return this.controlPlane.removePackage(route.payload);
      case '/api/packages/enable':
        return this.controlPlane.enablePackage(route.payload);
      case '/api/packages/disable':
        return this.controlPlane.disablePackage(route.payload);
      case '/api/packages/activate':
        return this.controlPlane.activatePackage(route.payload);
      case '/api/packages/deactivate':
        return this.controlPlane.deactivatePackage(route.payload);
      case '/api/packages/select':
        return this.controlPlane.selectPackage(route.payload);
      case '/api/packages/config':
        return this.controlPlane.setPackageConfig(route.payload);
      case '/api/packages/apply':
        return await this.controlPlane.applyPackages();
      case '/api/history/snapshot':
        return this.controlPlane.createHistorySnapshot(String(route.payload.label ?? 'snapshot'));
      case '/api/history/restore':
        return this.controlPlane.restoreHistory(route.payload);
      case '/api/history/discard':
        return this.controlPlane.discardHistory(route.payload);
      case '/api/pending-requests/resolve':
        return await this.controlPlane.resolvePendingRequest(route.payload);
      case '/api/pending-requests/answer':
        return await this.controlPlane.answerPendingRequest(route.payload);
      case '/api/pending-requests/cancel':
        return await this.controlPlane.cancelPendingRequest(route.payload);
      case '/api/management/default-model':
        return await this.controlPlane.setDefaultModel(String(route.payload.model ?? ''));
      case '/api/management/config-migration-warning/acknowledge':
        return this.controlPlane.acknowledgeConfigMigrationWarning();
      default:
        throw new JsonBodyError(404, 'Not found');
    }
  }

  private async buildState(): Promise<ControlApiState> {
    const readModel = this.controlPlane.readModel() as ManagementReadModel;
    return {
      generatedAt: new Date().toISOString(),
      runtimeMode: this.controlPlane.mode(),
      readModel,
      operations: projectOperationsState(readModel),
      configure: projectConfigureState(readModel)
    };
  }

  private async listen(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        const address = this.server.address();
        this.activePort = typeof address === 'object' && address ? address.port : port;
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, this.options.host);
    });
  }
}

function parsePackageKindQuery(value: string | null): 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle' | undefined {
  if (!value) {
    return undefined;
  }
  if (value === 'api-adapter' || value === 'transport' || value === 'provider' || value === 'plugin' || value === 'skill' || value === 'bundle') {
    return value;
  }
  throw new JsonBodyError(422, 'kind must be one of: api-adapter, transport, provider, plugin, skill, bundle.');
}

function parsePackageSearchQuery(url: URL): {
  query?: string;
  kind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle';
  compatibleOnly?: boolean;
} {
  const query = url.searchParams.get('q')?.trim();
  const compatibleOnly = url.searchParams.get('compatibleOnly');
  return {
    ...(query ? { query } : {}),
    ...(parsePackageKindQuery(url.searchParams.get('kind')) ? { kind: parsePackageKindQuery(url.searchParams.get('kind')) } : {}),
    ...(compatibleOnly ? { compatibleOnly: compatibleOnly === 'true' } : {})
  };
}

function parsePackageInfoQuery(url: URL): {
  packageId: string;
  kind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle';
} {
  const packageId = url.searchParams.get('packageId')?.trim();
  if (!packageId) {
    throw new JsonBodyError(422, 'packageId is required.');
  }
  return {
    packageId,
    ...(parsePackageKindQuery(url.searchParams.get('kind')) ? { kind: parsePackageKindQuery(url.searchParams.get('kind')) } : {})
  };
}
