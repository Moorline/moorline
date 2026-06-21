import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeAgentKind, RuntimeModeName } from '../../../types/runtime.js';
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

  getByTransportResourceId(transportResourceId: string): RuntimeSessionRow | null {
    return this.store.getSessionByTransportResourceId(transportResourceId);
  }

  getByThreadId(threadId: string): RuntimeSessionRow | null {
    return this.store.getSessionByThreadId(threadId);
  }

  create(input: {
    scopeId: string;
    transportResourceId: string;
    transportResourceName: string;
    requestedName: string;
    runtimeMode: RuntimeModeName;
    agentKind?: RuntimeAgentKind;
    nowIso: string;
    providerAutoStartEnabled?: boolean;
    owner?: SessionOwnerLink;
    objective?: string;
    tags?: string[];
    createdBy?: string;
    providerCwd?: string | null;
  }): RuntimeSessionRow {
    const sessionId = uniqueSessionId(input.requestedName, input.nowIso, this.list());
    const threadId = `session:${sessionId}`;
    const agentKind = input.agentKind ?? 'workspace';
    const workspacePath = agentKind === 'workspace' ? join(this.workspacesDir, sessionId) : null;
    if (workspacePath) {
      mkdirSync(workspacePath, { recursive: true });
    }

    const row: RuntimeSessionRow = {
      sessionId,
      scopeId: input.scopeId,
      transportResourceId: input.transportResourceId,
      threadId,
      transportResourceName: input.transportResourceName,
      agentKind,
      workspacePath,
      providerCwd: input.providerCwd ?? workspacePath,
      runtimeMode: input.runtimeMode,
      lifecycleStatus: 'hot',
      summary: null,
      provider: this.providerPackageId,
      providerThreadId: null,
      resumeCursor: null,
      toolGrantIds: [],
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
      if (workspacePath) {
        rmSync(workspacePath, { recursive: true, force: true });
      }
      throw error;
    }
  }

  updateSession(row: RuntimeSessionRow): RuntimeSessionRow {
    this.store.upsertSession(row);
    return this.store.getSession(row.sessionId)!;
  }

  updateSummary(transportResourceId: string, summary: string, nowIso: string): RuntimeSessionRow | null {
    const session = this.getByTransportResourceId(transportResourceId);
    if (!session) {
      return null;
    }
    return this.updateSession({
      ...session,
      summary,
      updatedAt: nowIso
    });
  }

  markDirected(input: { transportResourceId: string; directedAt: string; directedBy: string }): RuntimeSessionRow | null {
    const session = this.getByTransportResourceId(input.transportResourceId);
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

  archive(transportResourceId: string, nowIso: string): RuntimeSessionRow | null {
    const session = this.getByTransportResourceId(transportResourceId);
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

  resume(transportResourceId: string, nowIso: string): RuntimeSessionRow | null {
    const session = this.getByTransportResourceId(transportResourceId);
    if (!session) {
      return null;
    }
    return this.updateSession({
      ...session,
      lifecycleStatus: 'hot',
      archivedAt: null,
      lastError: null,
      providerStatus: session.providerStatus === 'closed' ? 'connecting' : session.providerStatus,
      providerAutoStartEnabled: true,
      updatedAt: nowIso,
      lastActivityAt: nowIso
    });
  }

  delete(transportResourceId: string): RuntimeSessionRow | null {
    const session = this.getByTransportResourceId(transportResourceId);
    if (!session) {
      return null;
    }
    this.deleteSessionWorkspace(session);
    this.store.deleteSession(session.sessionId);
    return session;
  }

  deleteRecordOnly(transportResourceId: string): RuntimeSessionRow | null {
    const session = this.getByTransportResourceId(transportResourceId);
    if (!session) {
      return null;
    }
    this.store.deleteSession(session.sessionId);
    return session;
  }

  deleteArchived(transportResourceId: string): RuntimeSessionRow | null {
    const session = this.getByTransportResourceId(transportResourceId);
    if (!session || session.lifecycleStatus !== 'archived') {
      return null;
    }
    this.deleteSessionWorkspace(session);
    this.store.deleteSession(session.sessionId);
    return session;
  }

  private deleteSessionWorkspace(session: RuntimeSessionRow): void {
    if (session.workspacePath) {
      let managedWorkspacePath: string;
      try {
        managedWorkspacePath = assertRuntimeOwnedWorkspacePath({
          workspacesDir: this.workspacesDir,
          workspacePath: session.workspacePath,
          expectedWorkDirName: session.sessionId,
          entityLabel: `Session ${session.sessionId}`
        });
      } catch (error) {
        console.warn(
          `[moorline.session.delete.blocked] sessionId=${session.sessionId} workspacePath=${session.workspacePath} reason=${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
      }
      rmSync(managedWorkspacePath, { recursive: true, force: true });
    }
  }
}
