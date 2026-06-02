interface ManagedTransportResourceOwnership {
  scopeId: string;
  ownerApplicationId?: string;
}

export function buildManagedTransportResourceMetadata(input: ManagedTransportResourceOwnership): Record<string, unknown> {
  return {
    moorlineManaged: true,
    moorlineOwnerScopeId: input.scopeId,
    ...(input.ownerApplicationId ? { moorlineOwnerApplicationId: input.ownerApplicationId } : {})
  };
}
