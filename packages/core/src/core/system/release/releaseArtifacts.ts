import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackageCatalogEntry } from '../../../types/package.js';
import type { MoorlineReleaseManifest, MoorlineRuntimeMode } from '../../../types/release.js';

const RELEASE_MANIFEST_FILE = 'release-manifest.json';
const OFFICIAL_CATALOG_FILE = 'official-catalog.json';
const RESOURCES_VERSION = 1;

function synthesizeSourceReleaseManifest(assetRoot: string): MoorlineReleaseManifest {
  const packageJsonPath = join(assetRoot, 'package.json');
  const packageJson =
    existsSync(packageJsonPath) ? (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }) : {};
  return {
    version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.1',
    gitCommit: process.env.MOORLINE_GIT_COMMIT ?? null,
    builtAt: process.env.MOORLINE_BUILT_AT ?? 'source-checkout',
    platform: process.platform,
    arch: process.arch,
    runtimeMode: 'source_checkout',
    resourcesVersion: RESOURCES_VERSION
  };
}

function packagedResourcesRoot(): string | null {
  const resourcesDir = join(dirname(process.execPath), 'resources');
  if (!existsSync(join(resourcesDir, RELEASE_MANIFEST_FILE))) {
    return null;
  }
  return resourcesDir;
}

function sourceAssetRootFromModule(moduleUrl: string): string | null {
  let current = dirname(fileURLToPath(moduleUrl));
  while (true) {
    const hasRuntimeAssets =
      existsSync(join(current, 'runtime-manifest.json')) ||
      ((existsSync(join(current, 'package.json')) || existsSync(join(current, 'plugins'))) &&
        (existsSync(join(current, 'policies')) ||
          existsSync(join(current, 'resources', 'policies')) ||
          existsSync(join(current, 'packages', 'core', 'resources', 'policies'))));
    if (hasRuntimeAssets) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function detectMoorlineRuntimeMode(moduleUrl: string): MoorlineRuntimeMode {
  if (packagedResourcesRoot()) {
    return 'packaged_release';
  }
  if (sourceAssetRootFromModule(moduleUrl)) {
    return 'source_checkout';
  }
  throw new Error(`Unable to resolve Moorline asset root from ${moduleUrl}`);
}

export function resolveMoorlineAssetRoot(moduleUrl: string): string {
  const packaged = packagedResourcesRoot();
  if (packaged) {
    return packaged;
  }
  const sourceRoot = sourceAssetRootFromModule(moduleUrl);
  if (sourceRoot) {
    return sourceRoot;
  }
  throw new Error(`Unable to resolve Moorline asset root from ${moduleUrl}`);
}

export function resolveBundledMoorlineAssetRoot(moduleUrl: string): string {
  return resolveMoorlineAssetRoot(moduleUrl);
}

export function readMoorlineReleaseManifest(assetRoot: string, runtimeMode: MoorlineRuntimeMode): MoorlineReleaseManifest {
  const manifestPath = join(assetRoot, RELEASE_MANIFEST_FILE);
  if (runtimeMode === 'packaged_release') {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as MoorlineReleaseManifest;
  }
  if (existsSync(manifestPath)) {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as MoorlineReleaseManifest;
  }
  return synthesizeSourceReleaseManifest(assetRoot);
}

export function loadOfficialCatalogResource(assetRoot: string, runtimeMode: MoorlineRuntimeMode): PackageCatalogEntry[] | null {
  const catalogPath = [join(assetRoot, OFFICIAL_CATALOG_FILE), join(assetRoot, 'resources', OFFICIAL_CATALOG_FILE)]
    .find((candidate) => existsSync(candidate));
  if (runtimeMode === 'packaged_release' && catalogPath) {
    return JSON.parse(readFileSync(catalogPath, 'utf8')) as PackageCatalogEntry[];
  }
  return catalogPath
    ? (JSON.parse(readFileSync(catalogPath, 'utf8')) as PackageCatalogEntry[])
    : null;
}
