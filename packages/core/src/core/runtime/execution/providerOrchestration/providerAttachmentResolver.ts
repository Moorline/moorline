import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { RuntimeSessionRow } from '../../../system/state/sqliteSessionStore.js';
import { assertCanonicalExistingPathWithinRoot } from '../../../shared/fs/canonicalPathContainment.js';
import type { ProviderAuditPort } from './ports.js';

export interface ProviderAttachmentResolverDeps extends ProviderAuditPort {
  runtimeRoot: string;
  now(): string;
  getSessionByThreadId(threadId: string): RuntimeSessionRow | null;
}

export class ProviderAttachmentResolver {
  constructor(private readonly deps: ProviderAttachmentResolverDeps) {}

  resolve(threadId: string, localPath: string, sourceEventId: string): string | null {
    const session = this.deps.getSessionByThreadId(threadId);
    const workspaceRoot = session?.workspacePath;
    if (!workspaceRoot) {
      return null;
    }

    const candidate = resolve(isAbsolute(localPath) ? localPath : join(workspaceRoot, localPath));
    const candidateStats = statSync(candidate, { throwIfNoEntry: false });
    if (!candidateStats?.isFile()) {
      return null;
    }

    const allowlistedRoots = [resolve(workspaceRoot), resolve(this.deps.runtimeRoot, 'state', 'input-images', threadId)];
    for (const root of allowlistedRoots) {
      try {
        return assertCanonicalExistingPathWithinRoot({
          rootPath: root,
          candidatePath: candidate,
          rootLabel: `attachment root ${root}`,
          candidateLabel: `attachment path ${localPath}`
        });
      } catch {
        // Keep scanning allowlisted roots.
      }
    }

    this.deps.appendAuditEvent('provider.attachment.rejected', {
      threadId,
      sessionId: session?.sessionId ?? null,
      spaceId: session?.spaceId ?? null,
      localPath,
      reason: 'outside-allowlisted-roots'
    });
    this.deps.recordRuntimeActivity({
      threadId,
      sessionId: session?.sessionId ?? null,
      spaceId: session?.spaceId ?? null,
      sourceEventId: sourceEventId || randomUUID(),
      kind: 'provider.attachment.rejected',
      severity: 'warning',
      title: 'Provider attachment blocked',
      detail: `Rejected out-of-root attachment path: ${localPath}`,
      createdAt: this.deps.now()
    });
    return null;
  }
}
