import type { RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';

export function isManagedWorkerSession(session: RuntimeSessionRow): boolean {
  return Boolean(session.ownerKind && session.ownerId);
}
