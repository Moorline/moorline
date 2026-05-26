import type { DatabaseSync } from 'node:sqlite';
import type { ManagedSidecarRecord, SidecarScopeKind } from '../../../runtime/supervision/managedSidecar.js';
import { mapRows } from './rowMappers.js';
import { hydrateManagedSidecar, MANAGED_SIDECAR_SELECT, type ManagedSidecarDbRow } from './types.js';

export class ManagedSidecarRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsertManagedSidecar(row: ManagedSidecarRecord): void {
    this.db
      .prepare(`
        INSERT INTO managed_sidecars (
          sidecar_id, instance_id, plugin_id, sidecar_name, scope_kind, scope_key, status, command, args_json, cwd,
          env_json, restart_policy, max_restarts, readiness_json, artifact_dir, pid, restart_count, started_at, ready_at,
          stopped_at, last_exit_code, last_exit_signal, last_error, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sidecar_id) DO UPDATE SET
          instance_id = excluded.instance_id,
          plugin_id = excluded.plugin_id,
          sidecar_name = excluded.sidecar_name,
          scope_kind = excluded.scope_kind,
          scope_key = excluded.scope_key,
          status = excluded.status,
          command = excluded.command,
          args_json = excluded.args_json,
          cwd = excluded.cwd,
          env_json = excluded.env_json,
          restart_policy = excluded.restart_policy,
          max_restarts = excluded.max_restarts,
          readiness_json = excluded.readiness_json,
          artifact_dir = excluded.artifact_dir,
          pid = excluded.pid,
          restart_count = excluded.restart_count,
          started_at = excluded.started_at,
          ready_at = excluded.ready_at,
          stopped_at = excluded.stopped_at,
          last_exit_code = excluded.last_exit_code,
          last_exit_signal = excluded.last_exit_signal,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `)
      .run(
        row.sidecarId,
        row.instanceId,
        row.pluginId,
        row.name,
        row.scopeKind,
        row.scopeKey,
        row.status,
        row.command,
        JSON.stringify(row.args),
        row.cwd,
        JSON.stringify(row.env),
        row.restartPolicy,
        row.maxRestarts,
        JSON.stringify(row.readiness),
        row.artifactDir,
        row.pid,
        row.restartCount,
        row.startedAt,
        row.readyAt,
        row.stoppedAt,
        row.lastExitCode,
        row.lastExitSignal,
        row.lastError,
        row.updatedAt
      );
  }

  getManagedSidecar(sidecarId: string): ManagedSidecarRecord | null {
    return hydrateManagedSidecar(
      this.db.prepare(`${MANAGED_SIDECAR_SELECT} WHERE sidecar_id = ?`).get(sidecarId) as
        | ManagedSidecarDbRow
        | undefined
    );
  }

  listManagedSidecars(): ManagedSidecarRecord[] {
    return mapRows<ManagedSidecarDbRow>(
      this.db
        .prepare(`${MANAGED_SIDECAR_SELECT} ORDER BY updated_at ASC, sidecar_id ASC`)
        .all()
    )
      .map((row) => hydrateManagedSidecar(row)!)
      .filter((row): row is ManagedSidecarRecord => row !== null);
  }

  listManagedSidecarsByScope(scopeKind: SidecarScopeKind, scopeKey: string): ManagedSidecarRecord[] {
    return mapRows<ManagedSidecarDbRow>(
      this.db
        .prepare(`${MANAGED_SIDECAR_SELECT} WHERE scope_kind = ? AND scope_key = ? ORDER BY updated_at ASC, sidecar_id ASC`)
        .all(scopeKind, scopeKey)
    )
      .map((row) => hydrateManagedSidecar(row)!)
      .filter((row): row is ManagedSidecarRecord => row !== null);
  }
}
