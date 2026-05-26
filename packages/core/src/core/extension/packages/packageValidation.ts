import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateMoorlineDistroMetadata, type MoorlineDistroMetadata } from '../../../types/distro.js';
import type { PackageKind } from '../../../types/package.js';
import type { SkillPackageManifest } from '../../../types/skill.js';
import { loadInstallablePackageManifest } from './packageManifest.js';

function assertNoTypeScriptSources(packageDir: string): void {
  const stack = [packageDir];
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
        if (entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }
        stack.push(child);
        continue;
      }
      if (entry.isFile() && /\.tsx?$/u.test(entry.name) && !/\.d\.ts$/u.test(entry.name)) {
        throw new Error(`Installable bundles must not include raw TypeScript source files: ${child}`);
      }
    }
  }
}

function assertPathExists(path: string, detail: string): void {
  if (!existsSync(path)) {
    throw new Error(detail);
  }
}

export async function validateInstalledPackage(surface: PackageKind, packageDir: string): Promise<void> {
  const manifestPath = join(packageDir, 'manifest.json');
  const distroPath = join(packageDir, 'moorline.dist.json');
  assertPathExists(manifestPath, `Missing manifest.json in ${packageDir}`);
  assertPathExists(distroPath, `Missing moorline.dist.json in ${packageDir}`);
  validateMoorlineDistroMetadata(JSON.parse(readFileSync(distroPath, 'utf8')) as unknown as MoorlineDistroMetadata);
  const loaded = loadInstallablePackageManifest(surface, packageDir);

  if (surface === 'skill') {
    const manifest = loaded.manifest as SkillPackageManifest;
    const skillsRoot = join(packageDir, manifest.skillsRoot ?? 'skills');
    assertPathExists(skillsRoot, `Skill package ${manifest.id} is missing skills root ${manifest.skillsRoot ?? 'skills'}`);
    return;
  }

  if (surface === 'bundle') {
    return;
  }

  assertNoTypeScriptSources(packageDir);
  const manifest = loaded.manifest as { id: string; entrypoint?: string };

  if (surface === 'provider') {
    const entrypoint = join(packageDir, manifest.entrypoint ?? 'index.mjs');
    assertPathExists(entrypoint, `Provider package ${manifest.id} is missing entrypoint ${manifest.entrypoint ?? 'index.mjs'}`);
    return;
  }

  if (surface === 'transport') {
    const entrypoint = join(packageDir, manifest.entrypoint ?? 'index.mjs');
    assertPathExists(entrypoint, `Transport package ${manifest.id} is missing entrypoint ${manifest.entrypoint ?? 'index.mjs'}`);
    return;
  }

  const entrypoint = join(packageDir, manifest.entrypoint ?? 'index.mjs');
  assertPathExists(entrypoint, `Plugin ${manifest.id} is missing entrypoint ${manifest.entrypoint ?? 'index.mjs'}`);
}
