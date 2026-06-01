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
