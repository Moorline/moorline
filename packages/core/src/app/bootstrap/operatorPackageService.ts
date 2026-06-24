import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeRootForRuntime, type MoorlineConfig } from '../../types/config.js';
import type { MoorlineShareBundle } from '../../types/config.js';
import type {
  JsonSchemaLike,
  PackageApplyPlan,
  PackageMetadataEntry,
  PackageKind,
  PackageSourceDescriptor,
  PackageSurface
} from '../../types/package.js';
import { createPackageApplyPlan } from '../../core/extension/packages/packageApplyPlanner.js';
import { findDependentRecords, findDependents } from '../../core/extension/packages/packageDependencyResolver.js';
import { resolvePackageConfigSchema } from '../../core/extension/packages/packageConfigSchema.js';
import { PackageInventoryStore } from '../../core/extension/packages/packageInventoryStore.js';
import { PackageInstaller } from '../../core/extension/packages/packageInstaller.js';
import { coerceSurfaceConfigInput, evaluateRuntimeStartability } from '../../core/extension/packages/runtimeStartability.js';
import {
  appliedPackageRefs,
  desiredPackageRefsFromConfig,
  packageActivationUniqueKey
} from '../../core/extension/packages/packageActivation.js';
import { buildRequiredAppliedSurfaceConfigs, buildShareableMoorlineConfig, runtimePaths, saveMoorlineConfig } from '../../core/system/config/configStore.js';
import { recordHistoryCheckpoint } from '../../core/system/vcs/gitCheckpointService.js';
import { GitHistoryService } from '../../core/system/vcs/gitHistoryService.js';
import { loadTransportPackageById } from './transportPackageLoader.js';
import { packageVersionSatisfiesRange, resolveBundleMembers } from '../../core/extension/packages/packageVersionResolver.js';
import { PackageRegistryService } from '../../core/extension/packages/packageRegistryService.js';
import type { PackageRegistryEntry, PackageSearchInput } from '../../core/extension/packages/packageRegistryTypes.js';
import { loadInstallablePackageManifest } from '../../core/extension/packages/packageManifest.js';

type PackageConfigValues = Record<string, unknown>;
type PackageConfigReplacement = {
  key: string;
  value: string;
};

function packageInstallDirName(surface: PackageKind): string {
  return surface === 'api-adapter'
    ? 'api-adapters'
    : surface === 'bundle'
      ? 'bundles'
      : `${surface}s`;
}

function packageConfigRoot(
  config: MoorlineConfig,
  surface: PackageSurface,
  packageId: string
): Record<string, unknown> {
  if (surface === 'api-adapter') {
    config.surfaces.apiAdapter.configByPackageId ??= {};
    config.surfaces.apiAdapter.configByPackageId[packageId] ??= {};
    return config.surfaces.apiAdapter.configByPackageId[packageId];
  }
  if (surface === 'transport') {
    config.surfaces.transport.configByPackageId ??= {};
    config.surfaces.transport.configByPackageId[packageId] ??= {};
    return config.surfaces.transport.configByPackageId[packageId];
  }
  if (surface === 'provider') {
    config.surfaces.provider.configByPackageId ??= {};
    config.surfaces.provider.configByPackageId[packageId] ??= {};
    return config.surfaces.provider.configByPackageId[packageId];
  }
  if (surface === 'plugin') {
    config.surfaces.plugins.configByPackageId[packageId] ??= {};
    return config.surfaces.plugins.configByPackageId[packageId];
  }
  config.surfaces.skills.configByPackageId[packageId] ??= {};
  return config.surfaces.skills.configByPackageId[packageId];
}

function packageConfigRootIfPresent(
  config: MoorlineConfig,
  surface: PackageSurface,
  packageId: string
): Record<string, unknown> {
  if (surface === 'api-adapter') {
    return {
      ...(config.surfaces.apiAdapter.activePackageId === packageId ? config.surfaces.apiAdapter.config : {}),
      ...(config.surfaces.apiAdapter.configByPackageId?.[packageId] ?? {})
    };
  }
  if (surface === 'transport') {
    return {
      ...(config.surfaces.transport.activePackageId === packageId ? config.surfaces.transport.config : {}),
      ...(config.surfaces.transport.configByPackageId?.[packageId] ?? {})
    };
  }
  if (surface === 'provider') {
    return {
      ...(config.surfaces.provider.activePackageId === packageId ? config.surfaces.provider.config : {}),
      ...(config.surfaces.provider.configByPackageId?.[packageId] ?? {})
    };
  }
  if (surface === 'plugin') {
    return config.surfaces.plugins.configByPackageId[packageId] ?? {};
  }
  return config.surfaces.skills.configByPackageId[packageId] ?? {};
}

function scalarPackageConfigInputText(value: unknown, label: string): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be a finite number.`);
    }
    return String(value);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  throw new Error(`${label} must be a string, number, or boolean.`);
}

function coercePackageConfigValue(input: {
  surface: PackageSurface;
  packageId: string;
  schema: JsonSchemaLike | undefined;
  key: string;
  rawValue: unknown;
}): string | boolean | number {
  if (input.surface === 'transport' || input.surface === 'provider') {
    return coerceSurfaceConfigInput({
      surface: input.surface,
      packageId: input.packageId,
      schema: input.schema,
      key: input.key,
      rawValue: input.rawValue
    });
  }

  const rawText = scalarPackageConfigInputText(input.rawValue, `${input.surface} config key ${input.key}`);
  if (!input.schema?.properties) {
    return rawText;
  }

  const property = input.schema.properties[input.key];
  if (!property) {
    throw new Error(`Unknown ${input.surface} config key ${input.key} for ${input.packageId}.`);
  }

  const required = new Set(input.schema.required ?? []);
  const trimmed = rawText.trim();
  if (required.has(input.key) && trimmed.length === 0) {
    throw new Error(`${input.surface} config key ${input.key} is required.`);
  }

  let value: string | boolean | number = rawText;
  if (property.type === 'boolean') {
    if (trimmed === 'true') {
      value = true;
    } else if (trimmed === 'false') {
      value = false;
    } else {
      throw new Error(`${input.surface} config key ${input.key} must be "true" or "false".`);
    }
  } else if (property.type === 'number') {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${input.surface} config key ${input.key} must be a finite number.`);
    }
    value = parsed;
  }

  if (property.enum && !property.enum.some((entry) => entry === value)) {
    throw new Error(
      `${input.surface} config key ${input.key} must be one of: ${property.enum.map((entry) => String(entry)).join(', ')}.`
    );
  }

  return value;
}

function isBuiltInPackage(surface: PackageSurface, packageId: string): boolean {
  void surface;
  void packageId;
  return false;
}

export class OperatorPackageService {
  private readonly inventory: PackageInventoryStore;
  private readonly installer: PackageInstaller;
  private readonly packageRegistry: PackageRegistryService;
  private readonly history = new GitHistoryService();
  private readonly homeRoot: string;

  constructor(
    private readonly config: MoorlineConfig,
    private readonly configPath: string,
    private readonly now: () => string = () => new Date().toISOString(),
    homeRoot = homeRootForRuntime(config.runtimeRoot)
  ) {
    this.inventory = new PackageInventoryStore(config.runtimeRoot);
    this.installer = new PackageInstaller(config.runtimeRoot, now);
    this.packageRegistry = new PackageRegistryService({ runtimeRoot: config.runtimeRoot });
    this.homeRoot = homeRoot;
  }

  ensureInitialized(): void {
    this.history.ensureInitializedSync(this.homeRoot);
    this.inventory.ensureInitialized();
    this.recoverInterruptedPackageOperation();
    const pendingRemovalRecovery = this.installer.recoverPendingRemovals();
    if (pendingRemovalRecovery.restored > 0 || pendingRemovalRecovery.cleaned > 0) {
      this.repairInventoryAgainstDisk();
      this.reconcileDesiredAndAppliedState();
    }
    const paths = runtimePaths(this.config.runtimeRoot);
    if (!existsSync(paths.runtimeRoot)) {
      throw new Error(`Runtime root does not exist: ${paths.runtimeRoot}`);
    }
  }

  private operationJournalPath(): string {
    return join(runtimePaths(this.config.runtimeRoot).stateDir, 'package-operation-journal.json');
  }

  private writeOperationJournal(operation: 'remove' | 'apply'): void {
    const payload = {
      version: 1 as const,
      operation,
      startedAt: this.now()
    };
    writeFileSync(this.operationJournalPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  private clearOperationJournal(): void {
    rmSync(this.operationJournalPath(), { force: true });
  }

  private markSetupIncomplete(): void {
    const nextSetup = {
      completed: false as const
    };
    if (JSON.stringify(this.config.setup) === JSON.stringify(nextSetup)) {
      return;
    }
    this.config.setup = nextSetup;
    saveMoorlineConfig(this.config, this.configPath);
  }

  private withOperationJournal<T>(operation: 'remove' | 'apply', work: () => T): T {
    this.writeOperationJournal(operation);
    try {
      const result = work();
      this.clearOperationJournal();
      return result;
    } catch (error) {
      this.recoverInterruptedPackageOperation();
      if (operation === 'apply') {
        this.markSetupIncomplete();
      }
      this.clearOperationJournal();
      throw error;
    }
  }

  private async withAsyncOperationJournal<T>(operation: 'remove' | 'apply', work: () => Promise<T>): Promise<T> {
    this.writeOperationJournal(operation);
    try {
      const result = await work();
      this.clearOperationJournal();
      return result;
    } catch (error) {
      this.recoverInterruptedPackageOperation();
      if (operation === 'apply') {
        this.markSetupIncomplete();
      }
      this.clearOperationJournal();
      throw error;
    }
  }

  private repairInventoryAgainstDisk(): boolean {
    const state = this.inventory.load();
    const filtered = state.installed.filter((entry) => existsSync(entry.installPath));
    if (filtered.length === state.installed.length) {
      return false;
    }
    state.installed = filtered;
    this.inventory.save(state);
    return true;
  }

  private backupCorruptOperationJournal(journalPath: string, error: unknown): void {
    const backupPath = `${journalPath}.corrupt-${Date.now()}`;
    try {
      copyFileSync(journalPath, backupPath);
    } catch {
      // Best effort backup; recovery still continues.
    }
    globalThis.console.warn(
      `[moorline:packages] Corrupt package operation journal recovered at ${journalPath}; backup written to ${backupPath}.`,
      error
    );
  }

  private recoverInterruptedPackageOperation(): void {
    const journalPath = this.operationJournalPath();
    if (!existsSync(journalPath)) {
      return;
    }
    let parsed: { operation?: unknown } | null = null;
    try {
      const decoded = JSON.parse(readFileSync(journalPath, 'utf8')) as unknown;
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error('operation journal payload must be a JSON object.');
      }
      parsed = decoded as { operation?: unknown };
    } catch (error) {
      this.backupCorruptOperationJournal(journalPath, error);
      this.clearOperationJournal();
      return;
    }
    if (parsed.operation !== 'remove' && parsed.operation !== 'apply') {
      this.clearOperationJournal();
      return;
    }
    this.repairInventoryAgainstDisk();
    this.reconcileDesiredAndAppliedState();
    this.clearOperationJournal();
  }

  private checkpoint(input: {
    actor: string;
    reason: string;
    operation: string;
    absoluteTargets?: string[];
    includeConfig?: boolean;
  }): void {
    recordHistoryCheckpoint({
      homeRoot: this.homeRoot,
      actor: input.actor,
      reason: input.reason,
      operation: input.operation,
      ...(input.absoluteTargets ? { absoluteTargets: input.absoluteTargets } : {}),
      ...(input.includeConfig ? { configPath: this.configPath } : {})
    });
  }

  listPackageCache(): PackageRegistryEntry[] {
    return this.packageRegistry.listCachedEntries();
  }

  async searchPackages(input: PackageSearchInput): Promise<PackageRegistryEntry[]> {
    return await this.packageRegistry.search(input);
  }

  async getPackageInfo(input: { kind?: PackageKind; packageId: string }): Promise<PackageRegistryEntry> {
    return await this.packageRegistry.getPackage(input);
  }

  exportShareBundle(productVersion = process.env.npm_package_version ?? '0.0.7'): MoorlineShareBundle {
    const inventory = this.inventory.load();
    const notes: string[] = [
      'Secrets are excluded from this bundle.',
      'This export captures configuration and package selections only, not runtime state.'
    ];
    const installed = inventory.installed.map((entry) => {
      if (entry.source.kind === 'local_dir' || entry.source.kind === 'local_archive') {
        notes.push(`Package ${entry.packageId} was installed from a local path and must be reinstalled manually by the recipient.`);
        return {
          kind: entry.kind,
          surface: entry.surface,
          packageId: entry.packageId,
          source: null,
          shareState: 'local_only' as const
        };
      }
      return {
        kind: entry.kind,
        surface: entry.surface,
        packageId: entry.packageId,
        source: entry.source,
        shareState: 'portable' as const
      };
    });

    return {
      version: 1,
      exportedAt: this.now(),
      productVersion,
      config: buildShareableMoorlineConfig(this.config),
      packages: {
        selectedApiAdapterPackageId: this.config.surfaces.apiAdapter.activePackageId,
        selectedTransportPackageId: this.config.surfaces.transport.activePackageId,
        selectedProviderPackageId: this.config.surfaces.provider.activePackageId,
        enabledPluginPackageIds: [...this.config.surfaces.plugins.enabledPackageIds].sort(),
        enabledSkillPackageIds: [...this.config.surfaces.skills.enabledPackageIds].sort(),
        installed
      },
      notes: [...new Set(notes)]
    };
  }

  listInstalled(surface?: PackageKind) {
    return this.inventory.list(surface);
  }

  getInventory() {
    return this.inventory.load();
  }

  getApplyPlan(): PackageApplyPlan {
    return createPackageApplyPlan(this.config, this.inventory.load());
  }

  private expectedPackageForEntry(entry: { kind: PackageKind; packageId: string; version?: string }) {
    return {
      kind: entry.kind,
      packageId: entry.packageId,
      version: entry.version
    };
  }

  private packageMetadataForEntry(entry: PackageRegistryEntry | PackageMetadataEntry): PackageMetadataEntry {
    return {
      kind: entry.kind,
      surface: entry.surface,
      packageId: entry.packageId,
      name: entry.name,
      description: entry.description,
      ...(entry.version ? { version: entry.version } : {}),
      tags: [...entry.tags],
      source: entry.source,
      requires: [...entry.requires],
      ...(entry.members ? { members: [...entry.members] } : {}),
      ...('suggestedAfterInstall' in entry && entry.suggestedAfterInstall ? { suggestedAfterInstall: [...entry.suggestedAfterInstall] } : {})
    };
  }

  private embeddedBundleMemberEntries(input: {
    bundleInstallPath: string;
    members: NonNullable<PackageMetadataEntry['members']>;
  }): PackageMetadataEntry[] {
    const entries: PackageMetadataEntry[] = [];
    for (const member of input.members) {
      const packageDir = join(input.bundleInstallPath, 'packages', packageInstallDirName(member.kind), ...member.packageId.split('/'));
      if (!existsSync(join(packageDir, 'manifest.json'))) {
        continue;
      }
      const loaded = loadInstallablePackageManifest(member.kind, packageDir);
      entries.push({
        kind: member.kind,
        surface: member.kind,
        packageId: loaded.manifest.id,
        name: loaded.manifest.name,
        description: loaded.manifest.description ?? loaded.manifest.id,
        version: loaded.manifest.version,
        tags: ['embedded'],
        source: {
          kind: 'local_dir',
          path: packageDir
        },
        requires: ('dependencies' in loaded.manifest ? loaded.manifest.dependencies ?? [] : []).map((dependency) => dependency.packageId)
      });
    }
    return entries;
  }

  async installPackage(input: {
    surface?: PackageKind;
    kind?: PackageKind;
    source?: PackageSourceDescriptor;
    packageId?: string;
  }) {
    const kind = input.kind ?? input.surface;
    if (!kind) {
      throw new Error('Package install requires a kind.');
    }
    const registryEntry = input.source || !input.packageId
      ? null
      : await this.packageRegistry.resolveInstallEntry({ kind, packageId: input.packageId });
    const source = input.source ?? registryEntry?.source ?? null;
    if (!source) {
      throw new Error('Package install requires a source descriptor or package id');
    }
    if (kind === 'bundle') {
      return await this.installBundle({ packageId: input.packageId, source, registryEntry: registryEntry ?? undefined });
    }
    const record = await this.installer.install({
      surface: kind,
      source,
      ...(registryEntry ? { expectedPackage: this.expectedPackageForEntry(registryEntry) } : {})
    });
    this.checkpoint({
      actor: 'system:package-manager',
      reason: `Installed ${record.surface} package ${record.packageId}.`,
      operation: `install ${record.packageId}`,
      absoluteTargets: [record.installPath]
    });
    this.reconcileDesiredAndAppliedState({ pruneDesiredSelections: false });
    return record;
  }

  private addBundleOwner(input: { kind: PackageKind; packageId: string; bundlePackageId: string }): void {
    const state = this.inventory.load();
    const record = state.installed.find((entry) => entry.kind === input.kind && entry.packageId === input.packageId);
    if (!record?.installedByPackageIds || record.installedByPackageIds.length === 0) {
      return;
    }
    record.installedByPackageIds = [...new Set([...record.installedByPackageIds, input.bundlePackageId])].sort();
    this.inventory.save(state);
  }

  private addBundleActivationOwner(input: { kind: PackageKind; packageId: string; bundlePackageId: string }): void {
    const state = this.inventory.load();
    const record = state.installed.find((entry) => entry.kind === input.kind && entry.packageId === input.packageId);
    if (!record) {
      return;
    }
    record.activatedByPackageIds = [...new Set([...(record.activatedByPackageIds ?? []), input.bundlePackageId])].sort();
    this.inventory.save(state);
  }

  private removeBundleOwner(input: { kind: PackageKind; packageId: string; bundlePackageId: string }): void {
    const state = this.inventory.load();
    const record = state.installed.find((entry) => entry.kind === input.kind && entry.packageId === input.packageId);
    if (!record?.installedByPackageIds?.includes(input.bundlePackageId)) {
      return;
    }
    const nextOwners = record.installedByPackageIds.filter((owner) => owner !== input.bundlePackageId);
    if (nextOwners.length > 0) {
      record.installedByPackageIds = nextOwners;
    } else {
      delete record.installedByPackageIds;
    }
    this.inventory.save(state);
  }

  private removeBundleActivationOwner(input: { kind: PackageKind; packageId: string; bundlePackageId: string }): string[] | null {
    const state = this.inventory.load();
    const record = state.installed.find((entry) => entry.kind === input.kind && entry.packageId === input.packageId);
    if (!record?.activatedByPackageIds?.includes(input.bundlePackageId)) {
      return null;
    }
    const nextOwners = record.activatedByPackageIds.filter((owner) => owner !== input.bundlePackageId);
    if (nextOwners.length > 0) {
      record.activatedByPackageIds = nextOwners;
    } else {
      delete record.activatedByPackageIds;
    }
    this.inventory.save(state);
    return nextOwners;
  }

  private packageIsDesiredActive(input: { kind: PackageKind; packageId: string }): boolean {
    if (input.kind === 'api-adapter') {
      return this.config.surfaces.apiAdapter.activePackageId === input.packageId;
    }
    if (input.kind === 'transport') {
      return this.config.surfaces.transport.activePackageId === input.packageId;
    }
    if (input.kind === 'provider') {
      return this.config.surfaces.provider.activePackageId === input.packageId;
    }
    if (input.kind === 'plugin') {
      return this.config.surfaces.plugins.enabledPackageIds.includes(input.packageId);
    }
    if (input.kind === 'skill') {
      return this.config.surfaces.skills.enabledPackageIds.includes(input.packageId);
    }
    return false;
  }

  private activationIsBundleOwned(input: { kind: PackageKind; packageId: string }): boolean {
    const record = this.inventory.get(input.kind, input.packageId);
    return (record?.activatedByPackageIds?.length ?? 0) > 0;
  }

  private removeBundleOwnedActivation(input: { kind: PackageKind; packageId: string; bundlePackageId: string }): void {
    const remainingOwners = this.removeBundleActivationOwner(input);
    if (remainingOwners === null) {
      return;
    }
    if (remainingOwners.length > 0 || !this.packageIsDesiredActive(input)) {
      return;
    }
    if (input.kind === 'api-adapter' || input.kind === 'transport' || input.kind === 'provider') {
      this.setSelectedPackage(input.kind, null);
      return;
    }
    if (input.kind === 'plugin' || input.kind === 'skill') {
      this.disablePackage(input.kind, input.packageId);
    }
  }

  private bundleMemberDependents(input: { kind: PackageKind; packageId: string }): string[] {
    return findDependentRecords(this.inventory.load().installed, input.kind, input.packageId)
      .map((entry) => `${entry.surface}:${entry.packageId}`)
      .sort();
  }

  private assertReplacementSatisfiesExistingBundleOwners(input: {
    kind: PackageKind;
    packageId: string;
    replacementVersion: string | undefined;
    ownerPackageIds: string[];
  }): void {
    const state = this.inventory.load();
    const conflicts: string[] = [];
    for (const ownerPackageId of input.ownerPackageIds) {
      const ownerBundle = state.installed.find((entry) => entry.kind === 'bundle' && entry.packageId === ownerPackageId);
      if (!ownerBundle) {
        conflicts.push(`${ownerPackageId} has no installed bundle record`);
        continue;
      }
      const ownerMember = (ownerBundle.members ?? []).find(
        (member) => member.kind === input.kind && member.packageId === input.packageId
      );
      if (!ownerMember) {
        conflicts.push(`${ownerPackageId} no longer declares ${input.kind}:${input.packageId}`);
        continue;
      }
      try {
        if (!packageVersionSatisfiesRange({
          packageId: input.packageId,
          version: input.replacementVersion,
          range: ownerMember.version
        })) {
          conflicts.push(`${ownerPackageId} requires ${ownerMember.version}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        conflicts.push(`${ownerPackageId} has invalid member constraint ${ownerMember.version}: ${detail}`);
      }
    }
    if (conflicts.length > 0) {
      throw new Error(
        `Cannot replace ${input.kind} package ${input.packageId} with version ${input.replacementVersion ?? '<missing>'}; ` +
          `existing bundle owner constraints would be violated: ${conflicts.join('; ')}.`
      );
    }
  }

  private async installBundle(input: { packageId?: string; source: PackageSourceDescriptor; registryEntry?: PackageRegistryEntry }) {
    const record = await this.installer.install({
      surface: 'bundle',
      source: input.source,
      ...(input.registryEntry ? { expectedPackage: this.expectedPackageForEntry(input.registryEntry) } : {})
    });
    const bundle: PackageMetadataEntry = input.registryEntry
      ? {
          ...this.packageMetadataForEntry(input.registryEntry),
          members: input.registryEntry.members && input.registryEntry.members.length > 0 ? input.registryEntry.members : record.members ?? []
        }
      : {
      kind: 'bundle' as const,
      surface: 'bundle' as const,
      packageId: record.packageId,
      name: record.name,
      description: record.description ?? record.packageId,
      version: record.version,
      tags: [],
      source: input.source,
      requires: [],
      members: record.members ?? []
    };
    let members: ReturnType<typeof resolveBundleMembers>;
    try {
      const requestedMembers = record.members ?? bundle.members ?? [];
      const embeddedMemberEntries = this.embeddedBundleMemberEntries({
        bundleInstallPath: record.installPath,
        members: requestedMembers
      });
      const embeddedKeys = new Set(embeddedMemberEntries.map((entry) => `${entry.kind}:${entry.packageId}`));
      const externalMembers = requestedMembers.filter((member) => !embeddedKeys.has(`${member.kind}:${member.packageId}`));
      const sourceMemberEntries: PackageMetadataEntry[] = externalMembers
        .filter((member): member is typeof member & { source: PackageSourceDescriptor } => Boolean(member.source))
        .map((member) => ({
          kind: member.kind,
          surface: member.kind,
          packageId: member.packageId,
          name: member.packageId,
          description: member.reason ?? member.packageId,
          version: member.version === '*' || member.version === 'latest' || member.version === 'stable' ? undefined : member.version,
          tags: ['member-source'],
          source: member.source!,
          requires: []
        }));
      const npmMembers = externalMembers.filter((member) => !member.source);
      const memberEntries = npmMembers.length > 0
        ? await this.packageRegistry.resolveBundleMemberEntries({ members: npmMembers })
        : [];
      members = resolveBundleMembers({
        entries: [
          ...embeddedMemberEntries,
          ...sourceMemberEntries,
          ...memberEntries.map((entry) => this.packageMetadataForEntry(entry))
        ],
        bundle
      });
    } catch (error) {
      try {
        this.installer.remove({ surface: 'bundle', packageId: record.packageId, cascade: true });
      } catch {
        // Best effort rollback; the resolution error below is the actionable failure.
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Bundle ${record.packageId} can only reference packages that can be resolved from embedded packages, member sources, or registry metadata. ${detail}`
      );
    }
    try {
      for (const resolved of members) {
        const existing = this.inventory.get(resolved.packageEntry.kind, resolved.packageEntry.packageId);
        if (!existing) {
          await this.installer.install({
            surface: resolved.packageEntry.kind,
            source: resolved.packageEntry.source,
            installedByPackageId: record.packageId,
            expectedPackage: this.expectedPackageForEntry(resolved.packageEntry)
          });
        } else {
          const satisfiesBundleRange = packageVersionSatisfiesRange({
            packageId: resolved.packageEntry.packageId,
            version: existing.version,
            range: resolved.member.version
          });
          if (!satisfiesBundleRange) {
            if (!existing.installedByPackageIds || existing.installedByPackageIds.length === 0) {
              throw new Error(
                `Installed ${resolved.packageEntry.kind} package ${existing.packageId}@${existing.version} does not satisfy bundle ` +
                  `${record.packageId} requirement ${resolved.member.version}. Remove or update it before installing the bundle.`
              );
            }
            this.assertReplacementSatisfiesExistingBundleOwners({
              kind: resolved.packageEntry.kind,
              packageId: resolved.packageEntry.packageId,
              replacementVersion: resolved.packageEntry.version,
              ownerPackageIds: existing.installedByPackageIds
            });
            await this.installer.install({
              surface: resolved.packageEntry.kind,
              source: resolved.packageEntry.source,
              installedByPackageId: record.packageId,
              expectedPackage: this.expectedPackageForEntry(resolved.packageEntry)
            });
          } else if (existing.installedByPackageIds && existing.installedByPackageIds.length > 0) {
            this.addBundleOwner({
              kind: resolved.packageEntry.kind,
              packageId: resolved.packageEntry.packageId,
              bundlePackageId: record.packageId
            });
          }
        }
        if (resolved.member.activation === 'select') {
          const shouldTrackActivation = !this.packageIsDesiredActive({
            kind: resolved.member.kind,
            packageId: resolved.packageEntry.packageId
          }) || this.activationIsBundleOwned({
            kind: resolved.member.kind,
            packageId: resolved.packageEntry.packageId
          });
          this.setSelectedPackage(resolved.member.kind as 'transport' | 'provider', resolved.packageEntry.packageId);
          if (shouldTrackActivation) {
            this.addBundleActivationOwner({
              kind: resolved.member.kind,
              packageId: resolved.packageEntry.packageId,
              bundlePackageId: record.packageId
            });
          }
        } else if (resolved.member.activation === 'enable') {
          const shouldTrackActivation = !this.packageIsDesiredActive({
            kind: resolved.member.kind,
            packageId: resolved.packageEntry.packageId
          }) || this.activationIsBundleOwned({
            kind: resolved.member.kind,
            packageId: resolved.packageEntry.packageId
          });
          this.enablePackage(resolved.member.kind as 'plugin' | 'skill', resolved.packageEntry.packageId);
          if (shouldTrackActivation) {
            this.addBundleActivationOwner({
              kind: resolved.member.kind,
              packageId: resolved.packageEntry.packageId,
              bundlePackageId: record.packageId
            });
          }
        }
      }
    } catch (error) {
      try {
        this.removeBundle({ packageId: record.packageId, cascade: true });
      } catch {
        // Best effort rollback. The member install error is the actionable failure.
      }
      throw error;
    }
    this.checkpoint({
      actor: 'system:package-manager',
      reason: `Installed bundle package ${record.packageId}.`,
      operation: `install ${record.packageId}`,
      absoluteTargets: [record.installPath]
    });
    this.reconcileDesiredAndAppliedState({ pruneDesiredSelections: false });
    return record;
  }

  removePackage(input: { surface?: PackageKind; kind?: PackageKind; packageId: string; cascade?: boolean }): void {
    const kind = input.kind ?? input.surface;
    if (!kind) {
      throw new Error('Package remove requires a kind.');
    }
    if (kind === 'bundle') {
      this.removeBundle({ packageId: input.packageId, cascade: input.cascade });
      return;
    }
    this.withOperationJournal('remove', () => {
      const existing = this.inventory.get(kind, input.packageId);
      this.installer.remove({ surface: kind, packageId: input.packageId, cascade: input.cascade });
      if (existing) {
        this.checkpoint({
          actor: 'system:package-manager',
          reason: `Removed ${kind} package ${input.packageId}.`,
          operation: `remove ${input.packageId}`,
          absoluteTargets: [existing.installPath]
        });
      }
      this.reconcileDesiredAndAppliedState();
    });
  }

  private removeBundle(input: { packageId: string; cascade?: boolean }): void {
    this.withOperationJournal('remove', () => {
      const state = this.inventory.load();
      const bundle = state.installed.find((entry) => entry.kind === 'bundle' && entry.packageId === input.packageId);
      if (!bundle) {
        this.installer.remove({ surface: 'bundle', packageId: input.packageId, cascade: input.cascade });
        return;
      }
      const keptMembers: string[] = [];
      for (const member of [...(bundle.members ?? [])].reverse()) {
        const installed = this.inventory.get(member.kind, member.packageId);
        if (!installed) {
          continue;
        }
        if (member.activation === 'select' || member.activation === 'enable') {
          this.removeBundleOwnedActivation({ kind: member.kind, packageId: member.packageId, bundlePackageId: input.packageId });
        }
        const owners = installed.installedByPackageIds ?? [];
        if (!owners.includes(input.packageId)) {
          keptMembers.push(`${member.kind}:${member.packageId} is manually installed`);
          continue;
        }
        if (owners.length > 1) {
          this.removeBundleOwner({ kind: member.kind, packageId: member.packageId, bundlePackageId: input.packageId });
          keptMembers.push(`${member.kind}:${member.packageId} is also owned by ${owners.filter((owner) => owner !== input.packageId).join(', ')}`);
          continue;
        }
        const dependents = this.bundleMemberDependents({ kind: member.kind, packageId: member.packageId });
        if (dependents.length > 0 && input.cascade !== true) {
          this.removeBundleOwner({ kind: member.kind, packageId: member.packageId, bundlePackageId: input.packageId });
          keptMembers.push(`${member.kind}:${member.packageId} is required by ${dependents.join(', ')}`);
          continue;
        }
        this.installer.remove({ surface: member.kind, packageId: member.packageId, cascade: input.cascade });
      }
      this.installer.remove({ surface: 'bundle', packageId: input.packageId, cascade: input.cascade });
      if (keptMembers.length > 0) {
        globalThis.console.warn(
          `[moorline:packages] Removed bundle ${input.packageId} but kept member package(s): ${keptMembers.join('; ')}.`
        );
      }
      this.checkpoint({
        actor: 'system:package-manager',
        reason:
          keptMembers.length > 0
            ? `Removed bundle package ${input.packageId}. Kept members: ${keptMembers.join('; ')}.`
            : `Removed bundle package ${input.packageId}.`,
        operation: `remove ${input.packageId}`,
        absoluteTargets: [bundle.installPath]
      });
      this.reconcileDesiredAndAppliedState();
    });
  }

  dependents(surface: PackageKind, packageId: string): string[] {
    return findDependents(this.inventory.load().installed, surface, packageId);
  }

  private installedLookup(state: ReturnType<PackageInventoryStore['load']>) {
    return {
      'api-adapter': new Set(state.installed.filter((entry) => entry.kind === 'api-adapter').map((entry) => entry.packageId)),
      transport: new Set(state.installed.filter((entry) => entry.kind === 'transport').map((entry) => entry.packageId)),
      provider: new Set(state.installed.filter((entry) => entry.kind === 'provider').map((entry) => entry.packageId)),
      plugin: new Set(state.installed.filter((entry) => entry.kind === 'plugin').map((entry) => entry.packageId)),
      skill: new Set(state.installed.filter((entry) => entry.kind === 'skill').map((entry) => entry.packageId))
    };
  }

  private requireInstalledPackage(
    state: ReturnType<PackageInventoryStore['load']>,
    surface: PackageSurface,
    packageId: string,
    operation: string
  ): void {
    if (isBuiltInPackage(surface, packageId)) {
      return;
    }
    if (!state.installed.some((entry) => entry.kind === surface && entry.packageId === packageId)) {
      throw new Error(`Cannot ${operation} ${surface} package ${packageId}; it is not installed.`);
    }
  }

  private deactivateDesiredPackagesWithActivationKey(state: ReturnType<PackageInventoryStore['load']>, uniqueKey: string, except?: { surface: PackageSurface; packageId: string }): void {
    for (const entry of state.installed) {
      if (entry.kind === 'bundle') {
        continue;
      }
      const surface = entry.surface as PackageSurface;
      if (except && entry.surface === except.surface && entry.packageId === except.packageId) {
        continue;
      }
      if (packageActivationUniqueKey(surface, entry) !== uniqueKey) {
        continue;
      }
      if (entry.surface === 'transport' && this.config.surfaces.transport.activePackageId === entry.packageId) {
        this.config.surfaces.transport.activePackageId = null;
      }
      if (entry.surface === 'api-adapter' && this.config.surfaces.apiAdapter.activePackageId === entry.packageId) {
        this.config.surfaces.apiAdapter.activePackageId = null;
      }
      if (entry.surface === 'provider' && this.config.surfaces.provider.activePackageId === entry.packageId) {
        this.config.surfaces.provider.activePackageId = null;
      }
      if (entry.surface === 'plugin') {
        this.config.surfaces.plugins.enabledPackageIds = this.config.surfaces.plugins.enabledPackageIds.filter((packageId) => packageId !== entry.packageId);
      }
      if (entry.surface === 'skill') {
        this.config.surfaces.skills.enabledPackageIds = this.config.surfaces.skills.enabledPackageIds.filter((packageId) => packageId !== entry.packageId);
      }
    }
  }

  private reconcileDesiredAndAppliedState(options: { pruneDesiredSelections?: boolean } = {}): void {
    const state = this.inventory.load();
    const installed = this.installedLookup(state);
    const pruneDesiredSelections = options.pruneDesiredSelections !== false;
    let configChanged = false;
    let inventoryChanged = false;

    if (pruneDesiredSelections) {
      if (
        this.config.surfaces.apiAdapter.activePackageId &&
        !installed['api-adapter'].has(this.config.surfaces.apiAdapter.activePackageId)
      ) {
        this.config.surfaces.apiAdapter.activePackageId = null;
        this.config.surfaces.apiAdapter.config = {};
        configChanged = true;
      }
      if (this.config.surfaces.transport.activePackageId && !installed.transport.has(this.config.surfaces.transport.activePackageId)) {
        this.config.surfaces.transport.activePackageId = null;
        this.config.surfaces.transport.config = {};
        configChanged = true;
      }
      if (this.config.surfaces.provider.activePackageId && !installed.provider.has(this.config.surfaces.provider.activePackageId)) {
        this.config.surfaces.provider.activePackageId = null;
        this.config.surfaces.provider.config = {};
        configChanged = true;
      }
    }

    if (
      this.config.transport &&
      (
        !this.config.surfaces.transport.activePackageId ||
        this.config.transport.packageId !== this.config.surfaces.transport.activePackageId ||
        !installed.transport.has(this.config.transport.packageId)
      )
    ) {
      delete this.config.transport;
      configChanged = true;
    }
    if (
      this.config.provider &&
      (
        !this.config.surfaces.provider.activePackageId ||
        this.config.provider.packageId !== this.config.surfaces.provider.activePackageId ||
        !installed.provider.has(this.config.provider.packageId)
      )
    ) {
      delete this.config.provider;
      configChanged = true;
    }

    for (const packageId of Object.keys(this.config.surfaces.apiAdapter.configByPackageId ?? {})) {
      if (!installed['api-adapter'].has(packageId)) {
        delete this.config.surfaces.apiAdapter.configByPackageId?.[packageId];
        configChanged = true;
      }
    }
    for (const packageId of Object.keys(this.config.surfaces.transport.configByPackageId ?? {})) {
      if (!installed.transport.has(packageId)) {
        delete this.config.surfaces.transport.configByPackageId?.[packageId];
        configChanged = true;
      }
    }
    for (const packageId of Object.keys(this.config.surfaces.provider.configByPackageId ?? {})) {
      if (!installed.provider.has(packageId)) {
        delete this.config.surfaces.provider.configByPackageId?.[packageId];
        configChanged = true;
      }
    }

    const normalizedEnabledPlugins = [...new Set(this.config.surfaces.plugins.enabledPackageIds.filter((entry) => installed.plugin.has(entry)))].sort();
    if (JSON.stringify(normalizedEnabledPlugins) !== JSON.stringify(this.config.surfaces.plugins.enabledPackageIds)) {
      this.config.surfaces.plugins.enabledPackageIds = normalizedEnabledPlugins;
      configChanged = true;
    }
    const normalizedEnabledSkills = [...new Set(this.config.surfaces.skills.enabledPackageIds.filter((entry) => installed.skill.has(entry)))].sort();
    if (JSON.stringify(normalizedEnabledSkills) !== JSON.stringify(this.config.surfaces.skills.enabledPackageIds)) {
      this.config.surfaces.skills.enabledPackageIds = normalizedEnabledSkills;
      configChanged = true;
    }

    for (const packageId of Object.keys(this.config.surfaces.plugins.configByPackageId)) {
      if (!installed.plugin.has(packageId)) {
        delete this.config.surfaces.plugins.configByPackageId[packageId];
        configChanged = true;
      }
    }
    for (const packageId of Object.keys(this.config.surfaces.skills.configByPackageId)) {
      if (!installed.skill.has(packageId)) {
        delete this.config.surfaces.skills.configByPackageId[packageId];
        configChanged = true;
      }
    }

    const normalizedApplied = appliedPackageRefs(state.applied).filter((entry) => installed[entry.surface].has(entry.packageId));
    if (JSON.stringify(normalizedApplied) !== JSON.stringify(state.applied.activated)) {
      state.applied.activated = normalizedApplied;
      inventoryChanged = true;
    }

    const startability = evaluateRuntimeStartability(this.config, state);
    const nextSetup = startability.startable
      ? {
          completed: true,
          completedAt: this.config.setup.completedAt ?? this.now()
        }
      : {
          completed: false
        };
    if (JSON.stringify(nextSetup) !== JSON.stringify(this.config.setup)) {
      this.config.setup = nextSetup;
      configChanged = true;
    }

    if (configChanged) {
      saveMoorlineConfig(this.config, this.configPath);
    }
    if (inventoryChanged) {
      this.inventory.save(state);
    }
  }

  setSelectedPackage(surface: 'api-adapter' | 'transport' | 'provider', packageId: string | null): void {
    const state = this.inventory.load();
    if (packageId) {
      this.requireInstalledPackage(state, surface, packageId, 'select');
      const record = state.installed.find((entry) => entry.surface === surface && entry.packageId === packageId);
      const uniqueKey = packageActivationUniqueKey(surface, record);
      if (uniqueKey) {
        this.deactivateDesiredPackagesWithActivationKey(state, uniqueKey, { surface, packageId });
      }
    }
    if (surface === 'api-adapter') {
      this.config.surfaces.apiAdapter.activePackageId = packageId;
      if (packageId === null) {
        this.config.surfaces.apiAdapter.config = {};
      } else {
        const savedConfig = this.config.surfaces.apiAdapter.configByPackageId?.[packageId];
        this.config.surfaces.apiAdapter.config = {
          ...(savedConfig ?? {})
        };
      }
    } else if (surface === 'transport') {
      this.config.surfaces.transport.activePackageId = packageId;
      if (packageId === null) {
        this.config.surfaces.transport.config = {};
      } else {
        this.config.surfaces.transport.config = {
          ...(this.config.surfaces.transport.configByPackageId?.[packageId] ?? this.config.surfaces.transport.config)
        };
      }
    } else {
      this.config.surfaces.provider.activePackageId = packageId;
      if (packageId === null) {
        this.config.surfaces.provider.config = {};
      } else {
        this.config.surfaces.provider.config = {
          ...(this.config.surfaces.provider.configByPackageId?.[packageId] ?? this.config.surfaces.provider.config)
        };
      }
    }
    saveMoorlineConfig(this.config, this.configPath);
    this.reconcileDesiredAndAppliedState();
    this.checkpoint({
      actor: 'system:package-manager',
      reason: `Selected ${surface} package ${packageId ?? 'none'}.`,
      operation: `select ${surface}`,
      includeConfig: true
    });
  }

  activatePackage(surface: PackageSurface, packageId: string): void {
    const state = this.inventory.load();
    this.requireInstalledPackage(state, surface, packageId, 'activate');
    if (surface === 'api-adapter' || surface === 'transport' || surface === 'provider') {
      this.setSelectedPackage(surface, packageId);
      return;
    }
    if (surface === 'plugin' || surface === 'skill') {
      this.enablePackage(surface, packageId);
    }
  }

  deactivatePackage(surface: PackageSurface, packageId: string): void {
    const state = this.inventory.load();
    this.requireInstalledPackage(state, surface, packageId, 'deactivate');
    if (surface === 'api-adapter' && this.config.surfaces.apiAdapter.activePackageId === packageId) {
      this.setSelectedPackage(surface, null);
      return;
    }
    if (surface === 'transport' && this.config.surfaces.transport.activePackageId === packageId) {
      this.setSelectedPackage(surface, null);
      return;
    }
    if (surface === 'provider' && this.config.surfaces.provider.activePackageId === packageId) {
      this.setSelectedPackage(surface, null);
      return;
    }
    if (surface === 'plugin' || surface === 'skill') {
      this.disablePackage(surface, packageId);
    }
  }

  setPackageConfigValues(input: {
    surface: PackageSurface;
    packageId: string;
    values: PackageConfigValues;
    secretReplacements?: PackageConfigReplacement[];
  }): void {
    const state = this.inventory.load();
    this.requireInstalledPackage(state, input.surface, input.packageId, 'configure');
    const schema = resolvePackageConfigSchema({
      runtimeRoot: this.config.runtimeRoot,
      surface: input.surface,
      packageId: input.packageId
    });
    const currentRoot = packageConfigRootIfPresent(this.config, input.surface, input.packageId);
    const nextRoot = { ...currentRoot };
    if (input.surface === 'api-adapter') {
      delete nextRoot[input.packageId];
    }
    const replacements = input.secretReplacements ?? [];
    for (const [key, rawValue] of Object.entries(input.values)) {
      nextRoot[key] = coercePackageConfigValue({
        surface: input.surface,
        packageId: input.packageId,
        schema,
        key,
        rawValue
      });
    }
    for (const replacement of replacements) {
      if (replacement.value.trim().length === 0) {
        continue;
      }
      const property = schema?.properties?.[replacement.key];
      if (!property || property.secret !== true) {
        throw new Error(`${input.surface} config key ${replacement.key} is not a secret field for ${input.packageId}.`);
      }
      nextRoot[replacement.key] = coercePackageConfigValue({
        surface: input.surface,
        packageId: input.packageId,
        schema,
        key: replacement.key,
        rawValue: replacement.value
      });
    }
    const targetRoot = packageConfigRoot(this.config, input.surface, input.packageId);
    for (const key of Object.keys(targetRoot)) {
      delete targetRoot[key];
    }
    Object.assign(targetRoot, nextRoot);
    if (input.surface === 'api-adapter') {
      delete targetRoot[input.packageId];
    }
    if (input.surface === 'api-adapter' && this.config.surfaces.apiAdapter.activePackageId === input.packageId) {
      this.config.surfaces.apiAdapter.config = { ...targetRoot };
    }
    if (input.surface === 'transport' && this.config.surfaces.transport.activePackageId === input.packageId) {
      this.config.surfaces.transport.config = { ...targetRoot };
    }
    if (input.surface === 'provider' && this.config.surfaces.provider.activePackageId === input.packageId) {
      this.config.surfaces.provider.config = { ...targetRoot };
    }
    saveMoorlineConfig(this.config, this.configPath);
    this.reconcileDesiredAndAppliedState();
    this.checkpoint({
      actor: 'system:package-manager',
      reason: `Updated ${input.surface} package configuration for ${input.packageId}.`,
      operation: `config ${input.surface}`,
      includeConfig: true
    });
  }

  enablePackage(surface: 'plugin' | 'skill', packageId: string): void {
    const state = this.inventory.load();
    this.requireInstalledPackage(state, surface, packageId, 'enable');
    const record = state.installed.find((entry) => entry.surface === surface && entry.packageId === packageId);
    const uniqueKey = packageActivationUniqueKey(surface, record);
    if (uniqueKey) {
      this.deactivateDesiredPackagesWithActivationKey(state, uniqueKey, { surface, packageId });
    }
    const target = surface === 'plugin' ? this.config.surfaces.plugins.enabledPackageIds : this.config.surfaces.skills.enabledPackageIds;
    if (!target.includes(packageId)) {
      target.push(packageId);
      target.sort();
    }
    saveMoorlineConfig(this.config, this.configPath);
    this.reconcileDesiredAndAppliedState();
    this.checkpoint({
      actor: 'system:package-manager',
      reason: `Enabled ${surface} package ${packageId}.`,
      operation: `enable ${packageId}`,
      includeConfig: true
    });
  }

  disablePackage(surface: 'plugin' | 'skill', packageId: string): void {
    const next = (surface === 'plugin' ? this.config.surfaces.plugins.enabledPackageIds : this.config.surfaces.skills.enabledPackageIds).filter(
      (entry) => entry !== packageId
    );
    if (surface === 'plugin') {
      this.config.surfaces.plugins.enabledPackageIds = next;
    } else {
      this.config.surfaces.skills.enabledPackageIds = next;
    }
    saveMoorlineConfig(this.config, this.configPath);
    this.reconcileDesiredAndAppliedState();
    this.checkpoint({
      actor: 'system:package-manager',
      reason: `Disabled ${surface} package ${packageId}.`,
      operation: `disable ${packageId}`,
      includeConfig: true
    });
  }

  private async completeSelectedTransportConfig(): Promise<void> {
    const packageId = this.config.surfaces.transport.activePackageId;
    if (!packageId) {
      return;
    }
    const pkg = await loadTransportPackageById({
      runtimeRoot: this.config.runtimeRoot,
      packageId,
      config: this.config
    });
    if (!pkg.completeConfig) {
      return;
    }

    const currentRoot = packageConfigRootIfPresent(this.config, 'transport', packageId);
    const completed = await pkg.completeConfig({
      config: { ...currentRoot }
    });
    if (!completed || typeof completed !== 'object' || !completed.config || typeof completed.config !== 'object' || Array.isArray(completed.config)) {
      throw new Error(`Transport package ${packageId} returned invalid completed config.`);
    }

    const targetRoot = packageConfigRoot(this.config, 'transport', packageId);
    for (const key of Object.keys(targetRoot)) {
      delete targetRoot[key];
    }
    Object.assign(targetRoot, {
      ...currentRoot,
      ...completed.config
    });
    this.config.surfaces.transport.config = { ...targetRoot };
  }

  async apply(): Promise<PackageApplyPlan> {
    return await this.withAsyncOperationJournal('apply', async () => {
      let state = this.inventory.load();
      let plan: PackageApplyPlan;
      try {
        this.reconcileDesiredAndAppliedState();
        await this.completeSelectedTransportConfig();
        state = this.inventory.load();
        const startability = evaluateRuntimeStartability(this.config, state);
        if (!startability.startable) {
          throw new Error(startability.issues.join('\n'));
        }
        plan = createPackageApplyPlan(this.config, state);
        if (plan.errors.length > 0) {
          throw new Error(plan.errors.map((entry) => entry.detail).join('\n'));
        }
      } catch (error) {
        this.markSetupIncomplete();
        throw error;
      }

      const applied = buildRequiredAppliedSurfaceConfigs(this.config);
      this.config.transport = applied.transport;
      this.config.provider = applied.provider;
      state.applied = {
        activated: desiredPackageRefsFromConfig(this.config)
      };
      this.config.setup = {
        completed: true,
        completedAt: this.config.setup.completedAt ?? this.now()
      };
      saveMoorlineConfig(this.config, this.configPath);
      this.inventory.save(state);
      this.reconcileDesiredAndAppliedState();
      this.checkpoint({
        actor: 'system:package-manager',
        reason: 'Applied desired package state to the runtime configuration.',
        operation: 'apply packages',
        includeConfig: true
      });
      return createPackageApplyPlan(this.config, this.inventory.load());
    });
  }
}
