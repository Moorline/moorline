import type { DatabaseSync } from 'node:sqlite';
import { mapRows } from './rowMappers.js';
import { hydrateSession, RUNTIME_SESSION_SELECT, type RuntimeSessionDbRow, type RuntimeSessionRow } from './types.js';

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsertSession(row: RuntimeSessionRow): void {
    this.db
      .prepare(`
        INSERT INTO runtime_sessions (
          session_id, scope_id, transport_resource_id, thread_id, transport_resource_name, workspace_path,
          runtime_mode, lifecycle_status, summary, provider, provider_thread_id, resume_thread_id,
          provider_status, provider_auto_start_enabled, active_turn_id, created_at, updated_at, last_activity_at, archived_at, last_error,
          owner_kind, owner_id, owner_label, objective, tags_json, created_by, last_directed_at, last_directed_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          scope_id = excluded.scope_id,
          transport_resource_id = excluded.transport_resource_id,
          thread_id = excluded.thread_id,
          transport_resource_name = excluded.transport_resource_name,
          workspace_path = excluded.workspace_path,
          runtime_mode = excluded.runtime_mode,
          lifecycle_status = excluded.lifecycle_status,
          summary = excluded.summary,
          provider = excluded.provider,
          provider_thread_id = excluded.provider_thread_id,
          resume_thread_id = excluded.resume_thread_id,
          provider_status = excluded.provider_status,
          provider_auto_start_enabled = excluded.provider_auto_start_enabled,
          active_turn_id = excluded.active_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_activity_at = excluded.last_activity_at,
          archived_at = excluded.archived_at,
          last_error = excluded.last_error,
          owner_kind = excluded.owner_kind,
          owner_id = excluded.owner_id,
          owner_label = excluded.owner_label,
          objective = excluded.objective,
          tags_json = excluded.tags_json,
          created_by = excluded.created_by,
          last_directed_at = excluded.last_directed_at,
          last_directed_by = excluded.last_directed_by
      `)
      .run(
        row.sessionId,
        row.scopeId,
        row.transportResourceId,
        row.threadId,
        row.transportResourceName,
        row.workspacePath,
        row.runtimeMode,
        row.lifecycleStatus,
        row.summary,
        row.provider,
        row.providerThreadId,
        row.resumeThreadId,
        row.providerStatus,
        row.providerAutoStartEnabled !== false ? 1 : 0,
        row.activeTurnId,
        row.createdAt,
        row.updatedAt,
        row.lastActivityAt,
        row.archivedAt,
        row.lastError,
        row.ownerKind ?? null,
        row.ownerId ?? null,
        row.ownerLabel ?? null,
        row.objective ?? null,
        JSON.stringify(row.tags ?? []),
        row.createdBy ?? null,
        row.lastDirectedAt ?? null,
        row.lastDirectedBy ?? null
      );
  }

  getSession(sessionId: string): RuntimeSessionRow | null {
    return hydrateSession(
      this.db.prepare(`${RUNTIME_SESSION_SELECT} WHERE session_id = ?`).get(sessionId) as RuntimeSessionDbRow | undefined
    );
  }

  getSessionByTransportResourceId(transportResourceId: string | null | undefined): RuntimeSessionRow | null {
    if (typeof transportResourceId !== 'string' || transportResourceId.trim().length === 0) {
      return null;
    }
    return hydrateSession(
      this.db.prepare(`${RUNTIME_SESSION_SELECT} WHERE transport_resource_id = ?`).get(transportResourceId) as RuntimeSessionDbRow | undefined
    );
  }

  getSessionByThreadId(threadId: string): RuntimeSessionRow | null {
    return hydrateSession(
      this.db.prepare(`${RUNTIME_SESSION_SELECT} WHERE thread_id = ?`).get(threadId) as RuntimeSessionDbRow | undefined
    );
  }

  listSessions(): RuntimeSessionRow[] {
    return mapRows<RuntimeSessionDbRow>(
      this.db
        .prepare(`${RUNTIME_SESSION_SELECT} ORDER BY created_at ASC, session_id ASC`)
        .all()
    )
      .map((row) => hydrateSession(row)!)
      .filter((row): row is RuntimeSessionRow => row !== null);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM runtime_sessions WHERE session_id = ?`).run(sessionId);
  }
}
