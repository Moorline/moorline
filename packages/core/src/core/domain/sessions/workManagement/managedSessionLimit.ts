import type { SessionOwnerLink } from '../../../../types/plugin.js';
import type { RuntimeSnapshotQuery } from '../../../system/projection/runtimeSnapshotQuery.js';

const MAX_ACTIVE_MANAGED_SESSIONS_PER_OWNER = 5;

export function enforceManagedSessionLimit(snapshots: RuntimeSnapshotQuery, owner: SessionOwnerLink): void {
  const activeCount = snapshots
    .querySessions({
      scope: 'managed_workers',
      ownerKind: owner.kind,
      ownerId: owner.id,
      includeArchived: false
    })
    .length;
  if (activeCount >= MAX_ACTIVE_MANAGED_SESSIONS_PER_OWNER) {
    throw new Error(
      `Owner ${owner.kind}:${owner.id} already has ${activeCount} active managed sessions. Archive or delete one before creating more.`
    );
  }
}
