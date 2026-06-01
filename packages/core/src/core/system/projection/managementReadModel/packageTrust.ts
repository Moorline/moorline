import type { ManagedObjectTrust, ManagedObjectTrustLevel } from '../../../../types/app.js';
import type { PackageInstallRecord } from '../../../../types/package.js';

function sourceLabel(entry: PackageInstallRecord): string {
  if (entry.publisher) {
    return entry.publisher;
  }
  if (entry.source.kind === 'local_dir' || entry.source.kind === 'local_archive') {
    return entry.source.path;
  }
  if (entry.source.provenance?.type === 'npm') {
    return entry.source.provenance.packageName;
  }
  return entry.source.url;
}

export function managedTrustForPackage(entry: PackageInstallRecord | null, fallbackSource: string): ManagedObjectTrust {
  if (!entry) {
    return {
      level: 'local',
      source: fallbackSource
    };
  }
  return {
    level: entry.trustLevel as ManagedObjectTrustLevel,
    source: sourceLabel(entry)
  };
}

export function editableFromPackage(entry: PackageInstallRecord | null): boolean {
  return !entry || entry.source.kind === 'local_dir';
}

export function removableFromPackage(entry: PackageInstallRecord | null): boolean {
  return entry !== null;
}
