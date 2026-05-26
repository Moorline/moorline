import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { MoorlineDistroMetadata, ResolvedMoorlineDistroMetadata } from '../../../types/distro.js';
import { packageFamilyForKind, type PackageKind } from '../../../types/package.js';
import { resolveBundledMoorlineAssetRoot } from '../../system/release/releaseArtifacts.js';
import { loadInstallablePackageManifest } from './packageManifest.js';

function distroPath(dir: string): string {
  return join(dir, 'moorline.dist.json');
}

function readDistro(dir: string): MoorlineDistroMetadata | null {
  const path = distroPath(dir);
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as MoorlineDistroMetadata;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported distro metadata schema in ${path}`);
  }
  return parsed;
}

function mergeArray(parent: unknown[], child: unknown[], mode: 'union' | 'replace'): unknown[] {
  if (mode === 'replace') {
    return child;
  }
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const entry of [...parent, ...child]) {
    const key = JSON.stringify(entry);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

function deepMerge(parent: Record<string, unknown>, child: Record<string, unknown>, path: string[] = []): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    const nextPath = [...path, key];
    const previous = merged[key];
    if (Array.isArray(previous) && Array.isArray(value)) {
      const mode = key === 'tags' || key === 'audiences' ? 'union' : 'replace';
      merged[key] = mergeArray(previous, value, mode);
      continue;
    }
    if (
      previous &&
      typeof previous === 'object' &&
      !Array.isArray(previous) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      merged[key] = deepMerge(previous as Record<string, unknown>, value as Record<string, unknown>, nextPath);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function workspacePackagesRoot(root: string): string {
  const nested = join(root, 'packages');
  if (existsSync(nested)) {
    return nested;
  }
  const parent = dirname(root);
  return basename(parent) === 'packages' ? parent : nested;
}

function manifestRoots(surface: PackageKind, root: string): string[] {
  const base = workspacePackagesRoot(root);
  if (!existsSync(base)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(base).sort()) {
    const current = join(base, entry);
    const stat = statSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || !existsSync(join(current, 'manifest.json'))) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(current, 'manifest.json'), 'utf8')) as { id?: unknown; type?: unknown };
    if (manifest.type === surface && typeof manifest.id === 'string' && manifest.id.startsWith('official/')) {
      results.push(current);
    }
  }
  return results.sort();
}

interface OfficialPackageMetadataRecord {
  surface: PackageKind;
  packageDir: string;
  packageId: string;
  sourceSubdir: string;
  installSubdir: string;
  manifest: ReturnType<typeof loadInstallablePackageManifest>['manifest'];
  distro: ResolvedMoorlineDistroMetadata;
}

function resolvePackageDistroMetadata(input: {
  surface: PackageKind;
  packageDir: string;
  manifestFallback?: { name?: string; description?: string; version?: string };
}): ResolvedMoorlineDistroMetadata {
  const root = resolveBundledMoorlineAssetRoot(import.meta.url);
  const packageRoot = workspacePackagesRoot(root);
  const rel = relative(packageRoot, input.packageDir);
  const segments = rel.split(/[\\/]/u).filter(Boolean);
  const dirs = [packageRoot];
  let current = packageRoot;
  for (const segment of segments) {
    current = join(current, segment);
    dirs.push(current);
  }

  let merged: Record<string, unknown> = { schemaVersion: 1 };
  for (const dir of dirs) {
    const distro = readDistro(dir);
    if (distro) {
      merged = deepMerge(merged, distro as unknown as Record<string, unknown>);
    }
  }

  const typed = merged as unknown as MoorlineDistroMetadata;
  const display = {
    ...(typed.display ?? {}),
    ...(typed.display?.name ? {} : input.manifestFallback?.name ? { name: input.manifestFallback.name } : {}),
    ...(typed.display?.description
      ? {}
      : input.manifestFallback?.description
        ? { description: input.manifestFallback.description }
        : {}),
    ...(typed.display?.version ? {} : input.manifestFallback?.version ? { version: input.manifestFallback.version } : {})
  };
  if (!display.name || !display.description || !display.version) {
    throw new Error(`Resolved distro metadata is missing name, description, or version for ${input.packageDir}`);
  }
  return {
    ...typed,
    display: display as ResolvedMoorlineDistroMetadata['display']
  };
}

export function discoverOfficialPackageMetadata(): OfficialPackageMetadataRecord[] {
  const root = resolveBundledMoorlineAssetRoot(import.meta.url);
  const packageRoot = workspacePackagesRoot(root);
  const surfaces: PackageKind[] = ['api-adapter', 'transport', 'provider', 'plugin', 'skill', 'bundle'];
  const records: OfficialPackageMetadataRecord[] = [];
  for (const surface of surfaces) {
    for (const packageDir of manifestRoots(surface, root)) {
      const loaded = loadInstallablePackageManifest(surface, packageDir);
      records.push({
        surface,
        packageDir,
        packageId: loaded.manifest.id,
        sourceSubdir: join('packages', relative(packageRoot, packageDir)).replaceAll('\\', '/'),
        installSubdir:
          packageFamilyForKind(surface) === 'installable' || packageFamilyForKind(surface) === 'bundle'
            ? join('dist', 'installables', `${surface}s`, relative(packageRoot, packageDir)).replaceAll('\\', '/')
            : join('packages', relative(packageRoot, packageDir)).replaceAll('\\', '/'),
        manifest: loaded.manifest,
        distro: resolvePackageDistroMetadata({
          surface,
          packageDir,
          manifestFallback: {
            name: loaded.manifest.name,
            description: loaded.manifest.description,
            version: loaded.manifest.version
          }
        })
      });
    }
  }
  return records.sort((left, right) => `${left.surface}:${left.packageId}`.localeCompare(`${right.surface}:${right.packageId}`));
}
