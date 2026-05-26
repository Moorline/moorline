import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  defaultProviderPackageId,
  type MoorlineConfig
} from '../../types/config.js';
import {
  type RuntimeProviderPackage,
  type RuntimeProviderPackageContext,
  type ProviderPackageManifest,
  validateProviderPackageManifest,
  validateProviderPackageRuntimeContract
} from '../../types/provider.js';

interface ProviderPackageDiskRecord {
  kind: 'valid' | 'invalid';
  packageId: string;
  packageDir: string;
  manifest?: ProviderPackageManifest;
  detail?: string;
}

type ValidProviderPackageDiskRecord = ProviderPackageDiskRecord & {
  kind: 'valid';
  manifest: ProviderPackageManifest;
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

function manifestsMatch(left: ProviderPackageManifest, right: ProviderPackageManifest): boolean {
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
  return `invalid:${normalized.split('/').filter(Boolean).at(-1) ?? 'provider'}`;
}

function listProviderPackageRecords(rootDir: string): ProviderPackageDiskRecord[] {
  const records: ProviderPackageDiskRecord[] = [];
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
        const manifest = validateProviderPackageManifest(manifestRaw as ProviderPackageManifest);
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

async function importProviderPackage(
  record: ValidProviderPackageDiskRecord,
  context: RuntimeProviderPackageContext
): Promise<RuntimeProviderPackage> {
  const entrypoint = join(record.packageDir, record.manifest.entrypoint ?? 'index.mjs');
  const module = await import(pathToFileURL(entrypoint).href);
  const loaded =
    module.default ??
    (typeof module.createProviderPackage === 'function' ? module.createProviderPackage(context) : null);
  if (!loaded || typeof loaded !== 'object') {
    throw new Error(`Provider package ${record.manifest.id} did not export a runtime package object`);
  }

  const pkg = loaded as RuntimeProviderPackage;
  const exportedManifest = validateProviderPackageManifest(pkg.manifest);
  if (!manifestsMatch(exportedManifest, record.manifest)) {
    throw new Error(`Provider package ${record.manifest.id} exported manifest drift relative to manifest.json`);
  }

  validateProviderPackageRuntimeContract({
    ...pkg,
    manifest: record.manifest
  });

  return {
    ...pkg,
    manifest: record.manifest
  };
}

export async function loadConfiguredProviderPackage(input: {
  runtimeRoot: string;
  config: MoorlineConfig;
  commandRunner?: RuntimeProviderPackageContext['commandRunner'];
  onDiscoveryWarning?: (input: { packageId: string; packageDir: string; detail: string }) => void;
}): Promise<RuntimeProviderPackage> {
  const rootDir = join(input.runtimeRoot, 'packages', 'providers');
  const records = listProviderPackageRecords(rootDir);
  const validRecords = records.filter((entry): entry is ValidProviderPackageDiskRecord => entry.kind === 'valid');
  const invalidRecords = records.filter((entry): entry is ProviderPackageDiskRecord & { kind: 'invalid'; detail: string } => entry.kind === 'invalid' && typeof entry.detail === 'string');
  if (!input.config.provider) {
    throw new Error('No applied provider is configured. Run setup and apply first.');
  }
  const packageId = input.config.provider.packageId ?? defaultProviderPackageId(input.config.provider.kind);
  const expectedPackageDir = join(rootDir, ...packageId.split('/'));
  const selectedMalformed = invalidRecords.find((entry) => entry.packageDir === expectedPackageDir);
  if (selectedMalformed) {
    throw new Error(`Configured provider package manifest is invalid for ${packageId}: ${selectedMalformed.detail}`);
  }
  const record = validRecords.find((entry) => entry.manifest.id === packageId);
  if (!record) {
    const available = validRecords.map((entry) => entry.manifest.id).join(', ');
    throw new Error(`Configured provider package not found: ${packageId}${available ? ` (available: ${available})` : ''}`);
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

  return await importProviderPackage(record, {
    config: input.config as unknown as Record<string, unknown>,
    commandRunner: input.commandRunner
  });
}
