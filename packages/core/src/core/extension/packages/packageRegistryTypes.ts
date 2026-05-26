import type { PackageCatalogEntry, PackageKind } from '../../../types/package.js';

export type PackageTrustLevel =
  | 'official'
  | 'verified'
  | 'curated'
  | 'community'
  | 'local'
  | 'direct_url'
  | 'blocked';

export type PackageRegistrySource = 'official_catalog' | 'npm';

export interface PackageCompatibility {
  moorline?: string;
  platforms?: string[];
}

export interface PackageRegistryEntry extends PackageCatalogEntry {
  schemaVersion: 1;
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
