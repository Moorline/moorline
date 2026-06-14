import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PackageSourceDescriptor } from '../../../types/package.js';
import { extractArchive } from './archiveExtraction.js';
import { findBundleRoot } from './packageBundleRoot.js';
import { tryResolveBundledPackage } from './bundledArchiveResolver.js';
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

const SUPPORTED_INTEGRITY_ALGORITHMS = new Set(['sha256', 'sha384', 'sha512']);

function verifyBundledArchiveIntegrity(path: string, expectedIntegrity: string): void {
  const bytes = readFileSync(path);
  const candidates = expectedIntegrity
    .trim()
    .split(/\s+/u)
    .map((entry) => {
      const [algorithm, digest] = entry.split('-', 2);
      return {
        algorithm,
        digest
      };
    })
    .filter((entry): entry is { algorithm: string; digest: string } => Boolean(entry.algorithm && entry.digest))
    .filter((entry) => SUPPORTED_INTEGRITY_ALGORITHMS.has(entry.algorithm));
  if (candidates.length === 0) {
    throw new Error(`Bundled archive integrity metadata is invalid or unsupported for ${path}`);
  }
  for (const candidate of candidates) {
    const actual = createHash(candidate.algorithm).update(bytes).digest('base64');
    if (actual === candidate.digest) {
      return;
    }
  }
  throw new Error(`Bundled archive integrity mismatch for ${path}`);
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
      if (entry.name === 'node_modules') {
        continue;
      }
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

function shouldCopyLocalSourceEntry(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (!rel) {
    return true;
  }
  const parts = rel.split(/[\\/]+/u);
  const name = basename(path);
  if (parts.includes('node_modules') || parts.includes('.git')) {
    return false;
  }
  if (parts.includes('test') || parts.includes('tests') || parts.includes('__tests__')) {
    return false;
  }
  if (/^tsconfig(?:\..*)?\.json$/u.test(name) || /^vitest\.config\./u.test(name) || /^eslint\.config\./u.test(name)) {
    return false;
  }
  if ((extname(name) === '.ts' || extname(name) === '.tsx') && !name.endsWith('.d.ts')) {
    return false;
  }
  return !name.endsWith('.js.map');
}

function readRuntimeDependencyNames(packageRoot: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>;
    };
    return Object.keys(parsed.dependencies ?? {})
      .sort();
  } catch {
    return [];
  }
}

function resolveDependencyPackageRoot(packageRoot: string, dependencyName: string): string | null {
  const requireFromPackage = createRequire(join(packageRoot, 'package.json'));
  try {
    return dirname(requireFromPackage.resolve(`${dependencyName}/package.json`));
  } catch {
    // Some packages hide package.json behind an exports map. Resolve their
    // runtime entrypoint and walk back to the owning package root.
  }
  try {
    let current = dirname(requireFromPackage.resolve(dependencyName));
    while (true) {
      if (existsSync(join(current, 'package.json'))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  } catch {
    return null;
  }
}

function copyWorkspaceDependencies(realRoot: string, tempRoot: string, seen = new Set<string>()): void {
  for (const dependencyName of readRuntimeDependencyNames(realRoot)) {
    const dependencySource = resolveDependencyPackageRoot(realRoot, dependencyName);
    if (!dependencySource) {
      continue;
    }
    const dependencyKey = `${dependencyName}:${realpathSync(dependencySource)}`;
    if (seen.has(dependencyKey)) {
      continue;
    }
    seen.add(dependencyKey);
    const dependencyTarget = join(tempRoot, 'node_modules', ...dependencyName.split('/'));
    mkdirSync(join(dependencyTarget, '..'), { recursive: true });
    cpSync(dependencySource, dependencyTarget, {
      recursive: true,
      dereference: true,
      filter: (path) => shouldCopyLocalSourceEntry(dependencySource, path)
    });
    copyWorkspaceDependencies(dependencySource, tempRoot, seen);
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
      cpSync(realRoot, tempRoot, {
        recursive: true,
        filter: (path) => shouldCopyLocalSourceEntry(realRoot, path)
      });
      copyWorkspaceDependencies(realRoot, tempRoot);
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
      const bundledPath = tryResolveBundledPackage(source);
      if (!bundledPath) {
        throw error;
      }
      if (source.sha256) {
        verifyBundledArchiveChecksum(bundledPath, source.sha256);
      }
      if (source.integrity) {
        verifyBundledArchiveIntegrity(bundledPath, source.integrity);
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
