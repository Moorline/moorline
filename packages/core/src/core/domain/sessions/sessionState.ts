import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeModeName } from '../../../types/runtime.js';
import type { SessionOwnerLink } from '../../../types/plugin.js';
import { SqliteSessionStore, type RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';
import { assertRuntimeOwnedWorkspacePath } from '../../shared/fs/runtimeOwnedPath.js';

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'session';
}

function nextSessionId(name: string, nowIso: string): string {
  const stamp = nowIso.replace(/[^0-9]/g, '').slice(0, 17);
  const entropy = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${slugify(name)}-${stamp}-${entropy}`;
}

function uniqueSessionId(name: string, nowIso: string, existing: RuntimeSessionRow[]): string {
  const base = nextSessionId(name, nowIso);
  const ids = new Set(existing.map((session) => session.sessionId));
  if (!ids.has(base)) {
    return base;
  }

  let counter = 2;
  while (ids.has(`${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

export class SessionRegistry {
  constructor(
    private readonly store: SqliteSessionStore,
    private readonly workspacesDir: string,
    readonly providerPackageId = 'default'
  ) {}

  list(): RuntimeSessionRow[] {
    return this.store.listSessions();
  }

  getBySpaceId(spaceId: string): RuntimeSessionRow | null {
    return this.store.getSessionBySpaceId(spaceId);
  }

  getByThreadId(threadId: string): RuntimeSessionRow | null {
    return this.store.getSessionByThreadId(threadId);
  }

  create(input: {
    scopeId: string;
    spaceId: string;
    spaceName: string;
    requestedName: string;
    runtimeMode: RuntimeModeName;
    nowIso: string;
    providerAutoStartEnabled?: boolean;
    owner?: SessionOwnerLink;
    objective?: string;
    tags?: string[];
    createdBy?: string;
  }): RuntimeSessionRow {
    const sessionId = uniqueSessionId(input.requestedName, input.nowIso, this.list());
    const threadId = `session:${sessionId}`;
    const workspacePath = join(this.workspacesDir, sessionId);
    mkdirSync(workspacePath, { recursive: true });

    const row: RuntimeSessionRow = {
      sessionId,
      scopeId: input.scopeId,
      spaceId: input.spaceId,
      threadId,
      spaceName: input.spaceName,
      workspacePath,
      runtimeMode: input.runtimeMode,
      lifecycleStatus: 'hot',
      summary: null,
      provider: this.providerPackageId,
      providerThreadId: null,
      resumeThreadId: null,
      providerStatus: 'connecting',
      providerAutoStartEnabled: input.providerAutoStartEnabled !== false,
      activeTurnId: null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
      lastActivityAt: input.nowIso,
      archivedAt: null,
      lastError: null,
      ownerKind: input.owner?.kind ?? null,
      ownerId: input.owner?.id ?? null,
      ownerLabel: input.owner?.label ?? null,
      objective: input.objective ?? null,
      tags: input.tags ?? [],
      createdBy: input.createdBy ?? null,
      lastDirectedAt: null,
      lastDirectedBy: null
    };

    try {
      this.store.upsertSession(row);
      return this.store.getSession(sessionId)!;
    } catch (error) {
      rmSync(workspacePath, { recursive: true, force: true });
      throw error;
    }
  }

  updateSession(row: RuntimeSessionRow): RuntimeSessionRow {
    this.store.upsertSession(row);
    return this.store.getSession(row.sessionId)!;
  }

  updateSummary(spaceId: string, summary: string, nowIso: string): RuntimeSessionRow | null {
    const session = this.getBySpaceId(spaceId);
    if (!session) {
      return null;
    }
    return this.updateSession({
      ...session,
      summary,
      updatedAt: nowIso
    });
  }

  markDirected(input: { spaceId: string; directedAt: string; directedBy: string }): RuntimeSessionRow | null {
    const session = this.getBySpaceId(input.spaceId);
    if (!session) {
      return null;
    }
    return this.updateSession({
      ...session,
      lastDirectedAt: input.directedAt,
      lastDirectedBy: input.directedBy,
      updatedAt: input.directedAt
    });
  }

  archive(spaceId: string, nowIso: string): RuntimeSessionRow | null {
    const session = this.getBySpaceId(spaceId);
    if (!session) {
      return null;
    }
    return this.updateSession({
      ...session,
      lifecycleStatus: 'archived',
      archivedAt: nowIso,
      updatedAt: nowIso
    });
  }

  deleteArchived(spaceId: string): RuntimeSessionRow | null {
    const session = this.getBySpaceId(spaceId);
    if (!session || session.lifecycleStatus !== 'archived') {
      return null;
    }
    let managedWorkspacePath: string;
    try {
      managedWorkspacePath = assertRuntimeOwnedWorkspacePath({
        workspacesDir: this.workspacesDir,
        workspacePath: session.workspacePath,
        expectedWorkspaceId: session.sessionId,
        entityLabel: `Session ${session.sessionId}`
      });
    } catch (error) {
      console.warn(
        `[moorline.session.delete.blocked] sessionId=${session.sessionId} workspacePath=${session.workspacePath} reason=${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
    rmSync(managedWorkspacePath, { recursive: true, force: true });
    this.store.deleteSession(session.sessionId);
    return session;
  }
}
