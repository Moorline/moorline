import type { RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';

export type SessionInventoryScope = 'all' | 'managed_workers';

export function isManagedWorkerSession(session: RuntimeSessionRow): boolean {
  return Boolean(session.ownerKind && session.ownerId);
}
