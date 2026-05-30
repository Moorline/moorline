import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { validatePackageId, type JsonSchemaLike, type PackageSurface } from '../../../types/package.js';
import { assertCanonicalExistingPathWithinRoot } from '../../shared/fs/canonicalPathContainment.js';
import { resolveBundledMoorlineAssetRoot } from '../../system/release/releaseArtifacts.js';

function surfaceDir(surface: PackageSurface): string {
  return surface === 'api-adapter' ? 'api-adapters' : `${surface}s`;
}

function manifestPathFromPackageId(root: string, surface: PackageSurface, packageId: string, label: string): string {
  const validatedPackageId = validatePackageId(packageId, label);
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, 'packages', surfaceDir(surface), ...validatedPackageId.split('/'), 'manifest.json');
  const rel = relative(resolvedRoot, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} resolved outside the ${surface} root.`);
  }
  return candidate;
}

function readSchemaFromManifest(path: string, root: string): JsonSchemaLike | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  assertCanonicalExistingPathWithinRoot({
    rootPath: root,
    candidatePath: path,
    rootLabel: `${root} root`,
    candidateLabel: `manifest path ${path}`
  });
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { configSchema?: JsonSchemaLike };
  return parsed.configSchema;
}

export function resolvePackageConfigSchema(input: {
  runtimeRoot: string;
  surface: PackageSurface;
  packageId: string | null | undefined;
}): JsonSchemaLike | undefined {
  if (!input.packageId) {
    return undefined;
  }

  const installedManifest = manifestPathFromPackageId(
    input.runtimeRoot,
    input.surface,
    input.packageId,
    `package id for ${input.surface} schema lookup`
  );
  const installed = readSchemaFromManifest(installedManifest, input.runtimeRoot);
  if (installed) {
    return installed;
  }

  const assetRoot = resolveBundledMoorlineAssetRoot(import.meta.url);
  return readSchemaFromManifest(
    manifestPathFromPackageId(assetRoot, input.surface, input.packageId, `package id for bundled ${input.surface} schema lookup`),
    assetRoot
  );
}

export function secretConfigKeys(schema: JsonSchemaLike | undefined): string[] {
  if (!schema?.properties) {
    return [];
  }
  return Object.entries(schema.properties)
    .filter(([, entry]) => entry.secret === true)
    .map(([key]) => key)
    .sort();
}
