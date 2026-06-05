import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  packageFamilyForKind,
  validatePackageBundleMembers,
  validatePackageDependencies,
  validatePackageId,
  type PackageAppliedState,
  type PackageInstallRecord,
  type PackageKind,
  type PackageRef,
  type PackageSourceProvenance,
  type PackageSurface
} from '../../../types/package.js';
import { writeFileAtomicSync } from '../../shared/fs/atomicWrite.js';
import { activatedPackageRefsFromLegacyState, appliedPackageRefs, uniquePackageRefs } from './packageActivation.js';

export interface PackageInventoryState {
  version: 1;
  installed: PackageInstallRecord[];
  applied: PackageAppliedState;
}

interface PackageInventoryRecoveryReport {
  recovered: boolean;
  droppedInstalledRecords: number;
  normalizedFields: string[];
  detail: string;
}

const DEFAULT_APPLIED: PackageAppliedState = {
  activated: []
};

function defaultState(): PackageInventoryState {
  return {
    version: 1,
    installed: [],
    applied: { ...DEFAULT_APPLIED }
  };
}

function inventoryPath(runtimeRoot: string): string {
  return join(runtimeRoot, 'state', 'package-inventory.json');
}

function isKind(value: unknown): value is PackageKind {
  return value === 'api-adapter' || value === 'transport' || value === 'provider' || value === 'plugin' || value === 'skill' || value === 'bundle';
}

function isSurface(value: unknown): value is PackageSurface {
  return value === 'api-adapter' || value === 'transport' || value === 'provider' || value === 'plugin' || value === 'skill';
}

function normalizeSource(value: unknown): PackageInstallRecord['source'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  if (source.kind === 'local_dir' || source.kind === 'local_archive') {
    if (typeof source.path !== 'string' || !source.path.trim()) {
      return null;
    }
    return {
      kind: source.kind,
      path: source.path
    };
  }
  if (source.kind === 'remote_archive') {
    if (typeof source.url !== 'string' || !source.url.trim()) {
      return null;
    }
    const provenance = normalizeSourceProvenance(source.provenance);
    return {
      kind: source.kind,
      url: source.url,
      ...(typeof source.sha256 === 'string' && source.sha256.trim() ? { sha256: source.sha256 } : {}),
      ...(typeof source.integrity === 'string' && source.integrity.trim() ? { integrity: source.integrity } : {}),
      ...(provenance ? { provenance } : {})
    };
  }
  return null;
}

function normalizeSourceProvenance(value: unknown): PackageSourceProvenance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const provenance = value as Record<string, unknown>;
  if (provenance.type === 'npm') {
    if (
      typeof provenance.registryUrl !== 'string' ||
      !provenance.registryUrl.trim() ||
      typeof provenance.packageName !== 'string' ||
      !provenance.packageName.trim() ||
      typeof provenance.version !== 'string' ||
      !provenance.version.trim()
    ) {
      return null;
    }
    return {
      type: 'npm',
      registryUrl: provenance.registryUrl,
      packageName: provenance.packageName,
      version: provenance.version,
      ...(typeof provenance.integrity === 'string' && provenance.integrity.trim() ? { integrity: provenance.integrity } : {})
    };
  }
  if (provenance.type === 'github_release') {
    return {
      type: 'github_release',
      ...(typeof provenance.repository === 'string' && provenance.repository.trim() ? { repository: provenance.repository } : {}),
      ...(typeof provenance.releaseRef === 'string' && provenance.releaseRef.trim() ? { releaseRef: provenance.releaseRef } : {}),
      ...(typeof provenance.assetName === 'string' && provenance.assetName.trim() ? { assetName: provenance.assetName } : {})
    };
  }
  if (provenance.type === 'direct_url') {
    return {
      type: 'direct_url'
    };
  }
  return null;
}

function normalizeInstalledRecord(value: unknown): PackageInstallRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const kind = entry.kind ?? entry.surface;
  if (!isKind(kind)) {
    return null;
  }
  if (typeof entry.packageId !== 'string') {
    return null;
  }
  const packageId = (() => {
    try {
      return validatePackageId(entry.packageId, 'package inventory package id');
    } catch {
      return null;
    }
  })();
  if (!packageId) {
    return null;
  }
  const source = normalizeSource(entry.source);
  if (!source) {
    return null;
  }
  if (
    typeof entry.name !== 'string' ||
    !entry.name.trim() ||
    typeof entry.version !== 'string' ||
    !entry.version.trim() ||
    typeof entry.installedAt !== 'string' ||
    !entry.installedAt.trim() ||
    typeof entry.installPath !== 'string' ||
    !entry.installPath.trim() ||
    typeof entry.manifestPath !== 'string' ||
    !entry.manifestPath.trim() ||
    typeof entry.manifestHash !== 'string' ||
    !entry.manifestHash.trim()
  ) {
    return null;
  }
  const dependencies = (() => {
    try {
      return validatePackageDependencies(entry.dependencies, `package inventory entry ${packageId}`);
    } catch {
      return [];
    }
  })();
  const members = (() => {
    if (kind !== 'bundle') {
      return undefined;
    }
    try {
      return validatePackageBundleMembers(entry.members, `package inventory entry ${packageId}`);
    } catch {
      return [];
    }
  })();
  const installedByPackageIds = Array.isArray(entry.installedByPackageIds)
    ? entry.installedByPackageIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).sort()
    : [];
  return {
    family: packageFamilyForKind(kind),
    kind,
    surface: kind,
    packageId,
    name: entry.name,
    version: entry.version,
    ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    installedAt: entry.installedAt,
    installPath: entry.installPath,
    source,
    manifestPath: entry.manifestPath,
    manifestHash: entry.manifestHash,
    dependencies,
    ...(entry.activation && typeof entry.activation === 'object' && !Array.isArray(entry.activation)
      ? { activation: { ...(typeof (entry.activation as Record<string, unknown>).uniqueKey === 'string' ? { uniqueKey: (entry.activation as Record<string, string>).uniqueKey } : {}) } }
      : {}),
    ...(members ? { members } : {}),
    ...(installedByPackageIds.length > 0 ? { installedByPackageIds } : {})
  };
}

function normalizeLoadedState(raw: unknown): { state: PackageInventoryState; report: PackageInventoryRecoveryReport } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('package-inventory.json must contain a JSON object.');
  }
  const parsed = raw as Partial<PackageInventoryState>;
  if (parsed.installed !== undefined && !Array.isArray(parsed.installed)) {
    throw new Error('package-inventory.json.installed must be an array when provided.');
  }
  if (parsed.applied !== undefined && (!parsed.applied || typeof parsed.applied !== 'object' || Array.isArray(parsed.applied))) {
    throw new Error('package-inventory.json.applied must be an object when provided.');
  }
  const installedRaw = Array.isArray(parsed.installed) ? parsed.installed : [];
  const installed = installedRaw.map((entry) => normalizeInstalledRecord(entry)).filter((entry): entry is PackageInstallRecord => entry !== null);
  const appliedRaw = (parsed.applied ?? {}) as Record<string, unknown>;

  const normalizedFields: string[] = [];
  if (installed.length !== installedRaw.length) {
    normalizedFields.push('installed');
  }
  const normalizeAppliedPackageId = (
    value: unknown,
    label: string
  ): { packageId: string | null; normalized: boolean } => {
    if (value === undefined || value === null) {
      return { packageId: null, normalized: false };
    }
    if (typeof value !== 'string') {
      return { packageId: null, normalized: true };
    }
    try {
      return {
        packageId: validatePackageId(value, label),
        normalized: false
      };
    } catch {
      return {
        packageId: null,
        normalized: true
      };
    }
  };

  const normalizeAppliedPackageIds = (
    value: unknown,
    label: string
  ): { packageIds: string[]; normalized: boolean } => {
    if (value === undefined) {
      return { packageIds: [], normalized: false };
    }
    if (!Array.isArray(value)) {
      return { packageIds: [], normalized: true };
    }

    const packageIds: string[] = [];
    let normalized = false;
    for (const entry of value) {
      if (typeof entry !== 'string') {
        normalized = true;
        continue;
      }
      try {
        const packageId = validatePackageId(entry, `${label} package id`);
        if (!packageIds.includes(packageId)) {
          packageIds.push(packageId);
        } else {
          normalized = true;
        }
      } catch {
        normalized = true;
      }
    }

    return { packageIds, normalized };
  };

  const normalizeAppliedRefs = (value: unknown, label: string): { refs: PackageRef[]; normalized: boolean } => {
    if (value === undefined) {
      return { refs: [], normalized: false };
    }
    if (!Array.isArray(value)) {
      return { refs: [], normalized: true };
    }
    const refs: PackageRef[] = [];
    let normalized = false;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        normalized = true;
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (!isSurface(record.surface)) {
        normalized = true;
        continue;
      }
      try {
        refs.push({
          surface: record.surface,
          packageId: validatePackageId(record.packageId, `${label}.packageId`)
        });
      } catch {
        normalized = true;
      }
    }
    const unique = uniquePackageRefs(refs);
    return { refs: unique, normalized: normalized || unique.length !== refs.length };
  };

  const transportActive = normalizeAppliedPackageId(appliedRaw.transportActivePackageId, 'applied.transportActivePackageId');
  if (transportActive.normalized) {
    normalizedFields.push('applied.transportActivePackageId');
  }

  const providerActive = normalizeAppliedPackageId(appliedRaw.providerActivePackageId, 'applied.providerActivePackageId');
  if (providerActive.normalized) {
    normalizedFields.push('applied.providerActivePackageId');
  }

  const enabledPlugins = normalizeAppliedPackageIds(appliedRaw.enabledPluginPackageIds, 'applied.enabledPluginPackageIds');
  if (enabledPlugins.normalized) {
    normalizedFields.push('applied.enabledPluginPackageIds');
  }

  const enabledSkills = normalizeAppliedPackageIds(appliedRaw.enabledSkillPackageIds, 'applied.enabledSkillPackageIds');
  if (enabledSkills.normalized) {
    normalizedFields.push('applied.enabledSkillPackageIds');
  }

  const activated = normalizeAppliedRefs(appliedRaw.activated, 'applied.activated');
  if (activated.normalized) {
    normalizedFields.push('applied.activated');
  }

  const state: PackageInventoryState = {
    version: 1,
    installed,
    applied: {
      activated:
        appliedRaw.activated !== undefined
          ? activated.refs
          : activatedPackageRefsFromLegacyState({
              transportActivePackageId: transportActive.packageId,
              providerActivePackageId: providerActive.packageId,
              enabledPluginPackageIds: enabledPlugins.packageIds,
              enabledSkillPackageIds: enabledSkills.packageIds
            })
    }
  };

  return {
    state,
    report: {
      recovered: normalizedFields.length > 0,
      droppedInstalledRecords: installedRaw.length - installed.length,
      normalizedFields: [...new Set(normalizedFields)].sort(),
      detail:
        normalizedFields.length > 0
          ? `Recovered package inventory by normalizing ${[...new Set(normalizedFields)].sort().join(', ')}`
          : 'Package inventory loaded without recovery.'
    }
  };
}

export class PackageInventoryStore {
  private lastRecovery: PackageInventoryRecoveryReport = {
    recovered: false,
    droppedInstalledRecords: 0,
    normalizedFields: [],
    detail: 'Package inventory has not been loaded yet.'
  };

  constructor(private readonly runtimeRoot: string) {}

  path(): string {
    return inventoryPath(this.runtimeRoot);
  }

  load(): PackageInventoryState {
    const path = this.path();
    if (!existsSync(path)) {
      this.lastRecovery = {
        recovered: false,
        droppedInstalledRecords: 0,
        normalizedFields: [],
        detail: 'Package inventory file not found; using default state.'
      };
      return defaultState();
    }
    try {
      const normalized = normalizeLoadedState(JSON.parse(readFileSync(path, 'utf8')) as unknown);
      this.lastRecovery = normalized.report;
      if (normalized.report.recovered) {
        globalThis.console.warn(
          `[moorline:packages] ${normalized.report.detail} (dropped records: ${normalized.report.droppedInstalledRecords})`
        );
      }
      return normalized.state;
    } catch (error) {
      const backupPath = `${path}.corrupt-${Date.now()}`;
      try {
        copyFileSync(path, backupPath);
      } catch {
        // Best effort corruption backup.
      }
      this.lastRecovery = {
        recovered: true,
        droppedInstalledRecords: 0,
        normalizedFields: ['*'],
        detail: `Recovered from corrupt package inventory at ${path}; backup written to ${backupPath}.`
      };
      globalThis.console.warn(
        `[moorline:packages] Recovered from corrupt package inventory at ${path}; backup written to ${backupPath}.`,
        error
      );
      return defaultState();
    }
  }

  save(state: PackageInventoryState): void {
    const path = this.path();
    const persisted: PackageInventoryState = {
      ...state,
      installed: [...state.installed],
      applied: {
        activated: appliedPackageRefs(state.applied)
      }
    };
    writeFileAtomicSync(path, `${JSON.stringify(persisted, null, 2)}\n`);
  }

  ensureInitialized(): PackageInventoryState {
    const state = this.load();
    this.save(state);
    return state;
  }

  list(surface?: PackageKind): PackageInstallRecord[] {
    const state = this.load();
    return surface ? state.installed.filter((entry) => entry.kind === surface) : state.installed;
  }

  get(surface: PackageKind, packageId: string): PackageInstallRecord | null {
    return this.load().installed.find((entry) => entry.kind === surface && entry.packageId === packageId) ?? null;
  }

  lastRecoveryReport(): PackageInventoryRecoveryReport {
    return this.lastRecovery;
  }
}
