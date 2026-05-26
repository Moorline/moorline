import semver from 'semver';
import {
  validatePackageId,
  type PackageBundleMember,
  type PackageKind,
  type PackageSourceDescriptor
} from '../../../types/package.js';
import type { PackageRegistryEntry, PackageSearchInput } from './packageRegistryTypes.js';
import { findPackageRegistryBlock } from './packageRegistryBlocklist.js';

const DEFAULT_NPM_REGISTRY_URL = 'https://registry.npmjs.org';
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SEARCH_RESULTS = 20;
const MOORLINE_KEYWORD = 'moorline-package';

export interface NpmRegistryClientOptions {
  registryUrl?: string;
  fetchTimeoutMs?: number;
  maxSearchResults?: number;
}

interface NpmSearchResponse {
  objects?: NpmSearchObject[];
}

interface NpmSearchObject {
  downloads?: {
    weekly?: number;
    monthly?: number;
  };
  updated?: string;
  package?: {
    name?: string;
    version?: string;
    description?: string;
    keywords?: string[];
  };
}

interface NpmPackageVersionMetadata {
  name?: string;
  version?: string;
  description?: string;
  keywords?: string[];
  dist?: {
    tarball?: string;
    integrity?: string;
    shasum?: string;
  };
  moorline?: unknown;
}

interface NpmPackageMetadata {
  name?: string;
  description?: string;
  keywords?: string[];
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, NpmPackageVersionMetadata>;
  time?: Record<string, string>;
}

interface MoorlineNpmMetadata {
  schemaVersion: 1;
  packageId: string;
  kind: PackageKind;
  manifestPath: string;
  distroPath: string;
}

function normalizeRegistryUrl(raw: string | undefined): string {
  return (raw ?? process.env.MOORLINE_NPM_REGISTRY_URL ?? DEFAULT_NPM_REGISTRY_URL).replace(/\/+$/u, '');
}

function scopedNpmPackageName(name: string | undefined): name is string {
  return typeof name === 'string' && /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(name);
}

function packageIdKeyword(packageId: string): string {
  return `moorline-id-${packageId.replace('/', '-')}`;
}

function packageNamespace(packageId: string): string {
  return packageId.split('/')[0] ?? '';
}

function isPackageKind(value: unknown): value is PackageKind {
  return value === 'api-adapter' || value === 'transport' || value === 'provider' || value === 'plugin' || value === 'skill' || value === 'bundle';
}

function parseMoorlineMetadata(value: unknown): MoorlineNpmMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !isPackageKind(record.kind)) {
    return null;
  }
  if (typeof record.packageId !== 'string' || typeof record.manifestPath !== 'string' || typeof record.distroPath !== 'string') {
    return null;
  }
  try {
    validatePackageId(record.packageId, 'package.json.moorline.packageId');
  } catch {
    return null;
  }
  return {
    schemaVersion: 1,
    packageId: record.packageId,
    kind: record.kind,
    manifestPath: record.manifestPath,
    distroPath: record.distroPath
  };
}

function metadataKeywords(metadata: NpmPackageVersionMetadata, packageMetadata?: NpmPackageMetadata): string[] {
  return [...new Set([...(metadata.keywords ?? []), ...(packageMetadata?.keywords ?? [])])];
}

function allowUnverifiedNpmPackages(): boolean {
  return process.env.MOORLINE_ALLOW_UNVERIFIED_NPM_PACKAGE === '1';
}

function publisherFromPackageName(npmName: string): string {
  const scope = npmName.split('/')[0]?.replace(/^@/u, '');
  return scope === 'moorline' ? 'Moorline' : scope || 'Unknown';
}

function displayNameFromPackageId(packageId: string): string {
  const name = packageId.split('/')[1] ?? packageId;
  return name
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function officialNpmNameMatchesPackageId(npmName: string, packageId: string): boolean {
  const expectedName = npmNameForOfficialPackageId(packageId);
  return expectedName !== null && npmName === expectedName;
}

function sourceForNpm(input: {
  registryUrl: string;
  npmName: string;
  version: string;
  tarball: string;
  integrity?: string;
}): PackageSourceDescriptor {
  return {
    kind: 'remote_archive',
    url: input.tarball,
    ...(input.integrity ? { integrity: input.integrity } : {}),
    provenance: {
      type: 'npm',
      registryUrl: input.registryUrl,
      packageName: input.npmName,
      version: input.version,
      ...(input.integrity ? { integrity: input.integrity } : {})
    }
  };
}

export class NpmRegistryClient {
  readonly registryUrl: string;
  private readonly fetchTimeoutMs: number;
  private readonly maxSearchResults: number;

  constructor(options: NpmRegistryClientOptions = {}) {
    this.registryUrl = normalizeRegistryUrl(options.registryUrl);
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.maxSearchResults = options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  }

  async search(input: PackageSearchInput = {}): Promise<PackageRegistryEntry[]> {
    const query = [MOORLINE_KEYWORD, input.query?.trim()].filter(Boolean).join(' ');
    const url = new URL(`${this.registryUrl}/-/v1/search`);
    url.searchParams.set('text', query);
    url.searchParams.set('size', String(input.size ?? this.maxSearchResults));
    url.searchParams.set('from', String(input.from ?? 0));
    const search = await this.fetchJson<NpmSearchResponse>(url.toString());
    const entries = await Promise.all(
      (search.objects ?? []).map(async (object) => {
        const packageName = object.package?.name;
        if (!scopedNpmPackageName(packageName)) {
          return null;
        }
        try {
          return await this.getByNpmPackage(packageName, object.package?.version, object);
        } catch {
          return null;
        }
      })
    );
    return entries
      .filter((entry): entry is PackageRegistryEntry => Boolean(entry))
      .filter((entry) => !input.kind || entry.kind === input.kind);
  }

  async findByPackageId(input: { packageId: string; kind?: PackageKind }): Promise<PackageRegistryEntry[]> {
    const keyword = packageIdKeyword(input.packageId);
    const entries = await this.search({
      query: keyword,
      kind: input.kind,
      size: this.maxSearchResults
    });
    return entries.filter((entry) => entry.packageId === input.packageId && (!input.kind || entry.kind === input.kind));
  }

  private async getByNpmPackage(
    npmName: string,
    versionHint?: string,
    searchObject?: NpmSearchObject
  ): Promise<PackageRegistryEntry | null> {
    const packageMetadata = await this.fetchPackageMetadata(npmName);
    const version = this.resolveVersion(packageMetadata, versionHint);
    const versionMetadata = packageMetadata.versions?.[version];
    if (!versionMetadata) {
      return null;
    }
    return this.convertVersionMetadata({
      npmName,
      packageMetadata,
      versionMetadata,
      searchObject
    });
  }

  private async fetchPackageMetadata(npmName: string): Promise<NpmPackageMetadata> {
    const encoded = npmName.startsWith('@') ? npmName.replace('/', '%2f') : encodeURIComponent(npmName);
    return await this.fetchJson<NpmPackageMetadata>(`${this.registryUrl}/${encoded}`);
  }

  private resolveVersion(metadata: NpmPackageMetadata, versionHint?: string): string {
    if (versionHint && metadata.versions?.[versionHint]) {
      return versionHint;
    }
    const latest = metadata['dist-tags']?.latest;
    if (latest && metadata.versions?.[latest]) {
      return latest;
    }
    const versions = Object.keys(metadata.versions ?? {}).filter((version) => semver.valid(version));
    const resolved = versions.sort(semver.rcompare)[0];
    if (!resolved) {
      throw new Error(`npm package ${metadata.name ?? '<unknown>'} has no valid versions.`);
    }
    return resolved;
  }

  private convertVersionMetadata(input: {
    npmName: string;
    packageMetadata: NpmPackageMetadata;
    versionMetadata: NpmPackageVersionMetadata;
    searchObject?: NpmSearchObject;
  }): PackageRegistryEntry | null {
    const npmName = input.npmName;
    if (!scopedNpmPackageName(npmName)) {
      return null;
    }
    const moorline = parseMoorlineMetadata(input.versionMetadata.moorline);
    if (!moorline) {
      return null;
    }
    if (npmName.startsWith('@moorline/') && !officialNpmNameMatchesPackageId(npmName, moorline.packageId)) {
      return null;
    }
    if (moorline.packageId.startsWith('official/') && !officialNpmNameMatchesPackageId(npmName, moorline.packageId)) {
      return null;
    }
    if (findPackageRegistryBlock({ packageId: moorline.packageId, npmName })) {
      return null;
    }
    const keywords = metadataKeywords(input.versionMetadata, input.packageMetadata);
    const requiredKeywords = [
      MOORLINE_KEYWORD,
      `moorline-kind-${moorline.kind}`,
      `moorline-namespace-${packageNamespace(moorline.packageId)}`,
      packageIdKeyword(moorline.packageId)
    ];
    if (!requiredKeywords.every((keyword) => keywords.includes(keyword))) {
      return null;
    }
    const version = input.versionMetadata.version;
    if (!version || !semver.valid(version)) {
      return null;
    }
    const tarball = input.versionMetadata.dist?.tarball;
    const integrity = input.versionMetadata.dist?.integrity;
    if (!tarball || (!integrity && !allowUnverifiedNpmPackages())) {
      return null;
    }
    const trustLevel = officialNpmNameMatchesPackageId(npmName, moorline.packageId)
      ? 'official'
      : 'community';
    const description = input.versionMetadata.description ?? input.packageMetadata.description ?? moorline.packageId;
    return {
      schemaVersion: 1,
      kind: moorline.kind,
      surface: moorline.kind,
      packageId: moorline.packageId,
      name: displayNameFromPackageId(moorline.packageId),
      description,
      version,
      recommendedForSetup: false,
      tags: keywords.filter((keyword) => !keyword.startsWith('moorline-')).sort(),
      source: sourceForNpm({
        registryUrl: this.registryUrl,
        npmName,
        version,
        tarball,
        ...(integrity ? { integrity } : {})
      }),
      requires: [],
      ...(moorline.kind === 'bundle' ? { members: [] as PackageBundleMember[] } : {}),
      trustLevel,
      registrySource: 'npm',
      publisher: publisherFromPackageName(npmName),
      npm: {
        registryUrl: this.registryUrl,
        packageName: npmName,
        version,
        ...(integrity ? { integrity } : {}),
        npmUrl: `https://www.npmjs.com/package/${encodeURIComponent(npmName)}`,
        ...(input.searchObject?.downloads ? { downloads: input.searchObject.downloads } : {}),
        ...(input.searchObject?.updated ?? input.packageMetadata.time?.[version]
          ? { updatedAt: input.searchObject?.updated ?? input.packageMetadata.time?.[version] }
          : {})
      }
    };
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const controller = new globalThis.AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json'
        }
      });
      if (!response.ok) {
        throw new Error(`npm registry request failed: ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as T;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
}

export function npmNameForOfficialPackageId(packageId: string): string | null {
  const [namespace, name] = packageId.split('/');
  if (namespace !== 'official' || !name) {
    return null;
  }
  return `@moorline/${name}`;
}
