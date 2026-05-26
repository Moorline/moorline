import type { MoorlineConfig } from '../../../types/config.js';
import type { PackageApplyPlan, PackageDesiredState } from '../../../types/package.js';
import { buildAppliedSurfaceConfigs } from '../../system/config/configStore.js';
import {
  desiredPackageRefsFromConfig,
  sortPackageRefs,
  appliedPackageRefs,
  isPackageActivated,
  isBuiltInActivatedPackage
} from './packageActivation.js';
import { resolvePackageDependencyErrors } from './packageDependencyResolver.js';
import type { PackageInventoryState } from './packageInventoryStore.js';

function desiredPackageStateFromConfig(config: MoorlineConfig): PackageDesiredState {
  return {
    activated: desiredPackageRefsFromConfig(config)
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function sameConfig(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left ?? null)) === JSON.stringify(canonicalize(right ?? null));
}

export function createPackageApplyPlan(config: MoorlineConfig, inventory: PackageInventoryState): PackageApplyPlan {
  const desired = desiredPackageStateFromConfig(config);
  const applied = { activated: appliedPackageRefs(inventory.applied) };
  const installedBySurface = {
    'api-adapter': new Set(inventory.installed.filter((entry) => entry.kind === 'api-adapter').map((entry) => entry.packageId)),
    transport: new Set(inventory.installed.filter((entry) => entry.kind === 'transport').map((entry) => entry.packageId)),
    provider: new Set(inventory.installed.filter((entry) => entry.kind === 'provider').map((entry) => entry.packageId)),
    plugin: new Set(inventory.installed.filter((entry) => entry.kind === 'plugin').map((entry) => entry.packageId)),
    skill: new Set(inventory.installed.filter((entry) => entry.kind === 'skill').map((entry) => entry.packageId))
  };
  const errors = resolvePackageDependencyErrors({
    installed: inventory.installed,
    desired,
    applied
  });
  for (const ref of desired.activated) {
    if (isBuiltInActivatedPackage(ref)) {
      continue;
    }
    if (!installedBySurface[ref.surface].has(ref.packageId)) {
      errors.push({
        code: 'unknown_package',
        kind: ref.surface,
        surface: ref.surface,
        packageId: ref.packageId,
        detail: `Activated ${ref.surface} package ${ref.packageId} is not installed.`
      });
    }
  }
  const actions: string[] = [];

  for (const ref of sortPackageRefs(desired.activated)) {
    if (!isPackageActivated(applied.activated, ref)) {
      actions.push(`Activate ${ref.surface} package ${ref.packageId}`);
    }
  }
  for (const ref of sortPackageRefs(applied.activated)) {
    if (!isPackageActivated(desired.activated, ref)) {
      actions.push(`Deactivate ${ref.surface} package ${ref.packageId}`);
    }
  }

  const desiredAppliedConfig = buildAppliedSurfaceConfigs(config);
  if (config.surfaces.transport.activePackageId && config.transport && desiredAppliedConfig.transport && !sameConfig(desiredAppliedConfig.transport, config.transport)) {
    actions.push('Update transport configuration');
  }
  if (config.surfaces.provider.activePackageId && config.provider && desiredAppliedConfig.provider && !sameConfig(desiredAppliedConfig.provider, config.provider)) {
    actions.push('Update provider configuration');
  }

  return {
    desired,
    applied,
    pending: actions.length > 0,
    actions,
    reloadLevel: actions.length === 0 ? 'none' : 'runtime_reload',
    errors
  };
}
