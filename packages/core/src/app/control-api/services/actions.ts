import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperatorPackageService } from '../../bootstrap/operatorPackageService.js';
import { createRuntimeBackup, importRuntimeBackup } from '../../../core/system/backup/runtimeBackupService.js';
import {
  acknowledgeConfigMigrationWarning,
  buildShareableMoorlineConfig,
  loadMoorlineConfig,
  resolveConfigPath,
  runtimePaths,
  saveMoorlineConfig
} from '../../../core/system/config/configStore.js';
import { GitHistoryService } from '../../../core/system/vcs/gitHistoryService.js';
import { recordHistoryCheckpoint } from '../../../core/system/vcs/gitCheckpointService.js';
import { homeRootForRuntime, type MoorlineShareBundle } from '../../../types/config.js';
import { normalizeAndValidateDefaultModel } from '../../../core/runtime/execution/defaultModelSelection.js';
import { ProviderSessionDirectory } from '../../../core/runtime/execution/providerSessionDirectory.js';
import { SqliteSessionStore } from '../../../core/system/state/sqliteSessionStore.js';
import {
  enqueueOrchestrationRequest,
  waitForOrchestrationRequest,
  type AnswerPendingRequestOrchestrationPayload,
  type ArchiveSessionOrchestrationPayload,
  type CreateSessionOrchestrationPayload,
  type DeleteSessionOrchestrationPayload,
  type DirectSessionOrchestrationPayload,
  type ProviderSessionControlOrchestrationPayload,
  type ProviderTestOrchestrationPayload,
  type ResolvePendingRequestOrchestrationPayload,
  type RuntimeReloadOrchestrationPayload,
  type RuntimeSetAcceptingOrchestrationPayload
} from '../../../core/runtime/execution/runtimeOrchestrationRequests.js';
import { parseOrchestrationResult } from '../../../core/runtime/execution/runtimeOrchestrationResult.js';
import type { RuntimeOrchestrationRequestType } from '../../../core/system/state/sqlite/types.js';
import type { MoorlineConfig } from '../../../types/config.js';
import type { ControlApiRuntimeHostService } from './runtimeHost.js';
import type { ManagementReadModel } from '../../../types/app.js';

const CONTROL_API_ACTOR_ID = 'app:control-api';
const CONTROL_API_REQUEST_THREAD = 'control-api';
const CONTROL_API_REQUEST_RESOURCE = 'control-api';
const ORCHESTRATION_TIMEOUT_MS = 180_000;

export class ControlApiActionsService {
  private readonly history = new GitHistoryService();

  constructor(
    private readonly input: {
      configPath?: string;
      runtimeHost: ControlApiRuntimeHostService;
      buildReadModel: () => ManagementReadModel;
      now?: () => string;
    }
  ) {}

  loadConfig(): MoorlineConfig {
    return loadMoorlineConfig(this.requireConfigPath());
  }

  diagnosticsExport() {
    return {
      exportedAt: this.now(),
      kind: 'moorline-diagnostics-export',
      readModel: this.buildReadModel()
    };
  }

  exportSetupBundle(): MoorlineShareBundle {
    const config = this.loadConfig();
    const service = this.packageService(config);
    const shareBundle = service.exportShareBundle();
    return {
      version: 1,
      exportedAt: this.now(),
      productVersion: process.env.npm_package_version ?? '0.0.1',
      config: buildShareableMoorlineConfig(config),
      packages: shareBundle.packages,
      notes: shareBundle.notes
    };
  }

  async createBackupArchive(input: { includeWorkspaces: boolean }): Promise<{ archivePath: string; filename: string }> {
    const config = this.loadConfig();
    const filename = `moorline-backup-${Date.now()}.tgz`;
    const archivePath = join(config.runtimeRoot, 'state', 'backups', filename);
    await createRuntimeBackup({
      config,
      configPath: this.requireConfigPath(),
      includeWorkspaces: input.includeWorkspaces,
      outputPath: archivePath,
      nowIso: this.now()
    });
    return { archivePath, filename };
  }

  async importBackupArchive(input: {
    archiveBytes: Buffer;
    force: boolean;
  }): Promise<{ configPath: string; runtimeRoot: string; replacedExistingState: boolean }> {
    const config = this.loadConfig();
    const tempDir = mkdtempSync(join(tmpdir(), 'moorline-control-api-import-'));
    const archivePath = join(tempDir, 'backup.tgz');
    writeFileSync(archivePath, input.archiveBytes, { flag: 'wx' });
    try {
      return await importRuntimeBackup({
        archivePath,
        targetConfigPath: this.requireConfigPath(),
        targetRuntimeRoot: config.runtimeRoot,
        force: input.force
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async setDefaultModel(model: string): Promise<void> {
    const config = this.loadConfig();
    const nextModel = normalizeAndValidateDefaultModel({
      model,
      availableModels: this.readPersistedProviderModels(config.runtimeRoot)
    });
    config.defaults.model = nextModel;
    saveMoorlineConfig(config, this.requireConfigPath());
    recordHistoryCheckpoint({
      homeRoot: homeRootForRuntime(config.runtimeRoot),
      actor: CONTROL_API_ACTOR_ID,
      reason: `Updated default model to ${nextModel}.`,
      operation: 'set default model',
      configPath: this.requireConfigPath()
    });
  }

  acknowledgeConfigMigrationWarning(): { acknowledged: boolean } {
    acknowledgeConfigMigrationWarning(this.loadConfig().runtimeRoot);
    return { acknowledged: true };
  }

  createHistorySnapshot(label: string) {
    return this.history.createSnapshotSync({
      homeRoot: homeRootForRuntime(this.loadConfig().runtimeRoot),
      label,
      actor: CONTROL_API_ACTOR_ID,
      reason: 'Snapshot created through the Control API.'
    });
  }

  showHistoryEntry(commitish: string) {
    return this.history.showSync(homeRootForRuntime(this.loadConfig().runtimeRoot), commitish);
  }

  diffHistory(input: { from?: string; to?: string; path?: string }) {
    return {
      diff: this.history.diffSync({
        homeRoot: homeRootForRuntime(this.loadConfig().runtimeRoot),
        ...input
      })
    };
  }

  restoreHistory(input: { commitish: string; path?: string }) {
    return this.history.restoreSync({
      homeRoot: homeRootForRuntime(this.loadConfig().runtimeRoot),
      ...input,
      actor: CONTROL_API_ACTOR_ID
    });
  }

  discardHistory(input: { path?: string }): { ok: true } {
    this.history.discardSync({
      homeRoot: homeRootForRuntime(this.loadConfig().runtimeRoot),
      ...(input.path ? { paths: [input.path] } : {})
    });
    return { ok: true };
  }

  installPackage(input: { kind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle'; surface?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle'; packageId?: string; source?: string }) {
    const config = this.loadConfig();
    return this.packageService(config).installPackage({
      kind: input.kind ?? input.surface,
      ...(input.packageId ? { packageId: input.packageId } : {}),
      ...(input.source ? { source: parsePackageSource(input.source) } : {})
    });
  }

  searchPackages(input: { query?: string; kind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle'; compatibleOnly?: boolean }) {
    return this.packageService(this.loadConfig()).searchPackages({
      query: input.query,
      kind: input.kind,
      compatibleOnly: input.compatibleOnly
    });
  }

  packageInfo(input: { packageId: string; kind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle' }) {
    return this.packageService(this.loadConfig()).getPackageInfo(input);
  }

  removePackage(input: { kind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle'; surface?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle'; packageId: string; cascade?: boolean }) {
    return this.packageService(this.loadConfig()).removePackage(input);
  }

  enablePackage(input: { surface: 'plugin' | 'skill'; packageId: string }) {
    return this.packageService(this.loadConfig()).enablePackage(input.surface, input.packageId);
  }

  disablePackage(input: { surface: 'plugin' | 'skill'; packageId: string }) {
    return this.packageService(this.loadConfig()).disablePackage(input.surface, input.packageId);
  }

  activatePackage(input: { surface: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill'; packageId: string }) {
    return this.packageService(this.loadConfig()).activatePackage(input.surface, input.packageId);
  }

  deactivatePackage(input: { surface: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill'; packageId: string }) {
    return this.packageService(this.loadConfig()).deactivatePackage(input.surface, input.packageId);
  }

  selectPackage(input: { surface: 'api-adapter' | 'transport' | 'provider'; packageId: string | null }) {
    return this.packageService(this.loadConfig()).setSelectedPackage(input.surface, input.packageId);
  }

  setPackageConfig(input: {
    surface: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill';
    packageId: string;
    values?: Record<string, string>;
    secretReplacements?: Array<{ key: string; value: string }>;
  }) {
    const service = this.packageService(this.loadConfig());
    return service.setPackageConfigValues({
      surface: input.surface,
      packageId: input.packageId,
      values: input.values ?? {},
      secretReplacements: input.secretReplacements ?? []
    });
  }

  async applyPackages() {
    return await this.packageService(this.loadConfig()).apply();
  }

  listPendingRequests() {
    return this.buildReadModel().objects.pendingRequests;
  }

  async createSession(input: CreateSessionOrchestrationPayload) {
    return await this.runRuntimeRequest('create_session', input);
  }

  async directSession(input: DirectSessionOrchestrationPayload) {
    return await this.runRuntimeRequest('direct_session', input);
  }

  async archiveSession(input: ArchiveSessionOrchestrationPayload) {
    return await this.runRuntimeRequest('archive_session', input);
  }

  async deleteArchivedSession(input: DeleteSessionOrchestrationPayload) {
    return await this.runRuntimeRequest('delete_session', input);
  }

  async setAcceptingNewWork(accepting: boolean) {
    const result = await this.runRuntimeRequest('runtime_set_accepting', { accepting } satisfies RuntimeSetAcceptingOrchestrationPayload);
    this.input.runtimeHost.noteAcceptingNewWork(accepting);
    return result;
  }

  async requestRuntimeReload(mode: 'graceful' | 'force') {
    return await this.runRuntimeRequest('runtime_reload', { mode } satisfies RuntimeReloadOrchestrationPayload);
  }

  async testProvider(input: ProviderTestOrchestrationPayload = {}) {
    return await this.runRuntimeRequest('provider_test', input);
  }

  async stopProvider(threadId?: string) {
    return await this.runRuntimeRequest('provider_stop', threadId ? { threadId } : ({} satisfies ProviderSessionControlOrchestrationPayload));
  }

  async startProvider(threadId?: string) {
    return await this.runRuntimeRequest('provider_start', threadId ? { threadId } : ({} satisfies ProviderSessionControlOrchestrationPayload));
  }

  async resolvePendingRequest(input: ResolvePendingRequestOrchestrationPayload) {
    return await this.runRuntimeRequest('resolve_pending_request', input);
  }

  async answerPendingRequest(input: AnswerPendingRequestOrchestrationPayload) {
    return await this.runRuntimeRequest('answer_pending_request', input);
  }

  async cancelPendingRequest(input: { requestId: string }) {
    return await this.runRuntimeRequest('resolve_pending_request', {
      requestId: input.requestId,
      decision: 'cancel'
    } satisfies ResolvePendingRequestOrchestrationPayload);
  }

  private async runRuntimeRequest<TPayload>(type: RuntimeOrchestrationRequestType, payload: TPayload): Promise<unknown> {
    if (!this.input.runtimeHost.isRunning()) {
      throw new Error('Main process is not active.');
    }
    const store = new SqliteSessionStore(runtimePaths(this.loadConfig().runtimeRoot).sqlitePath);
    try {
      const request = enqueueOrchestrationRequest({
        store,
        actorId: CONTROL_API_ACTOR_ID,
        requestedByThreadId: CONTROL_API_REQUEST_THREAD,
        requestedByTransportResourceId: CONTROL_API_REQUEST_RESOURCE,
        type,
        payload: payload as never,
        nowIso: this.now()
      });
      const completed = await waitForOrchestrationRequest({
        store,
        requestId: request.requestId,
        timeoutMs: ORCHESTRATION_TIMEOUT_MS
      });
      return parseOrchestrationResult(completed);
    } finally {
      store.close();
    }
  }

  private buildReadModel(): ManagementReadModel {
    return this.input.buildReadModel();
  }

  private packageService(config: MoorlineConfig): OperatorPackageService {
    const service = new OperatorPackageService(config, this.requireConfigPath(), () => this.now());
    service.ensureInitialized();
    return service;
  }

  private requireConfigPath(): string {
    return resolveConfigPath(this.input.configPath);
  }

  private now(): string {
    return (this.input.now ?? (() => new Date().toISOString()))();
  }

  private readPersistedProviderModels(runtimeRoot: string): string[] {
    const sqlitePath = join(runtimeRoot, 'state.db');
    if (!existsSync(sqlitePath)) {
      return [];
    }
    try {
      const store = new SqliteSessionStore(sqlitePath);
      try {
        return new ProviderSessionDirectory(store).list().at(-1)?.availableModels ?? [];
      } finally {
        store.close();
      }
    } catch {
      return [];
    }
  }
}

function parsePackageSource(source: string) {
  if (/^https?:\/\//i.test(source)) {
    return { kind: 'remote_archive', url: source } as const;
  }
  if (source.endsWith('.tgz') || source.endsWith('.tar.gz') || source.endsWith('.zip')) {
    return { kind: 'local_archive', path: source } as const;
  }
  return { kind: 'local_dir', path: source } as const;
}
