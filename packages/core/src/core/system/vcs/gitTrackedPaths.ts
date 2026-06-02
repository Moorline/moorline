import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const TRACKED_ROOTS = [
  'config.json',
  'runtime/packages',
  'runtime/policies'
] as const;

const IGNORED_ROOTS = [
  'config.secrets.json',
  'runtime/coordination',
  'runtime/logs',
  'runtime/memory',
  'runtime/state',
  'runtime/state.db',
  'runtime/workspaces'
] as const;

function normalizeSeparators(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function trackedRoots(): string[] {
  return [...TRACKED_ROOTS];
}

function ignoredRoots(): string[] {
  return [...IGNORED_ROOTS];
}

export function normalizeRepoRelativePath(value: string): string {
  const normalized = normalizeSeparators(value.trim());
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error(`Path is outside the Moorline home root: ${value}`);
  }
  return normalized;
}

function toRepoRelativePath(homeRoot: string, targetPath: string): string {
  const absoluteHome = resolve(homeRoot);
  const absoluteTarget = resolve(targetPath);
  const repoRelative = normalizeSeparators(relative(absoluteHome, absoluteTarget));
  if (!repoRelative || repoRelative === '.' || repoRelative.startsWith('../') || repoRelative === '..') {
    throw new Error(`Path is outside the Moorline home root: ${targetPath}`);
  }
  return repoRelative;
}

function isIgnoredRelativePath(value: string): boolean {
  const normalized = normalizeRepoRelativePath(value);
  return ignoredRoots().some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

export function isTrackedRelativePath(value: string): boolean {
  const normalized = normalizeRepoRelativePath(value);
  if (isIgnoredRelativePath(normalized)) {
    return false;
  }
  return trackedRoots().some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

function validateTrackedRelativePath(value: string): string {
  const normalized = normalizeRepoRelativePath(value);
  if (!isTrackedRelativePath(normalized)) {
    throw new Error(`Path is not part of tracked Moorline history: ${value}`);
  }
  return normalized;
}

export function existingTrackedRoots(homeRoot: string): string[] {
  return trackedRoots().filter((entry) => existsSync(resolve(homeRoot, entry)));
}

export function ensureTrackedTargets(homeRoot: string, targets?: string[]): string[] {
  if (!targets || targets.length === 0) {
    return existingTrackedRoots(homeRoot);
  }

  const resolved = targets.map((entry) => validateTrackedRelativePath(entry));
  return [...new Set(resolved)];
}

export function toTrackedRelativeTargets(homeRoot: string, targets: string[]): string[] {
  return [...new Set(targets.map((entry) => validateTrackedRelativePath(toRepoRelativePath(homeRoot, entry))))];
}

export function configPathUnderHome(homeRoot: string, configPath: string): string | null {
  const relativeConfigPath = normalizeSeparators(relative(resolve(homeRoot), resolve(configPath)));
  if (relativeConfigPath === 'config.json') {
    return 'config.json';
  }
  return null;
}
