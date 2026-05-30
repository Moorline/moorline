import semver from 'semver';
import type { PackageBundleMember, PackageMetadataEntry, PackageKind } from '../../../types/package.js';

export interface ResolvedBundleMember {
  member: PackageBundleMember;
  packageEntry: PackageMetadataEntry;
}

export function assertValidPackageVersion(input: { packageId: string; version: string | undefined }): void {
  if (!input.version || !semver.valid(input.version)) {
    throw new Error(`Package ${input.packageId} has invalid semantic version ${input.version ?? '<missing>'}.`);
  }
}

export function assertValidPackageRange(input: { packageId: string; range: string }): void {
  if (input.range === 'latest' || input.range === 'stable') {
    return;
  }
  if (!semver.validRange(input.range)) {
    throw new Error(`Package ${input.packageId} has invalid semantic version range ${input.range}.`);
  }
}

function matchesRange(entry: PackageMetadataEntry, range: string): boolean {
  if (!entry.version) {
    return false;
  }
  assertValidPackageVersion({ packageId: entry.packageId, version: entry.version });
  if (range === 'latest' || range === 'stable' || range === '*') {
    return true;
  }
  return semver.satisfies(entry.version, range);
}

export function packageVersionSatisfiesRange(input: {
  packageId: string;
  version: string | undefined;
  range: string;
}): boolean {
  assertValidPackageVersion({ packageId: input.packageId, version: input.version });
  assertValidPackageRange({ packageId: input.packageId, range: input.range });
  const version = input.version;
  if (!version) {
    return false;
  }
  if (input.range === 'latest' || input.range === 'stable' || input.range === '*') {
    return true;
  }
  return semver.satisfies(version, input.range);
}

export function resolvePackageMetadata(input: {
  entries: PackageMetadataEntry[];
  kind: PackageKind;
  packageId: string;
  versionRange?: string;
}): PackageMetadataEntry {
  const range = input.versionRange ?? '*';
  assertValidPackageRange({ packageId: input.packageId, range });
  const candidates = input.entries
    .filter((entry) => entry.kind === input.kind && entry.packageId === input.packageId && matchesRange(entry, range))
    .sort((left, right) => {
      if (!left.version && !right.version) {
        return 0;
      }
      if (!left.version) {
        return 1;
      }
      if (!right.version) {
        return -1;
      }
      return semver.rcompare(left.version, right.version);
    });
  const resolved = candidates[0];
  if (!resolved) {
    throw new Error(`No package metadata entry satisfies ${input.kind} package ${input.packageId}@${range}.`);
  }
  return resolved;
}

export function resolveBundleMembers(input: {
  entries: PackageMetadataEntry[];
  bundle: PackageMetadataEntry;
}): ResolvedBundleMember[] {
  if (input.bundle.kind !== 'bundle') {
    throw new Error(`Package ${input.bundle.packageId} is not a bundle.`);
  }
  const members = input.bundle.members ?? [];
  if (members.length === 0) {
    throw new Error(`Bundle ${input.bundle.packageId} has no members.`);
  }
  return members.map((member) => ({
    member,
    packageEntry: resolvePackageMetadata({
      entries: input.entries,
      kind: member.kind,
      packageId: member.packageId,
      versionRange: member.version
    })
  }));
}
