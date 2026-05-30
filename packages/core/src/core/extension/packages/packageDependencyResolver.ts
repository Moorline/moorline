import type {
  PackageAppliedState,
  PackageDesiredState,
  PackageInstallRecord,
  PackageKind,
  PackageResolutionError,
  PackageSurface
} from '../../../types/package.js';
import { appliedPackageRefs, isPackageActivated } from './packageActivation.js';

interface DependentPackageRecord {
  surface: PackageSurface;
  packageId: string;
}

function dependencyNodeId(surface: PackageSurface, packageId: string): string {
  return `${surface}:${packageId}`;
}

function recordKind(entry: PackageInstallRecord): PackageKind {
  return entry.kind ?? entry.surface;
}

function dependenciesFor(entry: PackageInstallRecord): PackageInstallRecord['dependencies'] {
  return Array.isArray(entry.dependencies) ? entry.dependencies : [];
}

export function resolvePackageDependencyErrors(input: {
  installed: PackageInstallRecord[];
  desired: PackageDesiredState;
  applied?: PackageAppliedState;
}): PackageResolutionError[] {
  const activated = input.applied ? appliedPackageRefs(input.applied) : input.desired.activated;
  const installedByKey = new Map(
    input.installed
      .filter((entry) => recordKind(entry) !== 'bundle')
      .map((entry) => [dependencyNodeId(recordKind(entry) as PackageSurface, entry.packageId), entry] as const)
  );
  const errors: PackageResolutionError[] = [];

  for (const entry of input.installed) {
    const kind = recordKind(entry);
    if (kind === 'bundle') {
      continue;
    }
    const isRelevant = isPackageActivated(activated, { surface: kind, packageId: entry.packageId });
    if (!isRelevant) {
      continue;
    }

    for (const dependency of dependenciesFor(entry)) {
      const dependent = installedByKey.get(dependencyNodeId(dependency.surface, dependency.packageId));
      if (!dependent) {
        errors.push({
          code: 'missing_dependency',
          kind: kind as PackageSurface,
          surface: kind as PackageSurface,
          packageId: entry.packageId,
          detail: `${entry.packageId} requires ${dependency.surface} package ${dependency.packageId} to be installed.`,
          dependency
        });
        continue;
      }
      if (dependency.requiredState === 'active') {
        if (!isPackageActivated(activated, dependency)) {
          errors.push({
            code: 'inactive_dependency',
            kind: kind as PackageSurface,
            surface: kind as PackageSurface,
            packageId: entry.packageId,
            detail: `${entry.packageId} requires active ${dependency.surface} package ${dependency.packageId}.`,
            dependency
          });
        }
      }
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const entry of input.installed) {
    const kind = recordKind(entry);
    if (kind === 'bundle') {
      continue;
    }
    adjacency.set(
      dependencyNodeId(kind as PackageSurface, entry.packageId),
      dependenciesFor(entry).map((dependency) => dependencyNodeId(dependency.surface, dependency.packageId))
    );
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (node: string): void => {
    if (visiting.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = cycleStart === -1 ? [...path, node] : [...path.slice(cycleStart), node];
      const [surface, packageId] = node.split(':');
      errors.push({
        code: 'dependency_cycle',
        kind: surface as PackageSurface,
        surface: surface as PackageSurface,
        packageId,
        detail: `Dependency cycle detected: ${cycle.join(' -> ')}`
      });
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visiting.add(node);
    path.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (adjacency.has(next)) {
        visit(next);
      }
    }
    path.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of adjacency.keys()) {
    visit(node);
  }

  return errors;
}

export function findDependentRecords(
  installed: PackageInstallRecord[],
  surface: PackageKind,
  packageId: string
): DependentPackageRecord[] {
  if (surface === 'bundle') {
    return [];
  }
  return installed
    .filter((entry) => dependenciesFor(entry).some((dependency) => dependency.surface === surface && dependency.packageId === packageId))
    .filter((entry) => recordKind(entry) !== 'bundle')
    .map((entry) => ({ surface: recordKind(entry) as PackageSurface, packageId: entry.packageId }))
    .sort((left, right) =>
      left.surface === right.surface ? left.packageId.localeCompare(right.packageId) : left.surface.localeCompare(right.surface)
    );
}

export function findDependents(installed: PackageInstallRecord[], surface: PackageKind, packageId: string): string[] {
  return findDependentRecords(installed, surface, packageId).map((entry) => entry.packageId);
}
