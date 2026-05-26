export interface PackageRegistryBlocklistEntry {
  packageId?: string;
  npmName?: string;
  reason: string;
}

export const PACKAGE_REGISTRY_BLOCKLIST: PackageRegistryBlocklistEntry[] = [];

export function findPackageRegistryBlock(input: {
  packageId?: string;
  npmName?: string;
}): PackageRegistryBlocklistEntry | null {
  return PACKAGE_REGISTRY_BLOCKLIST.find((entry) => {
    if (entry.packageId && input.packageId && entry.packageId === input.packageId) {
      return true;
    }
    if (entry.npmName && input.npmName && entry.npmName === input.npmName) {
      return true;
    }
    return false;
  }) ?? null;
}
