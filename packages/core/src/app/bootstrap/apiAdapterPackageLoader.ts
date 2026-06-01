import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MoorlineConfig } from '../../types/config.js';
import {
  type ApiAdapterPackageManifest,
  type RuntimeApiAdapterPackage,
  type RuntimeApiAdapterContext,
  validateApiAdapterPackageManifest,
  validateApiAdapterPackageRuntimeContract
} from '@moorline/contracts';

interface ApiAdapterPackageDiskRecord {
  kind: 'valid' | 'invalid';
  packageId: string;
  packageDir: string;
  manifest?: ApiAdapterPackageManifest;
  detail?: string;
}

type ValidApiAdapterPackageDiskRecord = ApiAdapterPackageDiskRecord & {
  kind: 'valid';
  manifest: ApiAdapterPackageManifest;
};

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)])
    );
  }
  return value;
}

function manifestsMatch(left: ApiAdapterPackageManifest, right: ApiAdapterPackageManifest): boolean {
  return JSON.stringify(canonicalizeJson(left)) === JSON.stringify(canonicalizeJson(right));
}

function hasManifest(dir: string): boolean {
  try {
    return statSync(join(dir, 'manifest.json')).isFile();
  } catch {
    return false;
  }
}

function readManifestId(raw: unknown, fallbackPath: string): string {
  if (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string') {
    return (raw as { id: string }).id;
  }
  const normalized = fallbackPath.replaceAll('\\', '/');
  return `invalid:${normalized.split('/').filter(Boolean).at(-1) ?? 'api-adapter'}`;
}

function listApiAdapterPackageRecords(rootDir: string): ApiAdapterPackageDiskRecord[] {
  const records: ApiAdapterPackageDiskRecord[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const stat = statSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      continue;
    }

    if (hasManifest(current)) {
      const manifestPath = join(current, 'manifest.json');
      let manifestRaw: unknown = null;
      try {
        manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
        const manifest = validateApiAdapterPackageManifest(manifestRaw as ApiAdapterPackageManifest);
        records.push({
          kind: 'valid',
          packageId: manifest.id,
          manifest,
          packageDir: current
        });
      } catch (error) {
        records.push({
          kind: 'invalid',
          packageId: readManifestId(manifestRaw, current),
          packageDir: current,
          detail: error instanceof Error ? error.message : String(error)
        });
      }
      continue;
    }

    let entries: string[] = [];
    try {
      entries = readdirSync(current).sort();
    } catch {
      continue;
    }
    for (const entry of entries.reverse()) {
      stack.push(join(current, entry));
    }
  }

  return records.sort((left, right) => left.packageId.localeCompare(right.packageId));
}

async function importApiAdapterPackage(
  record: ValidApiAdapterPackageDiskRecord,
  context: RuntimeApiAdapterContext
): Promise<RuntimeApiAdapterPackage> {
  const entrypoint = join(record.packageDir, record.manifest.entrypoint ?? 'index.mjs');
  const module = await import(pathToFileURL(entrypoint).href);
  const loaded =
    module.default ??
    (typeof module.createApiAdapterPackage === 'function' ? module.createApiAdapterPackage(context) : null);
  if (!loaded || typeof loaded !== 'object') {
    throw new Error(`API adapter package ${record.manifest.id} did not export a runtime package object`);
  }

  const pkg = loaded as RuntimeApiAdapterPackage;
  const exportedManifest = validateApiAdapterPackageManifest(pkg.manifest);
  if (!manifestsMatch(exportedManifest, record.manifest)) {
    throw new Error(`API adapter package ${record.manifest.id} exported manifest drift relative to manifest.json`);
  }

  validateApiAdapterPackageRuntimeContract({
    ...pkg,
    manifest: record.manifest
  });

  return {
    ...pkg,
    manifest: record.manifest
  };
}

async function loadApiAdapterPackageById(input: {
  runtimeRoot: string;
  packageId: string;
  context: RuntimeApiAdapterContext;
  onDiscoveryWarning?: (input: { packageId: string; packageDir: string; detail: string }) => void;
}): Promise<RuntimeApiAdapterPackage> {
  const rootDir = join(input.runtimeRoot, 'packages', 'api-adapters');
  const records = listApiAdapterPackageRecords(rootDir);
  const validRecords = records.filter((entry): entry is ValidApiAdapterPackageDiskRecord => entry.kind === 'valid');
  const invalidRecords = records.filter((entry): entry is ApiAdapterPackageDiskRecord & { kind: 'invalid'; detail: string } => entry.kind === 'invalid' && typeof entry.detail === 'string');
  const expectedPackageDir = join(rootDir, ...input.packageId.split('/'));
  const selectedMalformed = invalidRecords.find((entry) => entry.packageDir === expectedPackageDir);
  if (selectedMalformed) {
    throw new Error(`Configured API adapter package manifest is invalid for ${input.packageId}: ${selectedMalformed.detail}`);
  }
  const record = validRecords.find((entry) => entry.manifest.id === input.packageId);
  if (!record) {
    const available = validRecords.map((entry) => entry.manifest.id).join(', ');
    throw new Error(`Configured API adapter package not found: ${input.packageId}${available ? ` (available: ${available})` : ''}`);
  }
  for (const invalid of invalidRecords) {
    if (invalid.packageDir === expectedPackageDir) {
      continue;
    }
    input.onDiscoveryWarning?.({
      packageId: invalid.packageId,
      packageDir: invalid.packageDir,
      detail: invalid.detail
    });
  }

  return await importApiAdapterPackage(record, input.context);
}

export async function loadConfiguredApiAdapterPackage(input: {
  config: MoorlineConfig;
  context: RuntimeApiAdapterContext;
  onDiscoveryWarning?: (input: { packageId: string; packageDir: string; detail: string }) => void;
}): Promise<RuntimeApiAdapterPackage> {
  const packageId = input.config.surfaces.apiAdapter.activePackageId;
  if (!packageId) {
    throw new Error('No API adapter package is selected.');
  }
  return await loadApiAdapterPackageById({
    runtimeRoot: input.config.runtimeRoot,
    packageId,
    context: input.context,
    onDiscoveryWarning: input.onDiscoveryWarning
  });
}
