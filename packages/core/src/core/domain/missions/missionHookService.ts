import { randomUUID } from 'node:crypto';
import type { RuntimeLifecycleService } from '../../runtime/lifecycle/runtimeLifecycleService.js';
import type { RuntimeMissionHookBindingRow, RuntimeMissionRow, SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import {
  normalizeMissionHookCondition,
  normalizeMissionHookKey,
  normalizeMissionHookPayload,
  normalizeMissionHookSource,
  parseMissionHookConditionJson,
  matchesMissionHookCondition,
  type MissionHookCondition,
  type MissionHookConditionValue
} from './missionHookValidation.js';

interface MissionHookDispatchResult {
  hookKey: string;
  source: string;
  bindingCount: number;
  matchedBindingCount: number;
  triggeredMissionIds: string[];
}

interface MissionHookServiceDeps {
  store: SqliteSessionStore;
  lifecycle: RuntimeLifecycleService;
  now(): string;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
}

function assertHookEmitterActor(actorId: string): void {
  if (!actorId.startsWith('plugin:') && !actorId.startsWith('runtime:')) {
    throw new Error('Mission hook triggers are only allowed from plugin:* or runtime:* actors.');
  }
}

function conditionToJson(condition: MissionHookCondition): string | null {
  const keys = Object.keys(condition);
  if (keys.length === 0) {
    return null;
  }
  return JSON.stringify(condition);
}

function canonicalConditionJson(conditionJson: string | null): string {
  if (!conditionJson) {
    return '';
  }
  const parsed = parseMissionHookConditionJson(conditionJson);
  const ordered = Object.keys(parsed)
    .sort((left, right) => left.localeCompare(right))
    .reduce<Record<string, MissionHookConditionValue>>((acc, key) => {
      acc[key] = parsed[key]!;
      return acc;
    }, {});
  return JSON.stringify(ordered);
}

export class MissionHookService {
  constructor(private readonly deps: MissionHookServiceDeps) {}

  listBindings(input?: { missionId?: string; hookKey?: string }): RuntimeMissionHookBindingRow[] {
    const missionId = input?.missionId?.trim();
    const hookKey = input?.hookKey ? normalizeMissionHookKey(input.hookKey) : undefined;
    return this.deps.store.listMissionHookBindings({
      ...(missionId ? { missionId } : {}),
      ...(hookKey ? { hookKey } : {})
    });
  }

  bind(input: {
    actorId: string;
    missionId: string;
    hookKey: string;
    condition?: MissionHookCondition;
  }): RuntimeMissionHookBindingRow {
    const mission = this.deps.store.getMission(input.missionId);
    if (!mission) {
      throw new Error(`Mission ${input.missionId} not found.`);
    }
    if (mission.archivedAt) {
      throw new Error(`Mission ${input.missionId} is archived and cannot receive hook bindings.`);
    }

    const hookKey = normalizeMissionHookKey(input.hookKey);
    const condition = normalizeMissionHookCondition(input.condition);
    const conditionJson = conditionToJson(condition);
    const conditionFingerprint = canonicalConditionJson(conditionJson);
    const existing = this.deps.store
      .listMissionHookBindings({ missionId: mission.missionId, hookKey })
      .find((entry) => canonicalConditionJson(entry.conditionJson) === conditionFingerprint);
    if (existing) {
      return existing;
    }

    const nowIso = this.deps.now();
    const row: RuntimeMissionHookBindingRow = {
      bindingId: randomUUID(),
      missionId: mission.missionId,
      hookKey,
      conditionJson,
      createdBy: input.actorId,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    this.deps.store.upsertMissionHookBinding(row);
    const persisted = this.deps.store.getMissionHookBinding(row.bindingId) ?? row;
    this.deps.appendAuditEvent('mission.hook.binding.created', {
      bindingId: persisted.bindingId,
      missionId: persisted.missionId,
      hookKey,
      actorId: input.actorId,
      hasCondition: Boolean(persisted.conditionJson)
    });
    return persisted;
  }

  unbind(input: { actorId: string; bindingId: string }): RuntimeMissionHookBindingRow | null {
    const removed = this.deps.store.deleteMissionHookBinding(input.bindingId);
    if (removed) {
      this.deps.appendAuditEvent('mission.hook.binding.deleted', {
        bindingId: removed.bindingId,
        missionId: removed.missionId,
        hookKey: removed.hookKey,
        actorId: input.actorId
      });
    }
    return removed;
  }

  async emit(input: {
    actorId: string;
    hookKey: string;
    payload?: Record<string, unknown>;
    source?: string;
  }): Promise<MissionHookDispatchResult> {
    assertHookEmitterActor(input.actorId);
    const hookKey = normalizeMissionHookKey(input.hookKey);
    const source = normalizeMissionHookSource(input.source?.trim() || input.actorId);
    const payload = normalizeMissionHookPayload(input.payload);
    const bindings = this.deps.store.listMissionHookBindings({ hookKey });
    if (bindings.length === 0) {
      this.deps.appendAuditEvent('mission.hook.trigger.unknown', {
        hookKey,
        source,
        actorId: input.actorId,
        payloadKeys: Object.keys(payload)
      });
      throw new Error(`Unknown mission hook: ${hookKey}`);
    }

    const missionsById = new Map<string, RuntimeMissionRow>();
    for (const binding of bindings) {
      const mission = this.deps.store.getMission(binding.missionId);
      if (!mission || mission.archivedAt) {
        continue;
      }
      missionsById.set(mission.missionId, mission);
    }

    const matchedMissionIds = new Set<string>();
    let matchedBindingCount = 0;
    for (const binding of bindings) {
      if (!missionsById.has(binding.missionId)) {
        continue;
      }
      const condition = parseMissionHookConditionJson(binding.conditionJson);
      if (!matchesMissionHookCondition(payload, condition)) {
        continue;
      }
      matchedBindingCount += 1;
      matchedMissionIds.add(binding.missionId);
    }

    const triggeredMissionIds = [...matchedMissionIds];
    for (const missionId of triggeredMissionIds) {
      try {
        await this.deps.lifecycle.runMissionTurn(missionId, 'hook', 'runtime:mission/hook');
      } catch (error) {
        this.deps.appendAuditEvent('mission.hook.dispatch.failed', {
          missionId,
          hookKey,
          source,
          actorId: input.actorId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    this.deps.appendAuditEvent('mission.hook.trigger.dispatched', {
      hookKey,
      source,
      actorId: input.actorId,
      payloadKeys: Object.keys(payload),
      bindingCount: bindings.length,
      matchedBindingCount,
      triggeredMissionIds
    });

    return {
      hookKey,
      source,
      bindingCount: bindings.length,
      matchedBindingCount,
      triggeredMissionIds
    };
  }
}
