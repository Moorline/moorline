import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureRuntimeLayout, resolveMoorlineAssetRoot } from '../hosting/runtimeLayout.js';

export function resolveRuntimeMigrationsDir(fromUrl: string): string {
  const assetRoot = resolveMoorlineAssetRoot(fromUrl);
  const packagedPath = join(assetRoot, 'migrations');
  if (existsSync(packagedPath)) {
    return packagedPath;
  }
  const packageResourcesPath = join(assetRoot, 'resources', 'migrations');
  if (existsSync(packageResourcesPath)) {
    return packageResourcesPath;
  }
  return join(assetRoot, 'packages', 'core', 'resources', 'migrations');
}

export async function prepareMoorlineRuntimeLayout(runtimeRoot: string, fromUrl: string): Promise<void> {
  await ensureRuntimeLayout({
    runtimeRoot,
    assetRoot: resolveMoorlineAssetRoot(fromUrl)
  });
}
