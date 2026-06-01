import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginManifest } from '../../../extension/plugins/pluginManifest.js';
import { validatePluginManifest } from '../../../extension/plugins/pluginManifest.js';

interface PluginDiskRecord {
  pluginPath: string;
  manifest?: PluginManifest;
  error?: string;
  pluginId: string;
}

export function listPluginRecords(rootDir: string): PluginDiskRecord[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const stack = [rootDir];
  const records: PluginDiskRecord[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const stat = statSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      continue;
    }

    const manifestPath = join(current, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest;
        const manifest = validatePluginManifest(raw);
        records.push({
          manifest,
          pluginId: manifest.id,
          pluginPath: current
        });
      } catch (error) {
        const normalized = current.replaceAll('\\', '/');
        records.push({
          pluginId: `invalid:${normalized.split('/').filter(Boolean).at(-1) ?? 'plugin'}`,
          pluginPath: current,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      continue;
    }

    for (const entry of readdirSync(current).sort().reverse()) {
      stack.push(join(current, entry));
    }
  }

  return records.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}
