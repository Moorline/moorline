export function buildProviderAlignment(capabilityMetadata: Record<string, unknown>) {
  const supportedCapabilities = Object.entries(capabilityMetadata)
    .filter(([key, value]) => key.startsWith('supports') && value === true)
    .map(([key]) => key)
    .sort();
  const supportedMethods = Array.isArray(capabilityMetadata.supportedMethods)
    ? capabilityMetadata.supportedMethods.filter((entry): entry is string => typeof entry === 'string').sort()
    : [];
  const managementSnapshot =
    capabilityMetadata.managementSnapshot && typeof capabilityMetadata.managementSnapshot === 'object'
      ? (capabilityMetadata.managementSnapshot as {
          threads?: { totalKnown?: number };
          skills?: { count?: number };
          plugins?: { count?: number };
          apps?: { count?: number };
          config?: { keys?: string[]; requirementKeys?: string[] };
        })
      : null;
  const surfacedManagementAreas = [
    managementSnapshot?.threads?.totalKnown ? 'threads' : null,
    managementSnapshot?.skills?.count ? 'skills' : null,
    managementSnapshot?.plugins?.count ? 'plugins' : null,
    managementSnapshot?.apps?.count ? 'apps' : null,
    managementSnapshot?.config?.keys?.length || managementSnapshot?.config?.requirementKeys?.length ? 'config' : null
  ].filter((entry): entry is string => entry !== null);
  const intentionalLimits: string[] = [];
  if (capabilityMetadata.supportsThreadInspection !== true) {
    intentionalLimits.push('thread inspection support is not available in the current provider runtime');
  }
  if (capabilityMetadata.supportsThreadArchive !== true) {
    intentionalLimits.push('thread archive and unarchive are not available in the current provider runtime');
  }
  if (capabilityMetadata.supportsThreadFork !== true || capabilityMetadata.supportsThreadRollback !== true) {
    intentionalLimits.push('thread fork and rollback are not available in the current provider runtime');
  }
  if (capabilityMetadata.supportsTurnSteering !== true) {
    intentionalLimits.push('in-flight turn steering is not available in the current provider runtime');
  }
  if (
    capabilityMetadata.supportsPluginManagement !== true ||
    capabilityMetadata.supportsSkillManagement !== true ||
    capabilityMetadata.supportsAppListing !== true
  ) {
    intentionalLimits.push('plugin, skill, or app management is not fully available in the current provider runtime');
  }
  if (capabilityMetadata.supportsConfigInspection !== true) {
    intentionalLimits.push('provider config and requirement inspection is not available in the current provider runtime');
  }
  return {
    status: intentionalLimits.length === 0 ? ('aligned' as const) : ('partial' as const),
    supportedCapabilities,
    supportedMethods,
    surfacedManagementAreas,
    intentionalLimits
  };
}
