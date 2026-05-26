import type { DatabaseSync } from 'node:sqlite';
import { mapRows } from './rowMappers.js';
import {
  RUNTIME_MISSION_SELECT,
  type RuntimeMissionHookBindingRow,
  type RuntimeMissionRow,
  type RuntimeMissionRunRow
} from './types.js';

export class MissionRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsertMission(row: RuntimeMissionRow): void {
    this.db
      .prepare(`
        INSERT INTO runtime_missions (
          mission_id, scope_id, space_id, thread_id, space_name, title, goal, schedule_text,
          schedule_anchor_at, cadence_minutes, schedule_meta_json, runtime_mode, workspace_path, lifecycle_status, paused_at, last_run_at,
          next_run_at, last_success_at, completed_at, stopped_at, archived_at, last_error, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mission_id) DO UPDATE SET
          scope_id = excluded.scope_id,
          space_id = excluded.space_id,
          thread_id = excluded.thread_id,
          space_name = excluded.space_name,
          title = excluded.title,
          goal = excluded.goal,
          schedule_text = excluded.schedule_text,
          schedule_anchor_at = excluded.schedule_anchor_at,
          cadence_minutes = excluded.cadence_minutes,
          schedule_meta_json = excluded.schedule_meta_json,
          runtime_mode = excluded.runtime_mode,
          workspace_path = excluded.workspace_path,
          lifecycle_status = excluded.lifecycle_status,
          paused_at = excluded.paused_at,
          last_run_at = excluded.last_run_at,
          next_run_at = excluded.next_run_at,
          last_success_at = excluded.last_success_at,
          completed_at = excluded.completed_at,
          stopped_at = excluded.stopped_at,
          archived_at = excluded.archived_at,
          last_error = excluded.last_error,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `)
      .run(
        row.missionId,
        row.scopeId,
        row.spaceId,
        row.threadId,
        row.spaceName,
        row.title,
        row.goal,
        row.scheduleText,
        row.scheduleAnchorAt,
        row.cadenceMinutes,
        row.scheduleMetaJson ?? null,
        row.runtimeMode,
        row.workspacePath,
        row.lifecycleStatus,
        row.pausedAt,
        row.lastRunAt,
        row.nextRunAt,
        row.lastSuccessAt,
        row.completedAt,
        row.stoppedAt,
        row.archivedAt,
        row.lastError,
        row.createdAt,
        row.updatedAt
      );
  }

  getMission(missionId: string): RuntimeMissionRow | null {
    return (this.db.prepare(`${RUNTIME_MISSION_SELECT} WHERE mission_id = ?`).get(missionId) as RuntimeMissionRow | undefined) ?? null;
  }

  getMissionBySpaceId(spaceId: string | null | undefined): RuntimeMissionRow | null {
    if (typeof spaceId !== 'string' || spaceId.trim().length === 0) {
      return null;
    }
    return (this.db.prepare(`${RUNTIME_MISSION_SELECT} WHERE space_id = ?`).get(spaceId) as RuntimeMissionRow | undefined) ?? null;
  }

  getMissionByThreadId(threadId: string): RuntimeMissionRow | null {
    return (this.db.prepare(`${RUNTIME_MISSION_SELECT} WHERE thread_id = ?`).get(threadId) as RuntimeMissionRow | undefined) ?? null;
  }

  listMissions(): RuntimeMissionRow[] {
    return mapRows<RuntimeMissionRow>(
      this.db
        .prepare(`${RUNTIME_MISSION_SELECT} ORDER BY created_at ASC, mission_id ASC`)
        .all()
    );
  }

  deleteMission(missionId: string): void {
    this.db.prepare(`DELETE FROM runtime_mission_runs WHERE mission_id = ?`).run(missionId);
    this.db.prepare(`DELETE FROM runtime_mission_hook_bindings WHERE mission_id = ?`).run(missionId);
    this.db.prepare(`DELETE FROM runtime_missions WHERE mission_id = ?`).run(missionId);
  }

  upsertMissionRun(row: RuntimeMissionRunRow): void {
    this.db
      .prepare(`
        INSERT INTO runtime_mission_runs (
          run_id, mission_id, trigger_source, lifecycle_status, summary, error_message, started_at, finished_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          mission_id = excluded.mission_id,
          trigger_source = excluded.trigger_source,
          lifecycle_status = excluded.lifecycle_status,
          summary = excluded.summary,
          error_message = excluded.error_message,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at
      `)
      .run(
        row.runId,
        row.missionId,
        row.trigger,
        row.lifecycleStatus,
        row.summary,
        row.errorMessage,
        row.startedAt,
        row.finishedAt
      );
  }

  getMissionRun(runId: string): RuntimeMissionRunRow | null {
    const row = this.db
      .prepare(`
        SELECT
          run_id as runId,
          mission_id as missionId,
          trigger_source as trigger,
          lifecycle_status as lifecycleStatus,
          summary,
          error_message as errorMessage,
          started_at as startedAt,
          finished_at as finishedAt
        FROM runtime_mission_runs
        WHERE run_id = ?
      `)
      .get(runId) as RuntimeMissionRunRow | undefined;
    return row ?? null;
  }

  listMissionRuns(missionId: string, limit = 20): RuntimeMissionRunRow[] {
    return mapRows<RuntimeMissionRunRow>(
      this.db
        .prepare(`
        SELECT
          run_id as runId,
          mission_id as missionId,
          trigger_source as trigger,
          lifecycle_status as lifecycleStatus,
          summary,
          error_message as errorMessage,
          started_at as startedAt,
          finished_at as finishedAt
        FROM runtime_mission_runs
        WHERE mission_id = ?
        ORDER BY started_at DESC, run_id DESC
        LIMIT ?
      `)
        .all(missionId, limit)
    );
  }

  getActiveMissionRun(missionId: string): RuntimeMissionRunRow | null {
    return (this.db
      .prepare(`
        SELECT
          run_id as runId,
          mission_id as missionId,
          trigger_source as trigger,
          lifecycle_status as lifecycleStatus,
          summary,
          error_message as errorMessage,
          started_at as startedAt,
          finished_at as finishedAt
        FROM runtime_mission_runs
        WHERE mission_id = ? AND finished_at IS NULL
        ORDER BY started_at DESC, run_id DESC
        LIMIT 1
      `)
      .get(missionId) as RuntimeMissionRunRow | undefined) ?? null;
  }

  upsertMissionHookBinding(row: RuntimeMissionHookBindingRow): void {
    this.db
      .prepare(`
        INSERT INTO runtime_mission_hook_bindings (
          binding_id, mission_id, hook_key, condition_json, created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(binding_id) DO UPDATE SET
          mission_id = excluded.mission_id,
          hook_key = excluded.hook_key,
          condition_json = excluded.condition_json,
          created_by = excluded.created_by,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `)
      .run(
        row.bindingId,
        row.missionId,
        row.hookKey,
        row.conditionJson,
        row.createdBy,
        row.createdAt,
        row.updatedAt
      );
  }

  getMissionHookBinding(bindingId: string): RuntimeMissionHookBindingRow | null {
    return (
      (this.db
        .prepare(`
          SELECT
            binding_id as bindingId,
            mission_id as missionId,
            hook_key as hookKey,
            condition_json as conditionJson,
            created_by as createdBy,
            created_at as createdAt,
            updated_at as updatedAt
          FROM runtime_mission_hook_bindings
          WHERE binding_id = ?
        `)
        .get(bindingId) as RuntimeMissionHookBindingRow | undefined) ?? null
    );
  }

  listMissionHookBindings(input?: { missionId?: string; hookKey?: string }): RuntimeMissionHookBindingRow[] {
    if (input?.missionId && input?.hookKey) {
      return mapRows<RuntimeMissionHookBindingRow>(
        this.db
          .prepare(`
          SELECT
            binding_id as bindingId,
            mission_id as missionId,
            hook_key as hookKey,
            condition_json as conditionJson,
            created_by as createdBy,
            created_at as createdAt,
            updated_at as updatedAt
          FROM runtime_mission_hook_bindings
          WHERE mission_id = ? AND hook_key = ?
          ORDER BY created_at ASC, binding_id ASC
        `)
          .all(input.missionId, input.hookKey)
      );
    }
    if (input?.missionId) {
      return mapRows<RuntimeMissionHookBindingRow>(
        this.db
          .prepare(`
          SELECT
            binding_id as bindingId,
            mission_id as missionId,
            hook_key as hookKey,
            condition_json as conditionJson,
            created_by as createdBy,
            created_at as createdAt,
            updated_at as updatedAt
          FROM runtime_mission_hook_bindings
          WHERE mission_id = ?
          ORDER BY created_at ASC, binding_id ASC
        `)
          .all(input.missionId)
      );
    }
    if (input?.hookKey) {
      return mapRows<RuntimeMissionHookBindingRow>(
        this.db
          .prepare(`
          SELECT
            binding_id as bindingId,
            mission_id as missionId,
            hook_key as hookKey,
            condition_json as conditionJson,
            created_by as createdBy,
            created_at as createdAt,
            updated_at as updatedAt
          FROM runtime_mission_hook_bindings
          WHERE hook_key = ?
          ORDER BY created_at ASC, binding_id ASC
        `)
          .all(input.hookKey)
      );
    }
    return mapRows<RuntimeMissionHookBindingRow>(
      this.db
        .prepare(`
        SELECT
          binding_id as bindingId,
          mission_id as missionId,
          hook_key as hookKey,
          condition_json as conditionJson,
          created_by as createdBy,
          created_at as createdAt,
          updated_at as updatedAt
        FROM runtime_mission_hook_bindings
        ORDER BY created_at ASC, binding_id ASC
      `)
        .all()
    );
  }

  deleteMissionHookBinding(bindingId: string): RuntimeMissionHookBindingRow | null {
    const existing = this.getMissionHookBinding(bindingId);
    if (!existing) {
      return null;
    }
    this.db.prepare(`DELETE FROM runtime_mission_hook_bindings WHERE binding_id = ?`).run(bindingId);
    return existing;
  }

  deleteMissionHookBindingsByMissionId(missionId: string): void {
    this.db.prepare(`DELETE FROM runtime_mission_hook_bindings WHERE mission_id = ?`).run(missionId);
  }
}
