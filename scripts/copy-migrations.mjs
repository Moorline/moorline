import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const projectRoot = process.cwd();
const distRoot = join(projectRoot, 'dist');
const migrationsSourceDir = join(projectRoot, 'packages', 'core', 'resources', 'migrations');
const distMigrationsDir = join(distRoot, 'packages', 'core', 'src', 'core', 'system', 'state', 'migrations');
const resourcesRoot = join(distRoot, 'resources');
const resourcesMigrationsDir = join(resourcesRoot, 'migrations');
const policySourceDir = join(projectRoot, 'packages', 'core', 'resources', 'policies');
const policyTargetDir = join(distRoot, 'packages', 'core', 'resources', 'policies');
const resourcesPolicyDir = join(resourcesRoot, 'policies');
const runtimeManifestPath = join(distRoot, 'runtime-manifest.json');
const releaseManifestPath = join(resourcesRoot, 'release-manifest.json');
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));

function resetDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

function copyTree(source, target) {
  resetDir(target);
  cpSync(source, target, { recursive: true });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  copyTree(migrationsSourceDir, distMigrationsDir);
  copyTree(migrationsSourceDir, resourcesMigrationsDir);
  copyTree(policySourceDir, policyTargetDir);
  copyTree(policySourceDir, resourcesPolicyDir);

  writeJson(runtimeManifestPath, {
    version: typeof packageJson.version === 'string' ? packageJson.version : null
  });

  writeJson(releaseManifestPath, {
    version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.1',
    gitCommit: process.env.MOORLINE_GIT_COMMIT ?? null,
    builtAt: process.env.MOORLINE_BUILT_AT ?? new Date().toISOString(),
    platform: process.env.MOORLINE_TARGET_PLATFORM ?? process.platform,
    arch: process.env.MOORLINE_TARGET_ARCH ?? process.arch,
    runtimeMode: 'packaged_release',
    resourcesVersion: 1
  });
}

await main();
