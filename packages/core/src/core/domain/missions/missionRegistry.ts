import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeModeName } from '../../../types/runtime.js';
import {
  SqliteSessionStore,
  type RuntimeMissionRow,
  type RuntimeMissionRunRow
} from '../../system/state/sqliteSessionStore.js';
import { assertRuntimeOwnedWorkspacePath } from '../../shared/fs/runtimeOwnedPath.js';
import {
  computeMissionRunAtOrAfterWithMeta,
  computeNextMissionRunAtWithMeta,
  missionScheduleMetaToJson,
  parseMissionSchedule,
  parseMissionScheduleMeta,
  parseMissionStartTime
} from './missionSchedule.js';

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'mission';
}

function nextMissionId(name: string, nowIso: string): string {
  const stamp = nowIso.replace(/[^0-9]/g, '').slice(0, 17);
  const entropy = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${slugify(name)}-${stamp}-${entropy}`;
}

function uniqueMissionId(name: string, nowIso: string, existing: RuntimeMissionRow[]): string {
  const base = nextMissionId(name, nowIso);
  const ids = new Set(existing.map((mission) => mission.missionId));
  if (!ids.has(base)) {
    return base;
  }
  let counter = 2;
  while (ids.has(`${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

export class MissionRegistry {
  constructor(
    private readonly store: SqliteSessionStore,
    private readonly workspacesDir: string
  ) {}

  list(): RuntimeMissionRow[] {
    return this.store.listMissions();
  }

  getById(missionId: string): RuntimeMissionRow | null {
    return this.store.getMission(missionId);
  }

  getBySpaceId(spaceId: string): RuntimeMissionRow | null {
    return this.store.getMissionBySpaceId(spaceId);
  }

  getByThreadId(threadId: string): RuntimeMissionRow | null {
    return this.store.getMissionByThreadId(threadId);
  }

  create(input: {
    scopeId: string;
    spaceId: string;
    spaceName: string;
    title: string;
    goal: string;
    schedule: string;
    startTime?: string;
    runtimeMode: RuntimeModeName;
    nowIso: string;
  }): RuntimeMissionRow {
    const parsedSchedule = parseMissionSchedule(input.schedule);
    const scheduleAnchorAt = parseMissionStartTime(input.startTime, input.nowIso);
    const missionId = uniqueMissionId(input.title, input.nowIso, this.list());
    const workspacePath = join(this.workspacesDir, missionId);
    mkdirSync(workspacePath, { recursive: true });

    const row: RuntimeMissionRow = {
      missionId,
      scopeId: input.scopeId,
      spaceId: input.spaceId,
      threadId: `mission:${missionId}`,
      spaceName: input.spaceName,
      title: input.title,
      goal: input.goal,
      scheduleText: parsedSchedule.normalized,
      scheduleAnchorAt,
      cadenceMinutes: parsedSchedule.cadenceMinutes,
      scheduleMetaJson: missionScheduleMetaToJson(parsedSchedule.meta),
      runtimeMode: input.runtimeMode,
      workspacePath,
      lifecycleStatus: 'sleeping',
      pausedAt: null,
      lastRunAt: null,
      nextRunAt: computeMissionRunAtOrAfterWithMeta(
        scheduleAnchorAt,
        parsedSchedule.cadenceMinutes,
        input.nowIso,
        parsedSchedule.meta
      ),
      lastSuccessAt: null,
      completedAt: null,
      stoppedAt: null,
      archivedAt: null,
      lastError: null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso
    };
    try {
      this.store.upsertMission(row);
      return this.store.getMission(missionId)!;
    } catch (error) {
      rmSync(workspacePath, { recursive: true, force: true });
      throw error;
    }
  }

  createDraft(input: {
    scopeId: string;
    spaceId: string;
    spaceName: string;
    title: string;
    runtimeMode: RuntimeModeName;
    nowIso: string;
  }): RuntimeMissionRow {
    const missionId = uniqueMissionId(input.title, input.nowIso, this.list());
    const workspacePath = join(this.workspacesDir, missionId);
    mkdirSync(workspacePath, { recursive: true });

    const row: RuntimeMissionRow = {
      missionId,
      scopeId: input.scopeId,
      spaceId: input.spaceId,
      threadId: `mission:${missionId}`,
      spaceName: input.spaceName,
      title: input.title,
      goal: '',
      scheduleText: '',
      scheduleAnchorAt: input.nowIso,
      cadenceMinutes: 0,
      scheduleMetaJson: null,
      runtimeMode: input.runtimeMode,
      workspacePath,
      lifecycleStatus: 'draft',
      pausedAt: null,
      lastRunAt: null,
      nextRunAt: null,
      lastSuccessAt: null,
      completedAt: null,
      stoppedAt: null,
      archivedAt: null,
      lastError: null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso
    };
    try {
      this.store.upsertMission(row);
      return this.store.getMission(missionId)!;
    } catch (error) {
      rmSync(workspacePath, { recursive: true, force: true });
      throw error;
    }
  }

  configureDraftMission(input: {
    missionId: string;
    goal: string;
    schedule: string;
    startTime?: string;
    runtimeMode?: RuntimeModeName;
    nowIso: string;
  }): RuntimeMissionRow {
    const mission = this.getById(input.missionId);
    if (!mission) {
      throw new Error(`Mission ${input.missionId} not found.`);
    }
    if (mission.lifecycleStatus !== 'draft') {
      throw new Error(`Mission ${input.missionId} is not waiting for initial setup.`);
    }

    const parsedSchedule = parseMissionSchedule(input.schedule);
    const scheduleAnchorAt = parseMissionStartTime(input.startTime, input.nowIso);
    const row: RuntimeMissionRow = {
      ...mission,
      goal: input.goal.trim(),
      scheduleText: parsedSchedule.normalized,
      scheduleAnchorAt,
      cadenceMinutes: parsedSchedule.cadenceMinutes,
      scheduleMetaJson: missionScheduleMetaToJson(parsedSchedule.meta),
      runtimeMode: input.runtimeMode ?? mission.runtimeMode,
      lifecycleStatus: 'sleeping',
      pausedAt: null,
      nextRunAt: computeMissionRunAtOrAfterWithMeta(
        scheduleAnchorAt,
        parsedSchedule.cadenceMinutes,
        input.nowIso,
        parsedSchedule.meta
      ),
      stoppedAt: null,
      lastError: null,
      updatedAt: input.nowIso
    };
    this.store.upsertMission(row);
    return this.store.getMission(row.missionId)!;
  }

  update(row: RuntimeMissionRow): RuntimeMissionRow {
    this.store.upsertMission(row);
    return this.store.getMission(row.missionId)!;
  }

  deleteArchived(spaceId: string): RuntimeMissionRow | null {
    const mission = this.getBySpaceId(spaceId);
    if (!mission || !mission.archivedAt) {
      return null;
    }
    let managedWorkspacePath: string;
    try {
      managedWorkspacePath = assertRuntimeOwnedWorkspacePath({
        workspacesDir: this.workspacesDir,
        workspacePath: mission.workspacePath,
        expectedWorkspaceId: mission.missionId,
        entityLabel: `Mission ${mission.missionId}`
      });
    } catch (error) {
      console.warn(
        `[moorline.mission.delete.blocked] missionId=${mission.missionId} workspacePath=${mission.workspacePath} reason=${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
    rmSync(managedWorkspacePath, { recursive: true, force: true });
    this.store.deleteMission(mission.missionId);
    return mission;
  }

  listRuns(missionId: string, limit = 10): RuntimeMissionRunRow[] {
    return this.store.listMissionRuns(missionId, limit);
  }

  getActiveRun(missionId: string): RuntimeMissionRunRow | null {
    return this.store.getActiveMissionRun(missionId);
  }

  scheduleMeta(mission: RuntimeMissionRow) {
    return parseMissionScheduleMeta(mission.scheduleMetaJson);
  }

  isOneShotSchedule(mission: RuntimeMissionRow): boolean {
    return this.scheduleMeta(mission)?.kind === 'once';
  }

  nextRunAt(mission: RuntimeMissionRow, referenceIso: string): string | null {
    return computeNextMissionRunAtWithMeta(
      mission.scheduleAnchorAt,
      mission.cadenceMinutes,
      referenceIso,
      this.scheduleMeta(mission)
    );
  }

  runAtOrAfter(mission: RuntimeMissionRow, referenceIso: string): string | null {
    return computeMissionRunAtOrAfterWithMeta(
      mission.scheduleAnchorAt,
      mission.cadenceMinutes,
      referenceIso,
      this.scheduleMeta(mission)
    );
  }
}
