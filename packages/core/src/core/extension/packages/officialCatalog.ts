import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PackageCatalogEntry, PackageKind, PackageSourceDescriptor } from '../../../types/package.js';
import { detectMoorlineRuntimeMode, loadOfficialCatalogResource, resolveMoorlineAssetRoot } from '../../system/release/releaseArtifacts.js';
import { discoverOfficialPackageMetadata } from './packageDistroMetadata.js';
import { assertValidPackageRange, assertValidPackageVersion } from './packageVersionResolver.js';

const RELEASE_BASE_URL = 'https://github.com/Moorline/moorline/releases/download';

function archiveFileName(surface: PackageKind, sourceSubdir: string, version: string): string {
  const relativeSource = sourceSubdir
    .replace(/^packages\//u, '')
    .replace(new RegExp(`^${surface}s/`, 'u'), '');
  return `moorline-${surface}-${relativeSource.replaceAll('/', '-')}-${version}.tar.gz`;
}

function releaseArchiveSource(
  surface: PackageKind,
  sourceSubdir: string,
  version: string,
  ref: string,
  sha256?: string
): PackageSourceDescriptor {
  return {
    kind: 'remote_archive',
    url: `${RELEASE_BASE_URL}/${ref}/${archiveFileName(surface, sourceSubdir, version)}`,
    ...(sha256 ? { sha256 } : {})
  };
}

function suggestedAfterInstall(
  catalog: Array<{
    surface: PackageKind;
    packageId: string;
    requires: string[];
    recommendedForSetup: boolean;
  }>,
  surface: PackageKind,
  packageId: string
): string[] {
  if (surface !== 'transport') {
    return [];
  }
  return catalog
    .filter(
      (entry) =>
        entry.surface === 'plugin' &&
        entry.requires.includes(packageId)
    )
    .map((entry) => entry.packageId)
    .sort();
}

function resolveInstallableArchiveRoot(assetRoot: string): string {
  const roots = [
    assetRoot,
    join(assetRoot, '..'),
    join(assetRoot, '..', '..')
  ];
  for (const root of roots) {
    const direct = join(root, 'installable-archives');
    if (existsSync(direct)) {
      return direct;
    }
    const dist = join(root, 'dist', 'installable-archives');
    if (existsSync(dist)) {
      return dist;
    }
  }
  return join(assetRoot, 'dist', 'installable-archives');
}

function findArchiveByBasename(root: string, archiveName: string): string | null {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const stat = statSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (entry.isFile() && entry.name === archiveName) {
        return child;
      }
    }
  }
  return null;
}

function ensureLocalArchiveSha(assetRoot: string, surface: PackageKind, sourceSubdir: string, version: string): string | undefined {
  const archiveName = basename(archiveFileName(surface, sourceSubdir, version));
  const archiveRoot = resolveInstallableArchiveRoot(assetRoot);
  const path = findArchiveByBasename(archiveRoot, archiveName);
  if (!path || !existsSync(path)) {
    return undefined;
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function allowMissingRecommendedChecksums(): boolean {
  return process.env.MOORLINE_ALLOW_MISSING_RECOMMENDED_CHECKSUMS === '1';
}

function assertRecommendedChecksumPresent(input: {
  packageId: string;
  recommendedForSetup: boolean;
  sha256: string | undefined;
}): void {
  if (!input.recommendedForSetup) {
    return;
  }
  if (input.sha256 && input.sha256.length > 0) {
    return;
  }
  if (allowMissingRecommendedChecksums()) {
    return;
  }
  throw new Error(
    `Recommended official package ${input.packageId} is missing a sha256 checksum. ` +
      'Build installable archives first or set MOORLINE_ALLOW_MISSING_RECOMMENDED_CHECKSUMS=1 for local development only.'
  );
}

function buildSourceCatalog(assetRoot: string): PackageCatalogEntry[] {
  const discoveredCatalog = discoverOfficialPackageMetadata().map((entry) => {
    const explicitlyRecommendedForSetup = entry.distro.distribution?.recommendedForSetup === true;
    const recommendedForSetup = explicitlyRecommendedForSetup;
    const recommendedRef = entry.distro.release?.recommendedRef;
    if (explicitlyRecommendedForSetup && !recommendedRef) {
      throw new Error(`Recommended official package ${entry.packageId} is missing release.recommendedRef`);
    }
    const releaseRef = recommendedForSetup ? recommendedRef ?? 'v0.0.1' : 'v0.0.1';
    const sha256 = ensureLocalArchiveSha(assetRoot, entry.surface, entry.sourceSubdir, entry.distro.display.version);
    return {
      kind: entry.surface,
      surface: entry.surface,
      packageId: entry.packageId,
      name: entry.distro.display.name,
      description: entry.distro.display.description,
      version: entry.distro.display.version,
      recommendedForSetup,
      tags: entry.distro.display.tags ?? [],
      source: releaseArchiveSource(entry.surface, entry.sourceSubdir, entry.distro.display.version, releaseRef, sha256),
      requires: ('dependencies' in entry.manifest ? entry.manifest.dependencies ?? [] : []).map((dependency) => dependency.packageId),
      ...('members' in entry.manifest ? { members: entry.manifest.members } : {})
    } satisfies PackageCatalogEntry;
  });

  return discoveredCatalog.map((entry) => ({
    ...entry,
    ...(suggestedAfterInstall(discoveredCatalog, entry.surface, entry.packageId).length > 0
      ? { suggestedAfterInstall: suggestedAfterInstall(discoveredCatalog, entry.surface, entry.packageId) }
      : {})
  }));
}

function validateCatalogVersions(catalog: PackageCatalogEntry[]): PackageCatalogEntry[] {
  for (const entry of catalog) {
    assertValidPackageVersion({ packageId: entry.packageId, version: entry.version });
    for (const member of entry.members ?? []) {
      assertValidPackageRange({ packageId: member.packageId, range: member.version });
    }
  }
  return catalog;
}

function loadCatalog(): PackageCatalogEntry[] {
  const assetRoot = resolveMoorlineAssetRoot(import.meta.url);
  const runtimeMode = detectMoorlineRuntimeMode(import.meta.url);
  const resourceCatalog = process.env.MOORLINE_IGNORE_OFFICIAL_CATALOG_RESOURCE === '1'
    ? null
    : loadOfficialCatalogResource(assetRoot, runtimeMode);
  if (resourceCatalog && resourceCatalog.length > 0) {
    return validateCatalogVersions(resourceCatalog.map((entry) => ({
      ...entry,
      kind: entry.kind ?? entry.surface
    })));
  }
  return validateCatalogVersions(buildSourceCatalog(assetRoot));
}

let cachedCatalog: PackageCatalogEntry[] | null = null;

function loadCachedCatalog(): PackageCatalogEntry[] {
  if (cachedCatalog) {
    return cachedCatalog;
  }
  cachedCatalog = loadCatalog();
  return cachedCatalog;
}

export function getOfficialCatalog(): PackageCatalogEntry[] {
  return loadCachedCatalog();
}

export function assertOfficialCatalogChecksums(input?: {
  kind?: PackageKind;
  surface?: PackageKind;
  packageId?: string;
}): void {
  const catalog = loadCachedCatalog();
  const entries =
    (input?.kind ?? input?.surface) && input.packageId
      ? catalog.filter((entry) => entry.kind === (input.kind ?? input.surface) && entry.packageId === input.packageId)
      : catalog.filter((entry) => entry.recommendedForSetup);
  for (const entry of entries) {
    if (entry.source.kind !== 'remote_archive') {
      assertRecommendedChecksumPresent({
        packageId: entry.packageId,
        recommendedForSetup: entry.recommendedForSetup,
        sha256: undefined
      });
      continue;
    }
    assertRecommendedChecksumPresent({
      packageId: entry.packageId,
      recommendedForSetup: entry.recommendedForSetup,
      sha256: entry.source.sha256
    });
  }
}

const officialCatalogProxyHandler: ProxyHandler<PackageCatalogEntry[]> = {
  get(_target, property) {
    const catalog = loadCachedCatalog();
    const value = Reflect.get(catalog, property, catalog);
    if (typeof value === 'function') {
      return value.bind(catalog);
    }
    return value;
  }
};

export const OFFICIAL_CATALOG = new Proxy([] as PackageCatalogEntry[], officialCatalogProxyHandler);

export function findOfficialCatalogEntry(surface: PackageKind, packageId: string): (typeof OFFICIAL_CATALOG)[number] | null {
  return loadCachedCatalog().find((entry) => entry.kind === surface && entry.packageId === packageId) ?? null;
}
