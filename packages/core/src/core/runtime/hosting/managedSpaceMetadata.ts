interface ManagedSpaceOwnership {
  scopeId: string;
  ownerApplicationId?: string;
}

export function buildManagedSpaceMetadata(input: ManagedSpaceOwnership): Record<string, unknown> {
  return {
    moorlineManaged: true,
    moorlineOwnerScopeId: input.scopeId,
    ...(input.ownerApplicationId ? { moorlineOwnerApplicationId: input.ownerApplicationId } : {})
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
    (!input.ownerApplicationId || metadata.moorlineOwnerApplicationId === input.ownerApplicationId)
  );
}
