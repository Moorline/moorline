import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePluginManifest, validatePluginRuntimeContract, type PluginManifest } from './pluginManifest.js';
import type { RuntimePlugin } from '../../../types/plugin.js';
import type { RuntimePackageLoadFailure } from '../../../types/release.js';
import { PackageInventoryStore } from '../packages/packageInventoryStore.js';
import { appliedPackageRefs } from '../packages/packageActivation.js';

interface RuntimePluginDiskRecord {
  kind: 'valid' | 'invalid';
  packageId: string;
  pluginDir: string;
  manifest?: PluginManifest;
  detail?: string;
}

interface RuntimePluginImportRecord {
  manifest: PluginManifest;
  pluginDir: string;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)])
    );
  }
  return value;
}

function manifestsMatch(left: PluginManifest, right: PluginManifest): boolean {
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
  return `invalid:${normalized.split('/').filter(Boolean).at(-1) ?? 'plugin'}`;
}

function listPluginRecords(rootDir: string, enabledPackageIds: Set<string>): RuntimePluginDiskRecord[] {
  const records: RuntimePluginDiskRecord[] = [];
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
        const manifest = validatePluginManifest(manifestRaw as PluginManifest);
        if (enabledPackageIds.has(manifest.id)) {
          records.push({
            kind: 'valid',
            packageId: manifest.id,
            manifest,
            pluginDir: current
          });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const packageId = readManifestId(manifestRaw, current);
        if (enabledPackageIds.has(packageId) || packageId.startsWith('invalid:')) {
          records.push({
            kind: 'invalid',
            packageId,
            pluginDir: current,
            detail
          });
        }
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

async function importPlugin(record: RuntimePluginImportRecord): Promise<RuntimePlugin> {
  const entrypoint = join(record.pluginDir, record.manifest.entrypoint ?? 'index.mjs');
  const module = await import(pathToFileURL(entrypoint).href);
  const loaded = module.default ?? (typeof module.createPlugin === 'function' ? module.createPlugin() : null);
  if (!loaded || typeof loaded !== 'object') {
    throw new Error(`Plugin ${record.manifest.id} did not export a runtime plugin object`);
  }

  const plugin = loaded as RuntimePlugin;
  if (plugin.id !== record.manifest.id) {
    throw new Error(`Plugin ${record.manifest.id} exported mismatched id ${plugin.id}`);
  }
  const exportedManifest = validatePluginManifest(plugin.manifest);
  if (!manifestsMatch(exportedManifest, record.manifest)) {
    throw new Error(`Plugin ${record.manifest.id} exported manifest drift relative to manifest.json`);
  }

  validatePluginRuntimeContract({
    ...plugin,
    manifest: record.manifest
  });

  return {
    ...plugin,
    manifest: record.manifest
  };
}

export async function loadRuntimePluginsWithDiagnostics(
  runtimeRoot: string,
  phase: RuntimePackageLoadFailure['phase'] = 'startup',
  now: () => string = () => new Date().toISOString()
): Promise<{ plugins: RuntimePlugin[]; failures: RuntimePackageLoadFailure[] }> {
  const inventory = new PackageInventoryStore(runtimeRoot).load();
  const enabledPluginPackageIds = appliedPackageRefs(inventory.applied)
    .filter((entry) => entry.surface === 'plugin')
    .map((entry) => entry.packageId);
  const records = listPluginRecords(join(runtimeRoot, 'packages', 'plugins'), new Set(enabledPluginPackageIds));
  const plugins: RuntimePlugin[] = [];
  const failures: RuntimePackageLoadFailure[] = [];
  for (const record of records) {
    if (record.kind === 'invalid') {
      failures.push({
        surface: 'plugin',
        packageId: record.packageId,
        phase,
        detail: record.detail ?? `Malformed plugin manifest in ${record.pluginDir}`,
        recordedAt: now(),
        required: false
      });
      continue;
    }

    try {
      plugins.push(await importPlugin({ manifest: record.manifest!, pluginDir: record.pluginDir }));
    } catch (error) {
      failures.push({
        surface: 'plugin',
        packageId: record.packageId,
        phase,
        detail: error instanceof Error ? error.message : String(error),
        recordedAt: now(),
        required: false
      });
    }
  }
  return {
    plugins,
    failures
  };
}
