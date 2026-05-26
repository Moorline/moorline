import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PackageSourceDescriptor } from '../../../types/package.js';
import {
  detectMoorlineRuntimeMode,
  resolveMoorlineAssetRoot
} from '../../system/release/releaseArtifacts.js';

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

function findInstallableArchive(assetRoot: string, archiveName: string): string | null {
  return (
    findArchiveByBasename(join(assetRoot, 'installable-archives'), archiveName) ??
    findArchiveByBasename(join(assetRoot, 'dist', 'installable-archives'), archiveName)
  );
}

function isOfficialReleaseArchiveUrl(url: string): boolean {
  return /^https:\/\/github\.com\/Moorline\/(?:moorline|packages)\/releases\/download\//u.test(url);
}

export function tryResolveBundledOfficialPackage(source: PackageSourceDescriptor): string | null {
  if (source.kind !== 'remote_archive' || !isOfficialReleaseArchiveUrl(source.url)) {
    return null;
  }
  if (detectMoorlineRuntimeMode(import.meta.url) === 'packaged_release') {
    return null;
  }

  try {
    const assetRoot = resolveMoorlineAssetRoot(import.meta.url);
    const archiveName = basename(new URL(source.url).pathname);
    return findInstallableArchive(assetRoot, archiveName);
  } catch {
    return null;
  }
}
