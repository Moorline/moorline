import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  packageFamilyForKind,
  type PackageInstallRecord,
  type PackageKind,
  type PackageSourceDescriptor
} from '../../../types/package.js';
import { loadInstallablePackageManifest } from './packageManifest.js';
import { PackageInventoryStore } from './packageInventoryStore.js';
import { cleanupResolvedPackageSource, resolvePackageSource } from './packageSource.js';
import { findDependentRecords, resolvePackageDependencyErrors } from './packageDependencyResolver.js';
import { validateInstalledPackage } from './packageValidation.js';
import { appliedPackageRefs, deactivatePackageRef } from './packageActivation.js';
import { packageVersionSatisfiesRange } from './packageVersionResolver.js';

function installRoot(runtimeRoot: string, surface: PackageKind): string {
  const dirName =
    surface === 'api-adapter'
      ? 'api-adapters'
      : surface === 'bundle'
        ? 'bundles'
        : `${surface}s`;
  return join(runtimeRoot, 'packages', dirName);
}

function assertWithinRoot(rootPath: string, candidatePath: string, label: string): void {
  const normalizedRoot = resolve(rootPath);
  const normalizedCandidate = resolve(candidatePath);
  const rel = relative(normalizedRoot, normalizedCandidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return;
  }
  throw new Error(`${label} escapes install root: ${candidatePath}`);
}

function packageInstallPath(runtimeRoot: string, surface: PackageKind, packageId: string): string {
  const root = resolve(installRoot(runtimeRoot, surface));
  const target = resolve(root, ...packageId.split('/'));
  assertWithinRoot(root, target, `Package ${packageId}`);
  return target;
}

function declaredRuntimeDependencyNames(packageDir: string): string[] {
  const packageJsonPath = join(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, unknown>;
  };
  return Object.keys(parsed.dependencies ?? {}).sort();
}

function outputTail(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length <= 2000 ? trimmed : trimmed.slice(-2000);
}

function hydrateArchivedRuntimeDependencies(packageDir: string): void {
  const dependencies = declaredRuntimeDependencyNames(packageDir);
  if (dependencies.length === 0) {
    return;
  }
  const result = spawnSync('npm', [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false'
  ], {
    cwd: packageDir,
    encoding: 'utf8'
  });
  if (result.error) {
    throw new Error(`Unable to install package runtime dependencies: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = outputTail(result.stderr) || outputTail(result.stdout);
    throw new Error(`Unable to install package runtime dependencies${detail ? `: ${detail}` : '.'}`);
  }
}

function assertReplacementSatisfiesExistingBundleOwners(input: {
  installed: PackageInstallRecord[];
  kind: PackageKind;
  packageId: string;
  replacementVersion: string | undefined;
  ownerPackageIds: string[];
}): void {
  const conflicts: string[] = [];
  for (const ownerPackageId of input.ownerPackageIds) {
    const ownerBundle = input.installed.find((entry) => entry.kind === 'bundle' && entry.packageId === ownerPackageId);
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

export class PackageInstaller {
  private readonly inventory: PackageInventoryStore;

  constructor(private readonly runtimeRoot: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.inventory = new PackageInventoryStore(runtimeRoot);
  }

  async install(input: {
    surface: PackageKind;
    source: PackageSourceDescriptor;
    installedByPackageId?: string;
    expectedPackage?: {
      kind: PackageKind;
      packageId: string;
      version?: string;
    };
  }): Promise<PackageInstallRecord> {
    const resolved = await resolvePackageSource(input.source);
    const stagingId = randomUUID();
    try {
      const loaded = loadInstallablePackageManifest(input.surface, resolved.packageDir);
      if (input.expectedPackage) {
        const mismatches: string[] = [];
        if (input.surface !== input.expectedPackage.kind) {
          mismatches.push(`kind ${input.surface} did not match ${input.expectedPackage.kind}`);
        }
        if (loaded.manifest.id !== input.expectedPackage.packageId) {
          mismatches.push(`package id ${loaded.manifest.id} did not match ${input.expectedPackage.packageId}`);
        }
        if (input.expectedPackage.version && loaded.manifest.version !== input.expectedPackage.version) {
          mismatches.push(`version ${loaded.manifest.version} did not match ${input.expectedPackage.version}`);
        }
        if (mismatches.length > 0) {
          throw new Error(
            `Downloaded package archive did not match registry metadata for ${input.expectedPackage.packageId}: ${mismatches.join('; ')}.`
          );
        }
      }
      const targetPath = packageInstallPath(this.runtimeRoot, input.surface, loaded.manifest.id);
      const stagingPath = `${targetPath}.staging-${stagingId}`;
      mkdirSync(dirname(targetPath), { recursive: true });
      rmSync(stagingPath, { recursive: true, force: true });
      cpSync(resolved.packageDir, stagingPath, { recursive: true });
      if (input.source.kind !== 'local_dir') {
        hydrateArchivedRuntimeDependencies(stagingPath);
      }
      try {
        await validateInstalledPackage(input.surface, stagingPath);
      } catch (error) {
        rmSync(stagingPath, { recursive: true, force: true });
        throw error;
      }

      const state = this.inventory.load();
      const record: PackageInstallRecord = {
        family: packageFamilyForKind(input.surface),
        kind: input.surface,
        surface: input.surface,
        packageId: loaded.manifest.id,
        name: loaded.manifest.name,
        version: loaded.manifest.version,
        ...(loaded.manifest.description ? { description: loaded.manifest.description } : {}),
        installedAt: this.now(),
        installPath: targetPath,
        source: input.source,
        manifestPath: join(targetPath, 'manifest.json'),
        manifestHash: loaded.manifestHash,
        dependencies: loaded.manifest.dependencies ?? [],
        ...(loaded.manifest.activation ? { activation: loaded.manifest.activation } : {}),
        ...('members' in loaded.manifest ? { members: loaded.manifest.members } : {}),
        ...(input.installedByPackageId ? { installedByPackageIds: [input.installedByPackageId] } : {})
      };
      const previous = state.installed.find((entry) => entry.kind === input.surface && entry.packageId === loaded.manifest.id);
      const ownerPackageIds = [
        ...(previous?.installedByPackageIds ?? []),
        ...(input.installedByPackageId ? [input.installedByPackageId] : [])
      ];
      if (ownerPackageIds.length > 0) {
        assertReplacementSatisfiesExistingBundleOwners({
          installed: state.installed,
          kind: input.surface,
          packageId: loaded.manifest.id,
          replacementVersion: loaded.manifest.version,
          ownerPackageIds
        });
        record.installedByPackageIds = [...new Set(ownerPackageIds)].sort();
      }
      if (previous?.activatedByPackageIds && previous.activatedByPackageIds.length > 0) {
        record.activatedByPackageIds = [...new Set(previous.activatedByPackageIds)].sort();
      }
      state.installed = state.installed.filter((entry) => !(entry.kind === input.surface && entry.packageId === loaded.manifest.id));
      state.installed.push(record);
      const errors = resolvePackageDependencyErrors({
        installed: state.installed,
        desired: {
          activated: appliedPackageRefs(state.applied)
        }
      }).filter((entry) => entry.packageId === record.packageId && entry.kind === record.kind);
      if (errors.some((entry) => entry.code === 'dependency_cycle')) {
        rmSync(stagingPath, { recursive: true, force: true });
        throw new Error(errors[0]?.detail ?? `Unable to install ${record.packageId}`);
      }
      const backupPath = existsSync(targetPath) ? `${targetPath}.backup-${stagingId}` : null;
      if (backupPath) {
        renameSync(targetPath, backupPath);
      }
      try {
        renameSync(stagingPath, targetPath);
      } catch (error) {
        if (backupPath && !existsSync(targetPath) && existsSync(backupPath)) {
          renameSync(backupPath, targetPath);
        }
        throw error;
      } finally {
        if (backupPath) {
          rmSync(backupPath, { recursive: true, force: true });
        }
      }
      this.inventory.save(state);
      return record;
    } finally {
      cleanupResolvedPackageSource(resolved);
    }
  }

  remove(input: { surface: PackageKind; packageId: string; cascade?: boolean }): void {
    const state = this.inventory.load();
    const stagedRemovals: Array<{ originalPath: string; backupPath: string }> = [];
    try {
      this.removeFromState(state, input, new Set<string>(), stagedRemovals);
      this.inventory.save(state);
      for (const staged of stagedRemovals) {
        if (existsSync(staged.backupPath)) {
          rmSync(staged.backupPath, { recursive: true, force: true });
        }
      }
    } catch (error) {
      for (const staged of [...stagedRemovals].reverse()) {
        if (!existsSync(staged.originalPath) && existsSync(staged.backupPath)) {
          renameSync(staged.backupPath, staged.originalPath);
        }
      }
      throw error;
    }
  }

  recoverPendingRemovals(): { restored: number; cleaned: number } {
    let restored = 0;
    let cleaned = 0;
    const roots = (['api-adapter', 'transport', 'provider', 'plugin', 'skill', 'bundle'] as const).map((surface) =>
      installRoot(this.runtimeRoot, surface)
    );
    const stack = [...roots];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || !existsSync(current)) {
        continue;
      }
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const child = join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.includes('.removing-')) {
            const marker = '.removing-';
            const markerIndex = child.lastIndexOf(marker);
            const originalPath = markerIndex >= 0 ? child.slice(0, markerIndex) : null;
            if (!originalPath) {
              continue;
            }
            if (existsSync(originalPath)) {
              rmSync(child, { recursive: true, force: true });
              cleaned += 1;
              continue;
            }
            renameSync(child, originalPath);
            restored += 1;
            continue;
          }
          stack.push(child);
        }
      }
    }
    return { restored, cleaned };
  }

  private removeFromState(
    state: ReturnType<PackageInventoryStore['load']>,
    input: { surface: PackageKind; packageId: string; cascade?: boolean },
    visited: Set<string>,
    stagedRemovals: Array<{ originalPath: string; backupPath: string }>
  ): void {
    const key = `${input.surface}:${input.packageId}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    const dependentRecords = findDependentRecords(state.installed, input.surface, input.packageId);
    if (dependentRecords.length > 0 && input.cascade !== true) {
      const dependents = dependentRecords.map((entry) => `${entry.surface}:${entry.packageId}`);
      throw new Error(`Cannot remove ${input.packageId}; dependents present: ${dependents.join(', ')}`);
    }
    if (input.cascade === true) {
      for (const dependent of dependentRecords) {
        this.removeFromState(
          state,
          { surface: dependent.surface, packageId: dependent.packageId, cascade: true },
          visited,
          stagedRemovals
        );
      }
    }
    const installPath = packageInstallPath(this.runtimeRoot, input.surface, input.packageId);
    if (existsSync(installPath)) {
      const backupPath = `${installPath}.removing-${randomUUID()}`;
      renameSync(installPath, backupPath);
      stagedRemovals.push({
        originalPath: installPath,
        backupPath
      });
    }
    state.installed = state.installed.filter((entry) => !(entry.kind === input.surface && entry.packageId === input.packageId));
    if (input.surface !== 'bundle') {
      state.applied.activated = deactivatePackageRef(state.applied.activated, {
        surface: input.surface,
        packageId: input.packageId
      });
    }
  }
}
