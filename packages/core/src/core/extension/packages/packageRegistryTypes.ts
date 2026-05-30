import type { PackageKind, PackageSourceDescriptor, PackageBundleMember } from '../../../types/package.js';

export type PackageTrustLevel =
  | 'official'
  | 'verified'
  | 'curated'
  | 'community'
  | 'local'
  | 'direct_url'
  | 'blocked';

export type PackageRegistrySource = 'npm' | 'local_cache';

export interface PackageCompatibility {
  moorline?: string;
  platforms?: string[];
}

export interface PackageRegistryEntry {
  schemaVersion: 1;
  kind: PackageKind;
  /** Route/API field; mirrors kind until external route terminology is fully unified. */
  surface: PackageKind;
  packageId: string;
  name: string;
  description: string;
  version?: string;
  tags: string[];
  source: PackageSourceDescriptor;
  requires: string[];
  members?: PackageBundleMember[];
  trustLevel: PackageTrustLevel;
  registrySource: PackageRegistrySource;
  publisher: string;
  compatibility?: PackageCompatibility;
  npm?: {
    registryUrl: string;
    packageName: string;
    version: string;
    integrity?: string;
    npmUrl?: string;
    downloads?: {
      weekly?: number;
      monthly?: number;
    };
    updatedAt?: string;
  };
}

export interface PackageSearchInput {
  query?: string;
  kind?: PackageKind;
  compatibleOnly?: boolean;
  size?: number;
  from?: number;
}
