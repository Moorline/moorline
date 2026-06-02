import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
export { resolveMoorlineAssetRoot } from '../../system/release/releaseArtifacts.js';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

interface RuntimeReleaseInfo {
  version: string | null;
  major: number | null;
}

interface RuntimeLayoutState {
  version: number;
  seededOfficialContent: boolean;
  runtimeVersion: string | null;
  runtimeMajor: number | null;
  userStateMajor: number | null;
  managedPackages: Record<string, never>;
}

const RUNTIME_LAYOUT_VERSION = 7;

function parseRuntimeMajor(version: string | null): number | null {
  if (!version) {
    return null;
  }

  const match = version.match(/^(\d+)\./);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readRuntimeReleaseInfo(assetRoot: string): Promise<RuntimeReleaseInfo> {
  const candidates = [
    join(assetRoot, 'runtime-manifest.json'),
    join(assetRoot, 'package.json')
  ];

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }

    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8')) as { version?: unknown };
      const version = typeof parsed.version === 'string' ? parsed.version : null;
      return {
        version,
        major: parseRuntimeMajor(version)
      };
    } catch {
      // Continue to the next candidate.
    }
  }

  return {
    version: null,
    major: null
  };
}

function defaultLayoutState(release: RuntimeReleaseInfo): RuntimeLayoutState {
  return {
    version: RUNTIME_LAYOUT_VERSION,
    seededOfficialContent: false,
    runtimeVersion: release.version,
    runtimeMajor: release.major,
    userStateMajor: release.major,
    managedPackages: {}
  };
}

function normalizeLayoutState(raw: unknown, release: RuntimeReleaseInfo): RuntimeLayoutState {
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const runtimeVersion = typeof root.runtimeVersion === 'string' ? root.runtimeVersion : release.version;
  const runtimeMajor =
    typeof root.runtimeMajor === 'number' && Number.isFinite(root.runtimeMajor)
      ? root.runtimeMajor
      : parseRuntimeMajor(runtimeVersion);
  const userStateMajor =
    typeof root.userStateMajor === 'number' && Number.isFinite(root.userStateMajor)
      ? root.userStateMajor
      : release.major;

  return {
    version:
      typeof root.version === 'number' && Number.isFinite(root.version) ? root.version : RUNTIME_LAYOUT_VERSION,
    seededOfficialContent: false,
    runtimeVersion,
    runtimeMajor,
    userStateMajor,
    managedPackages: {}
  };
}

async function loadExistingLayoutState(layoutStatePath: string, release: RuntimeReleaseInfo): Promise<RuntimeLayoutState> {
  if (!(await pathExists(layoutStatePath))) {
    return defaultLayoutState(release);
  }

  try {
    return normalizeLayoutState(JSON.parse(await readFile(layoutStatePath, 'utf8')) as unknown, release);
  } catch {
    const backupPath = `${layoutStatePath}.corrupt-${Date.now()}`;
    try {
      await copyFile(layoutStatePath, backupPath);
    } catch {
      // Best-effort corruption backup.
    }
    return defaultLayoutState(release);
  }
}

export async function ensureRuntimeLayout(input: {
  runtimeRoot: string;
  assetRoot: string;
}): Promise<void> {
  const release = await readRuntimeReleaseInfo(input.assetRoot);
  const dirs = [
    input.runtimeRoot,
    join(input.runtimeRoot, 'memory', 'server'),
    join(input.runtimeRoot, 'memory', 'sessions'),
    join(input.runtimeRoot, 'memory', 'projects'),
    join(input.runtimeRoot, 'coordination'),
    join(input.runtimeRoot, 'packages', 'api-adapters'),
    join(input.runtimeRoot, 'packages', 'providers'),
    join(input.runtimeRoot, 'packages', 'transports'),
    join(input.runtimeRoot, 'packages', 'plugins'),
    join(input.runtimeRoot, 'packages', 'skills'),
    join(input.runtimeRoot, 'packages', 'bundles'),
    join(input.runtimeRoot, 'policies'),
    join(input.runtimeRoot, 'state')
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  const layoutStatePath = join(input.runtimeRoot, 'state', 'runtime-layout.json');
  const previousState = await loadExistingLayoutState(layoutStatePath, release);

  const nextState: RuntimeLayoutState = {
    version: RUNTIME_LAYOUT_VERSION,
    seededOfficialContent: false,
    runtimeVersion: release.version,
    runtimeMajor: release.major,
    userStateMajor: release.major ?? previousState.userStateMajor,
    managedPackages: {}
  };

  if (nextState.userStateMajor === null) {
    nextState.userStateMajor = previousState.userStateMajor;
  }

  await writeFile(layoutStatePath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
}
