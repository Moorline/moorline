import type { MoorlineConfig } from '../../../types/config.js';
import type { PackageAppliedState, PackageInstallRecord, PackageRef, PackageSurface } from '../../../types/package.js';

export function packageKey(ref: PackageRef): string {
  return `${ref.surface}:${ref.packageId}`;
}

export function samePackageRef(left: PackageRef, right: PackageRef): boolean {
  return left.surface === right.surface && left.packageId === right.packageId;
}

export function sortPackageRefs(refs: PackageRef[]): PackageRef[] {
  return [...refs].sort((left, right) => packageKey(left).localeCompare(packageKey(right)));
}

export function uniquePackageRefs(refs: PackageRef[]): PackageRef[] {
  const seen = new Set<string>();
  const unique: PackageRef[] = [];
  for (const ref of refs) {
    const key = packageKey(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ surface: ref.surface, packageId: ref.packageId });
  }
  return sortPackageRefs(unique);
}

export function activatedPackageRefsFromLegacyState(input: {
  transportActivePackageId?: string | null;
  providerActivePackageId?: string | null;
  enabledPluginPackageIds?: string[];
  enabledSkillPackageIds?: string[];
  apiAdapterActivePackageId?: string | null;
}): PackageRef[] {
  return uniquePackageRefs([
    ...(input.apiAdapterActivePackageId ? [{ surface: 'api-adapter' as const, packageId: input.apiAdapterActivePackageId }] : []),
    ...(input.transportActivePackageId ? [{ surface: 'transport' as const, packageId: input.transportActivePackageId }] : []),
    ...(input.providerActivePackageId ? [{ surface: 'provider' as const, packageId: input.providerActivePackageId }] : []),
    ...(input.enabledPluginPackageIds ?? []).map((packageId) => ({ surface: 'plugin' as const, packageId })),
    ...(input.enabledSkillPackageIds ?? []).map((packageId) => ({ surface: 'skill' as const, packageId }))
  ]);
}

export function desiredPackageRefsFromConfig(config: MoorlineConfig): PackageRef[] {
  return activatedPackageRefsFromLegacyState({
    transportActivePackageId: config.surfaces.transport.activePackageId,
    providerActivePackageId: config.surfaces.provider.activePackageId,
    apiAdapterActivePackageId: config.surfaces.apiAdapter.activePackageId,
    enabledPluginPackageIds: config.surfaces.plugins.enabledPackageIds,
    enabledSkillPackageIds: config.surfaces.skills.enabledPackageIds
  });
}

export function appliedPackageRefs(state: PackageAppliedState): PackageRef[] {
  if (state.activated && state.activated.length > 0) {
    return uniquePackageRefs(state.activated);
  }
  return activatedPackageRefsFromLegacyState({
    transportActivePackageId: state.transportActivePackageId,
    providerActivePackageId: state.providerActivePackageId,
    enabledPluginPackageIds: state.enabledPluginPackageIds,
    enabledSkillPackageIds: state.enabledSkillPackageIds
  });
}

export function isPackageActivated(refs: PackageRef[], ref: PackageRef): boolean {
  return refs.some((entry) => samePackageRef(entry, ref));
}

export function isBuiltInActivatedPackage(ref: Pick<PackageRef, 'surface' | 'packageId'>): boolean {
  return ref.surface === 'api-adapter' && ref.packageId === 'official/http';
}

export function packageActivationUniqueKey(surface: PackageSurface, record?: Pick<PackageInstallRecord, 'surface' | 'activation'>): string | null {
  if (record?.activation?.uniqueKey) {
    return record.activation.uniqueKey;
  }
  const targetSurface = record?.surface ?? surface;
  if (targetSurface === 'api-adapter' || targetSurface === 'transport' || targetSurface === 'provider') {
    return targetSurface;
  }
  return null;
}

export function activatedPackageForUniqueKey(refs: PackageRef[], uniqueKey: string): PackageRef | null {
  return refs.find((ref) => packageActivationUniqueKey(ref.surface) === uniqueKey) ?? null;
}

export function activatePackageRef(refs: PackageRef[], ref: PackageRef): PackageRef[] {
  const uniqueKey = packageActivationUniqueKey(ref.surface);
  const filtered = uniqueKey
    ? refs.filter((entry) => packageActivationUniqueKey(entry.surface) !== uniqueKey)
    : refs;
  return uniquePackageRefs([...filtered, ref]);
}

export function deactivatePackageRef(refs: PackageRef[], ref: PackageRef): PackageRef[] {
  return uniquePackageRefs(refs.filter((entry) => !samePackageRef(entry, ref)));
}
