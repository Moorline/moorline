import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadMoorlineConfig, resolveConfigPath, runtimePaths } from '../../../core/system/config/configStore.js';
import { resolveRuntimeMigrationsDir } from '../../../core/runtime/graph/runtimePaths.js';
import { runMigrations } from '../../../core/system/state/migrationRunner.js';
import {
  defaultHttpApiAdapterConfig,
  defaultMainProcessConfig,
  selectedApiAdapterPackageConfig,
  type MainLifecyclePolicy,
  type MoorlineConfig
} from '../../../types/config.js';
import type { ManagementReadModel } from '../../../types/app.js';
import { ControlApiActionsService } from './actions.js';
import { ControlApiRuntimeHostService, type ControlLeaseRecord } from './runtimeHost.js';
import { ControlApiStateService } from './state.js';

export class ControlPlane {
  private activeConfigPath: string | null = null;
  private readonly leases = new Map<string, ControlLeaseRecord>();
  private leaseTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private readonly runtimeHost: ControlApiRuntimeHostService;
  private readonly stateService: ControlApiStateService;
  private readonly actions: ControlApiActionsService;

  constructor(
    private readonly input: {
      configPath?: string;
      entrypoint: string;
      now?: () => string;
    }
  ) {
    this.runtimeHost = new ControlApiRuntimeHostService({
      configPath: input.configPath,
      entrypoint: input.entrypoint
    });
    this.stateService = new ControlApiStateService({
      now: input.now,
      getRuntimeControlStatus: () => this.runtimeHost.runtimeControlStatus(),
      getManagementSurface: () => {
        const config = this.loadConfig();
        const adapterConfig = selectedApiAdapterPackageConfig(config);
        const defaults = defaultHttpApiAdapterConfig();
        const enabled = adapterConfig.enabled !== false;
        const host = typeof adapterConfig.host === 'string' && adapterConfig.host.trim().length > 0 ? adapterConfig.host.trim() : defaults.host;
        const port = typeof adapterConfig.port === 'number' && Number.isInteger(adapterConfig.port) ? adapterConfig.port : 0;
        return {
          enabled,
          host,
          port,
          url: enabled && port > 0 ? `http://${host}:${port}` : null
        };
      }
    });
    this.actions = new ControlApiActionsService({
      configPath: input.configPath,
      runtimeHost: this.runtimeHost,
      buildReadModel: () => this.readModel(),
      now: input.now
    });
  }

  async start(): Promise<void> {
    this.activeConfigPath = resolveConfigPath(this.input.configPath);
    const config = this.loadConfig();
    const paths = runtimePaths(config.runtimeRoot);
    mkdirSync(dirname(paths.sqlitePath), { recursive: true });
    runMigrations(paths.sqlitePath, resolveRuntimeMigrationsDir(import.meta.url));
    await this.runtimeHost.ensureAutostart();
    if (!this.leaseTimer) {
      this.leaseTimer = globalThis.setInterval(() => {
        void this.evictExpiredLeases();
      }, 1_000);
    }
  }

  async stop(): Promise<void> {
    this.leases.clear();
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
    await this.runtimeHost.stop();
  }

  mode(): 'runtime' | 'management_only' {
    return this.runtimeHost.mode();
  }

  configPath(): string | null {
    return this.activeConfigPath;
  }

  readModel(): ManagementReadModel {
    return this.stateService.build(this.loadConfig());
  }

  diagnosticsExport() {
    return this.actions.diagnosticsExport();
  }

  exportSetupBundle() {
    return this.actions.exportSetupBundle();
  }

  async createBackupArchive(input: { includeWorkspaces: boolean }) {
    return await this.actions.createBackupArchive(input);
  }

  async importBackupArchive(input: { archiveBytes: Buffer; force: boolean }) {
    return await this.actions.importBackupArchive(input);
  }

  async setDefaultModel(model: string) {
    await this.actions.setDefaultModel(model);
    return { ok: true, message: `Default model set to ${model}.` };
  }

  acknowledgeConfigMigrationWarning() {
    return this.actions.acknowledgeConfigMigrationWarning();
  }

  createHistorySnapshot(label: string) {
    const snapshot = this.actions.createHistorySnapshot(label);
    return { ...snapshot, message: `Snapshot created: ${label}.` };
  }

  showHistoryEntry(commitish: string) {
    return this.actions.showHistoryEntry(commitish);
  }

  diffHistory(input: { from?: string; to?: string; path?: string }) {
    return this.actions.diffHistory(input);
  }

  restoreHistory(input: { commitish: string; path?: string }) {
    const result = this.actions.restoreHistory(input);
    return { ...result, message: input.path ? `Restored ${input.path} from ${input.commitish}.` : `Restored tracked state from ${input.commitish}.` };
  }

  discardHistory(input: { path?: string }) {
    return { ...this.actions.discardHistory(input), message: input.path ? `Discarded tracked edits for ${input.path}.` : 'Discarded tracked edits.' };
  }

  async installPackage(input: { kind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle'; surface?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle'; packageId?: string; source?: string }) {
    const record = await this.actions.installPackage(input);
    return {
      ...record,
      message: `Installed ${record.kind ?? record.surface} package ${record.packageId}.`
    };
  }

  async searchPackages(input: { query?: string; kind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle'; compatibleOnly?: boolean }) {
    return await this.actions.searchPackages(input);
  }

  async packageInfo(input: { packageId: string; kind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle' }) {
    return await this.actions.packageInfo(input);
  }

  removePackage(input: { kind?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle'; surface?: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle'; packageId: string; cascade?: boolean }) {
    this.actions.removePackage(input);
    return { ok: true, message: `Removed ${input.kind ?? input.surface} package ${input.packageId}.` };
  }

  enablePackage(input: { surface: 'plugin' | 'skill'; packageId: string }) {
    this.actions.enablePackage(input);
    return { ok: true, message: `Enabled ${input.surface} package ${input.packageId}.` };
  }

  disablePackage(input: { surface: 'plugin' | 'skill'; packageId: string }) {
    this.actions.disablePackage(input);
    return { ok: true, message: `Disabled ${input.surface} package ${input.packageId}.` };
  }

  activatePackage(input: { surface: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill'; packageId: string }) {
    this.actions.activatePackage(input);
    return { ok: true, message: `Activated ${input.surface} package ${input.packageId}.` };
  }

  deactivatePackage(input: { surface: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill'; packageId: string }) {
    this.actions.deactivatePackage(input);
    return { ok: true, message: `Deactivated ${input.surface} package ${input.packageId}.` };
  }

  selectPackage(input: { surface: 'api-adapter' | 'transport' | 'provider'; packageId: string | null }) {
    this.actions.selectPackage(input);
    return { ok: true, message: input.packageId ? `Selected ${input.surface} package ${input.packageId}.` : `Cleared selected ${input.surface} package.` };
  }

  setPackageConfig(input: Parameters<ControlApiActionsService['setPackageConfig']>[0]) {
    this.actions.setPackageConfig(input);
    return { ok: true, message: `Saved ${input.surface} package configuration${input.packageId ? ` for ${input.packageId}` : ''}.` };
  }

  async applyPackages() {
    const plan = await this.actions.applyPackages();
    return {
      ...plan,
      message: plan.actions.length > 0 ? 'Package changes applied.' : 'No package changes were pending.'
    };
  }

  listPendingRequests() {
    return this.actions.listPendingRequests();
  }

  createSession(input: Parameters<ControlApiActionsService['createSession']>[0]) {
    return this.actions.createSession(input);
  }

  directSession(input: Parameters<ControlApiActionsService['directSession']>[0]) {
    return this.actions.directSession(input);
  }

  archiveSession(input: Parameters<ControlApiActionsService['archiveSession']>[0]) {
    return this.actions.archiveSession(input);
  }

  deleteArchivedSession(input: Parameters<ControlApiActionsService['deleteArchivedSession']>[0]) {
    return this.actions.deleteArchivedSession(input);
  }

  setAcceptingNewWork(accepting: boolean) {
    return this.actions.setAcceptingNewWork(accepting);
  }

  requestRuntimeReload(mode: 'graceful' | 'force') {
    return this.actions.requestRuntimeReload(mode);
  }

  testProvider(input: Parameters<ControlApiActionsService['testProvider']>[0]) {
    return this.actions.testProvider(input);
  }

  stopProvider(threadId?: string) {
    return this.actions.stopProvider(threadId);
  }

  startProvider(threadId?: string) {
    return this.actions.startProvider(threadId);
  }

  resolvePendingRequest(input: Parameters<ControlApiActionsService['resolvePendingRequest']>[0]) {
    return this.actions.resolvePendingRequest(input);
  }

  answerPendingRequest(input: Parameters<ControlApiActionsService['answerPendingRequest']>[0]) {
    return this.actions.answerPendingRequest(input);
  }

  cancelPendingRequest(input: { requestId: string }) {
    return this.actions.cancelPendingRequest(input);
  }

  async mainStatus(): Promise<{
    running: boolean;
    mode: 'runtime' | 'management_only';
    startable: boolean;
    issues: string[];
    policy: MainLifecyclePolicy;
    leases: ControlLeaseRecord[];
  }> {
    await this.evictExpiredLeases();
    return this.runtimeHost.mainStatus([...this.leases.values()]);
  }

  async startMain(): Promise<{ running: boolean; mode: 'runtime' | 'management_only'; detail: string }> {
    return await this.runtimeHost.startMain();
  }

  async stopMain(): Promise<{ running: boolean; mode: 'runtime' | 'management_only'; detail: string }> {
    return await this.runtimeHost.stopMain();
  }

  async restartMain(): Promise<{ running: boolean; mode: 'runtime' | 'management_only'; detail: string }> {
    return await this.runtimeHost.restartMain();
  }

  async createLease(input: { client: string; policy?: MainLifecyclePolicy; ttlMs?: number }): Promise<ControlLeaseRecord> {
    await this.evictExpiredLeases();
    const now = Date.now();
    const record: ControlLeaseRecord = {
      leaseId: randomUUID(),
      client: input.client.trim() || 'unknown-client',
      policy: input.policy ?? this.loadConfig().main?.defaultLifecyclePolicy ?? defaultMainProcessConfig().defaultLifecyclePolicy,
      expiresAt: now + Math.max(5_000, input.ttlMs ?? 30_000),
      createdAt: new Date(now).toISOString(),
      lastHeartbeatAt: new Date(now).toISOString()
    };
    this.leases.set(record.leaseId, record);
    return record;
  }

  async heartbeatLease(input: { leaseId: string; ttlMs?: number }): Promise<ControlLeaseRecord> {
    await this.evictExpiredLeases();
    const record = this.leases.get(input.leaseId);
    if (!record) {
      throw new Error(`Lease ${input.leaseId} was not found.`);
    }
    const now = Date.now();
    record.expiresAt = now + Math.max(5_000, input.ttlMs ?? 30_000);
    record.lastHeartbeatAt = new Date(now).toISOString();
    this.leases.set(record.leaseId, record);
    return record;
  }

  async releaseLease(leaseId: string): Promise<{ released: boolean }> {
    this.leases.delete(leaseId);
    await this.enforceLeasePolicy();
    return { released: true };
  }

  private loadConfig(): MoorlineConfig {
    return loadMoorlineConfig(this.requireConfigPath());
  }

  private requireConfigPath(): string {
    const configPath = this.activeConfigPath ?? resolveConfigPath(this.input.configPath);
    this.activeConfigPath = configPath;
    return configPath;
  }

  private async evictExpiredLeases(): Promise<void> {
    const now = Date.now();
    for (const [leaseId, lease] of [...this.leases.entries()]) {
      if (lease.expiresAt <= now) {
        this.leases.delete(leaseId);
      }
    }
    await this.enforceLeasePolicy();
  }

  private async enforceLeasePolicy(): Promise<void> {
    const policy = this.loadConfig().main?.defaultLifecyclePolicy ?? defaultMainProcessConfig().defaultLifecyclePolicy;
    const stopOnLastLeaseCount = [...this.leases.values()].filter((lease) => lease.policy === 'stop_on_last_lease').length;
    if (policy === 'stop_on_last_lease' && stopOnLastLeaseCount === 0 && this.runtimeHost.isRunning()) {
      await this.runtimeHost.stopMain();
    }
  }
}
