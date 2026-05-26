import type { PackageBundleMember, PackageManifestBase } from './package.js';
import { validatePackageBundleMembers, validatePackageId } from './package.js';

export interface BundlePackageManifest extends PackageManifestBase {
  type: 'bundle';
  members: PackageBundleMember[];
}

export function validateBundlePackageManifest(manifest: BundlePackageManifest): BundlePackageManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Bundle package manifest must be an object');
  }
  const record = manifest as unknown as Record<string, unknown>;
  validatePackageId(record.id, 'Bundle package manifest id');
  if (typeof record.name !== 'string' || !record.name.trim()) {
    throw new Error('Bundle package manifest name is required');
  }
  if (typeof record.version !== 'string' || !record.version.trim()) {
    throw new Error('Bundle package manifest version is required');
  }
  if (record.type !== 'bundle') {
    throw new Error('Bundle package manifest type must be "bundle"');
  }
  if (record.description !== undefined && (typeof record.description !== 'string' || !record.description.trim())) {
    throw new Error('Bundle package manifest description must be non-empty when provided');
  }
  validatePackageBundleMembers(record.members, 'bundle package manifest');
  return {
    ...manifest,
    members: validatePackageBundleMembers(record.members, 'bundle package manifest')
  };
}
