import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import semver from 'semver';
import type { PackageBundleMember, PackageKind } from '../../../types/package.js';
import { writeFileAtomicSync } from '../../shared/fs/atomicWrite.js';
import { NpmRegistryClient, npmNameForPackageId } from './npmRegistryClient.js';
import type { PackageRegistryEntry, PackageSearchInput } from './packageRegistryTypes.js';

interface PackageRegistryCacheFile {
  version: 1;
  registryUrl: string;
  refreshedAt: string;
  entries: PackageRegistryEntry[];
}

function cachePath(runtimeRoot: string): string {
  return join(runtimeRoot, 'state', 'package-registry-cache.json');
}

function cloneEntryForCache(entry: PackageRegistryEntry): PackageRegistryEntry {
  return {
    ...entry,
    registrySource: 'local_cache'
  };
}

function cachedEntryMatchesExpectedNpmName(entry: PackageRegistryEntry): boolean {
  const expectedNpmName = npmNameForPackageId(entry.packageId);
  return !expectedNpmName || entry.npm?.packageName === expectedNpmName;
}

function dedupeEntries(entries: PackageRegistryEntry[]): PackageRegistryEntry[] {
  const byKey = new Map<string, PackageRegistryEntry>();
  for (const entry of entries.filter(cachedEntryMatchesExpectedNpmName)) {
    const key = `${entry.kind}:${entry.packageId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }
    if (entry.registrySource === 'npm' && existing.registrySource !== 'npm') {
      byKey.set(key, entry);
      continue;
    }
    if (
      entry.registrySource === existing.registrySource &&
      entry.version &&
      existing.version &&
      semver.valid(entry.version) &&
      semver.valid(existing.version) &&
      semver.gt(entry.version, existing.version)
    ) {
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
    entry.kind,
    ...(entry.tags ?? [])
  ].some((value) => value.toLowerCase().includes(normalized));
}

function loadCache(path: string, registryUrl: string): PackageRegistryEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PackageRegistryCacheFile>;
    if (parsed.version !== 1 || parsed.registryUrl !== registryUrl || !Array.isArray(parsed.entries)) {
      return [];
    }
    return parsed.entries
      .map(cloneEntryForCache)
      .filter(cachedEntryMatchesExpectedNpmName);
  } catch {
    return [];
  }
}

function saveCache(path: string, registryUrl: string, entries: PackageRegistryEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload: PackageRegistryCacheFile = {
    version: 1,
    registryUrl,
    refreshedAt: new Date().toISOString(),
    entries: dedupeEntries(entries).map(cloneEntryForCache)
  };
  writeFileAtomicSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function requireInstallableCachedEntry(entry: PackageRegistryEntry): PackageRegistryEntry {
  if (!cachedEntryMatchesExpectedNpmName(entry)) {
    throw new Error(`Cached package ${entry.packageId} does not match its expected npm package name.`);
  }
  if (entry.source.kind !== 'remote_archive' || entry.source.provenance?.type !== 'npm' || !entry.source.integrity) {
    throw new Error(`Cached package ${entry.packageId} is not installable without refreshing npm metadata.`);
  }
  return entry;
}

export class PackageRegistryService {
  private readonly npmClient: NpmRegistryClient;
  private readonly cacheFilePath: string | null;
  private memoryCache: PackageRegistryEntry[];

  constructor(input?: { runtimeRoot?: string; npmClient?: NpmRegistryClient } | NpmRegistryClient) {
    const options = input && 'findByPackageId' in input ? { npmClient: input as NpmRegistryClient } : input;
    this.npmClient = options?.npmClient ?? new NpmRegistryClient();
    this.cacheFilePath = options?.runtimeRoot ? cachePath(options.runtimeRoot) : null;
    this.memoryCache = this.cacheFilePath ? loadCache(this.cacheFilePath, this.npmClient.registryUrl) : [];
  }

  listCachedEntries(): PackageRegistryEntry[] {
    return dedupeEntries(this.memoryCache);
  }

  async search(input: PackageSearchInput = {}): Promise<PackageRegistryEntry[]> {
    try {
      const npmEntries = await this.npmClient.search(input);
      this.memoryCache = dedupeEntries([...npmEntries, ...this.memoryCache]);
      if (this.cacheFilePath) {
        saveCache(this.cacheFilePath, this.npmClient.registryUrl, this.memoryCache);
      }
      return npmEntries.filter((entry) => matchesQuery(entry, input.query));
    } catch {
      return this.memoryCache
        .filter((entry) => !input.kind || entry.kind === input.kind)
        .filter((entry) => matchesQuery(entry, input.query));
    }
  }

  async getPackage(input: { kind?: PackageKind; packageId: string; allowCacheOnly?: boolean }): Promise<PackageRegistryEntry> {
    try {
      const npmMatches = await this.npmClient.findByPackageId(input);
      const resolved = this.resolveNpmMatches(input.packageId, npmMatches);
      this.memoryCache = dedupeEntries([resolved, ...this.memoryCache]);
      if (this.cacheFilePath) {
        saveCache(this.cacheFilePath, this.npmClient.registryUrl, this.memoryCache);
      }
      return resolved;
    } catch (error) {
      const cached = this.memoryCache.find((entry) => entry.packageId === input.packageId && (!input.kind || entry.kind === input.kind));
      if (cached && input.allowCacheOnly) {
        return cached;
      }
      throw error;
    }
  }

  async resolveInstallEntry(input: { kind: PackageKind; packageId: string }): Promise<PackageRegistryEntry> {
    try {
      const entry = await this.getPackage(input);
      if (entry.kind !== input.kind) {
        throw new Error(`Package ${input.packageId} is a ${entry.kind} package, not ${input.kind}.`);
      }
      return entry;
    } catch (error) {
      const cached = this.memoryCache.find((entry) => entry.packageId === input.packageId && entry.kind === input.kind);
      if (cached) {
        return requireInstallableCachedEntry(cached);
      }
      throw error;
    }
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
    const expectedNpmName = npmNameForPackageId(packageId);
    if (expectedNpmName) {
      const matchingEntry = matches.find((entry) => entry.npm?.packageName === expectedNpmName);
      if (matchingEntry) {
        return matchingEntry;
      }
      throw new Error(`Package ${packageId} must be published as ${expectedNpmName}.`);
    }
    const uniqueNames = [...new Set(matches.map((entry) => entry.npm?.packageName ?? entry.packageId))];
    if (uniqueNames.length > 1) {
      throw new Error(`Package id conflict for ${packageId}: ${uniqueNames.join(', ')}.`);
    }
    return matches[0]!;
  }
}
