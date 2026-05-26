import semver from 'semver';
import type { PackageBundleMember, PackageCatalogEntry, PackageKind } from '../../../types/package.js';
import { getOfficialCatalog } from './officialCatalog.js';
import { NpmRegistryClient, npmNameForOfficialPackageId } from './npmRegistryClient.js';
import type { PackageRegistryEntry, PackageSearchInput } from './packageRegistryTypes.js';

function officialRegistryEntry(entry: PackageCatalogEntry): PackageRegistryEntry {
  return {
    ...entry,
    schemaVersion: 1,
    trustLevel: 'official',
    registrySource: 'official_catalog',
    publisher: 'Moorline'
  };
}

function dedupeEntries(entries: PackageRegistryEntry[]): PackageRegistryEntry[] {
  const byKey = new Map<string, PackageRegistryEntry>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.packageId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }
    if (existing.registrySource === 'official_catalog') {
      continue;
    }
    if (entry.registrySource === 'official_catalog') {
      byKey.set(key, entry);
      continue;
    }
    if ((entry.version && existing.version && semver.gt(entry.version, existing.version)) || !existing.version) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort((left, right) => left.packageId.localeCompare(right.packageId));
}

function matchesQuery(entry: PackageRegistryEntry, query: string | undefined): boolean {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    entry.packageId,
    entry.name,
    entry.description,
    entry.publisher,
    entry.kind,
    ...(entry.tags ?? [])
  ].some((value) => value.toLowerCase().includes(normalized));
}

export class PackageRegistryService {
  private readonly npmClient: NpmRegistryClient;
  private npmCache: PackageRegistryEntry[] = [];

  constructor(npmClient = new NpmRegistryClient()) {
    this.npmClient = npmClient;
  }

  listCachedCatalog(): PackageRegistryEntry[] {
    return dedupeEntries([
      ...getOfficialCatalog().map(officialRegistryEntry),
      ...this.npmCache
    ]);
  }

  async search(input: PackageSearchInput = {}): Promise<PackageRegistryEntry[]> {
    let npmEntries: PackageRegistryEntry[] = [];
    try {
      npmEntries = await this.npmClient.search(input);
      this.npmCache = [...this.npmCache, ...npmEntries];
    } catch {
      npmEntries = [];
    }
    return dedupeEntries([
      ...getOfficialCatalog().map(officialRegistryEntry),
      ...npmEntries
    ])
      .filter((entry) => !input.kind || entry.kind === input.kind)
      .filter((entry) => matchesQuery(entry, input.query));
  }

  async getPackage(input: { kind?: PackageKind; packageId: string }): Promise<PackageRegistryEntry> {
    const official = getOfficialCatalog().find((entry) => entry.packageId === input.packageId && (!input.kind || entry.kind === input.kind));
    if (official) {
      return officialRegistryEntry(official);
    }
    const npmMatches = await this.npmClient.findByPackageId(input);
    const resolved = this.resolveNpmMatches(input.packageId, npmMatches);
    this.npmCache = [...this.npmCache, resolved];
    return resolved;
  }

  async resolveInstallEntry(input: { kind: PackageKind; packageId: string }): Promise<PackageRegistryEntry> {
    const entry = await this.getPackage(input);
    if (entry.kind !== input.kind) {
      throw new Error(`Package ${input.packageId} is a ${entry.kind} package, not ${input.kind}.`);
    }
    return entry;
  }

  async resolveBundleMemberEntries(input: { members: PackageBundleMember[] }): Promise<PackageRegistryEntry[]> {
    const entries: PackageRegistryEntry[] = [];
    for (const member of input.members) {
      entries.push(await this.resolveInstallEntry({
        kind: member.kind,
        packageId: member.packageId
      }));
    }
    return dedupeEntries(entries);
  }

  private resolveNpmMatches(packageId: string, matches: PackageRegistryEntry[]): PackageRegistryEntry {
    if (matches.length === 0) {
      throw new Error(`Unknown package ${packageId}.`);
    }
    const expectedOfficialNpmName = npmNameForOfficialPackageId(packageId);
    if (expectedOfficialNpmName) {
      const official = matches.find((entry) => entry.npm?.packageName === expectedOfficialNpmName);
      if (official) {
        return official;
      }
      throw new Error(`Official package ${packageId} must be published as ${expectedOfficialNpmName}.`);
    }
    const uniqueNames = [...new Set(matches.map((entry) => entry.npm?.packageName ?? entry.packageId))];
    if (uniqueNames.length > 1) {
      throw new Error(`Package id conflict for ${packageId}: ${uniqueNames.join(', ')}.`);
    }
    return matches[0]!;
  }
}
