import type { SessionOwnerLink } from '../../../../types/plugin.js';

export function defaultSessionOwner(requestedByThreadId: string): SessionOwnerLink {
  return requestedByThreadId.startsWith('session:')
    ? { kind: 'parent_session', id: requestedByThreadId, label: requestedByThreadId }
    : requestedByThreadId.startsWith('coordination:')
        ? { kind: 'run', id: requestedByThreadId, label: requestedByThreadId }
        : { kind: 'orchestrator', id: requestedByThreadId, label: requestedByThreadId };
}
