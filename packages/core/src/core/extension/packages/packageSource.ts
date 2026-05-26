import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PackageSourceDescriptor } from '../../../types/package.js';
import { extractArchive } from './archiveExtraction.js';
import { findBundleRoot } from './packageBundleRoot.js';
import { tryResolveBundledOfficialPackage } from './officialArchiveResolver.js';
import { downloadRemoteArchive, RemoteArchiveDownloadError } from './remoteArchiveDownloader.js';

interface ResolvedPackageSource {
  tempRoot: string;
  packageDir: string;
}

function verifyBundledArchiveChecksum(path: string, expectedSha256: string): void {
  const actualHash = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actualHash !== expectedSha256.toLowerCase()) {
    throw new Error(`Bundled archive checksum mismatch for ${path}: expected ${expectedSha256}, received ${actualHash}`);
  }
}

function isBundledFallbackEligible(error: unknown): boolean {
  return error instanceof RemoteArchiveDownloadError && error.code !== 'checksum' && error.code !== 'validation';
}

function assertPathContainedWithin(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return;
  }
  throw new Error(`${label} must stay inside ${root}`);
}

function assertNoSymlinksInDirectory(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const stat = lstatSync(absolute, { throwIfNoEntry: false });
      if (!stat) {
        continue;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`local_dir package sources must not contain symlinks: ${absolute}`);
      }
      if (stat.isDirectory()) {
        stack.push(absolute);
      }
    }
  }
}

export async function resolvePackageSource(source: PackageSourceDescriptor): Promise<ResolvedPackageSource> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'moorline-package-'));
  try {
    if (source.kind === 'local_dir') {
      const absolute = resolve(source.path);
      const sourceStats = lstatSync(absolute, { throwIfNoEntry: false });
      if (!sourceStats) {
        throw new Error(`local_dir source does not exist: ${source.path}`);
      }
      if (sourceStats.isSymbolicLink()) {
        throw new Error(`local_dir source must not be a symlink: ${source.path}`);
      }
      if (!sourceStats.isDirectory()) {
        throw new Error(`local_dir source must be a directory: ${source.path}`);
      }
      const realRoot = realpathSync(absolute);
      assertPathContainedWithin(absolute, realRoot, 'local_dir source');
      assertNoSymlinksInDirectory(realRoot);
      cpSync(realRoot, tempRoot, { recursive: true });
      return {
        tempRoot,
        packageDir: existsSync(join(tempRoot, 'manifest.json')) ? tempRoot : findBundleRoot(tempRoot)
      };
    }
    if (source.kind === 'local_archive') {
      const absolute = resolve(source.path);
      await extractArchive(absolute, tempRoot);
      return {
        tempRoot,
        packageDir: findBundleRoot(tempRoot)
      };
    }

    if (source.kind !== 'remote_archive') {
      throw new Error(`Unsupported package source kind: ${(source as { kind: string }).kind}`);
    }
    try {
      const archivePath = await downloadRemoteArchive(source, tempRoot);
      await extractArchive(archivePath, tempRoot);
      return {
        tempRoot,
        packageDir: findBundleRoot(tempRoot)
      };
    } catch (error) {
      if (!isBundledFallbackEligible(error)) {
        throw error;
      }
      const bundledPath = tryResolveBundledOfficialPackage(source);
      if (!bundledPath) {
        throw error;
      }
      if (source.sha256) {
        verifyBundledArchiveChecksum(bundledPath, source.sha256);
      }
      await extractArchive(bundledPath, tempRoot);
      return {
        tempRoot,
        packageDir: findBundleRoot(tempRoot)
      };
    }
  } catch (error) {
    cleanupResolvedPackageSource({ tempRoot, packageDir: tempRoot });
    throw error;
  }
}

export function cleanupResolvedPackageSource(source: ResolvedPackageSource): void {
  rmSync(source.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
