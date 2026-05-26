interface ManagedSpaceOwnership {
  scopeId: string;
  applicationId: string;
}

export function buildManagedSpaceMetadata(input: ManagedSpaceOwnership): Record<string, unknown> {
  return {
    moorlineManaged: true,
    moorlineOwnerScopeId: input.scopeId,
    moorlineOwnerApplicationId: input.applicationId
  };
}

export function isOwnedManagedSpace(
  metadata: Record<string, unknown> | null | undefined,
  input: ManagedSpaceOwnership
): boolean {
  return (
    !!metadata &&
    metadata.moorlineManaged === true &&
    metadata.moorlineOwnerScopeId === input.scopeId &&
    metadata.moorlineOwnerApplicationId === input.applicationId
  );
}
