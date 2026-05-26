import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginManifest } from '../plugins/pluginManifest.js';
import { validatePluginManifest } from '../plugins/pluginManifest.js';
import { validateApiAdapterPackageManifest, validateBundlePackageManifest, type ApiAdapterPackageManifest, type BundlePackageManifest } from '@moorline/contracts';
import type { ProviderPackageManifest } from '../../../types/provider.js';
import { validateProviderPackageManifest } from '../../../types/provider.js';
import type { TransportPackageManifest } from '../../../types/transport.js';
import { validateTransportPackageManifest } from '../../../types/transport.js';
import type { PackageDependency, PackageKind, PackageManifestBase } from '../../../types/package.js';
import { validateJsonSchemaLike, validatePackageDependencies } from '../../../types/package.js';
import type { SkillPackageManifest } from '../../../types/skill.js';
import { validateSkillPackageManifest } from '../../../types/skill.js';
import { assertValidPackageRange, assertValidPackageVersion } from './packageVersionResolver.js';

type InstallablePackageManifest =
  | ApiAdapterPackageManifest
  | ProviderPackageManifest
  | TransportPackageManifest
  | PluginManifest
  | SkillPackageManifest
  | BundlePackageManifest;

interface LoadedInstallablePackage {
  surface: PackageKind;
  manifest: InstallablePackageManifest;
  manifestPath: string;
  manifestHash: string;
}

function readManifestFile(packageDir: string): unknown {
  return JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as unknown;
}

function hashManifest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function augmentManifest<T extends PackageManifestBase>(manifest: T, label: string): T {
  assertValidPackageVersion({ packageId: manifest.id, version: manifest.version });
  validatePackageDependencies(manifest.dependencies as PackageDependency[] | undefined, label);
  for (const dependency of manifest.dependencies ?? []) {
    if (dependency.versionRange) {
      assertValidPackageRange({ packageId: dependency.packageId, range: dependency.versionRange });
    }
  }
  validateJsonSchemaLike(manifest.configSchema, label);
  return manifest;
}

function augmentBundleManifest(manifest: BundlePackageManifest): BundlePackageManifest {
  assertValidPackageVersion({ packageId: manifest.id, version: manifest.version });
  for (const member of manifest.members) {
    assertValidPackageRange({ packageId: member.packageId, range: member.version });
  }
  return manifest;
}

export function loadInstallablePackageManifest(surface: PackageKind, packageDir: string): LoadedInstallablePackage {
  const raw = readManifestFile(packageDir);
  const manifestHash = hashManifest(raw);

  switch (surface) {
    case 'api-adapter': {
      const manifest = augmentManifest(validateApiAdapterPackageManifest(raw as ApiAdapterPackageManifest), 'api adapter manifest');
      return { surface, manifest, manifestPath: join(packageDir, 'manifest.json'), manifestHash };
    }
    case 'provider': {
      const manifest = augmentManifest(validateProviderPackageManifest(raw as ProviderPackageManifest), 'provider manifest');
      return { surface, manifest, manifestPath: join(packageDir, 'manifest.json'), manifestHash };
    }
    case 'transport': {
      const manifest = augmentManifest(validateTransportPackageManifest(raw as TransportPackageManifest), 'transport manifest');
      return { surface, manifest, manifestPath: join(packageDir, 'manifest.json'), manifestHash };
    }
    case 'plugin': {
      const manifest = augmentManifest(validatePluginManifest(raw as PluginManifest), 'plugin manifest');
      return { surface, manifest, manifestPath: join(packageDir, 'manifest.json'), manifestHash };
    }
    case 'skill': {
      const manifest = augmentManifest(validateSkillPackageManifest(raw as SkillPackageManifest), 'skill manifest');
      return { surface, manifest, manifestPath: join(packageDir, 'manifest.json'), manifestHash };
    }
    case 'bundle': {
      const manifest = augmentBundleManifest(validateBundlePackageManifest(raw as BundlePackageManifest));
      return { surface, manifest, manifestPath: join(packageDir, 'manifest.json'), manifestHash };
    }
  }
}
