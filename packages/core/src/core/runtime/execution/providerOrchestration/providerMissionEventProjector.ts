import type { ProviderRuntimeEvent } from '../../../../types/runtime.js';
import type { MissionRegistry } from '../../../domain/missions/missionRegistry.js';
import type { RuntimeMissionRow, RuntimeMissionRunRow } from '../../../system/state/sqliteSessionStore.js';

export interface ProviderMissionEventProjectorDeps {
  missions: MissionRegistry;
  upsertMissionRun(run: RuntimeMissionRunRow): void;
}

export class ProviderMissionEventProjector {
  constructor(private readonly deps: ProviderMissionEventProjectorDeps) {}

  apply(mission: RuntimeMissionRow | null, event: ProviderRuntimeEvent): void {
    if (!mission) {
      return;
    }
    const currentMission = this.deps.missions.getById(mission.missionId);
    if (!currentMission) {
      return;
    }
    const activeRun = this.deps.missions.getActiveRun(mission.missionId);
    if (event.type === 'turn.started') {
      this.deps.missions.update({
        ...currentMission,
        lifecycleStatus: 'active',
        updatedAt: event.createdAt,
        lastError: null
      });
      return;
    }
    if (event.type === 'request.opened' || event.type === 'user-input.requested') {
      this.deps.missions.update({
        ...currentMission,
        lifecycleStatus: 'waiting_on_user',
        updatedAt: event.createdAt
      });
      if (activeRun) {
        this.deps.upsertMissionRun({
          ...activeRun,
          lifecycleStatus: 'waiting_on_user'
        });
      }
      return;
    }
    if (event.type === 'request.resolved' || event.type === 'user-input.resolved') {
      this.deps.missions.update({
        ...currentMission,
        lifecycleStatus: 'active',
        updatedAt: event.createdAt
      });
      if (activeRun) {
        this.deps.upsertMissionRun({
          ...activeRun,
          lifecycleStatus: 'running'
        });
      }
      return;
    }
    if (event.type === 'turn.aborted') {
      this.deps.missions.update({
        ...currentMission,
        lifecycleStatus: 'failed',
        updatedAt: event.createdAt,
        lastError: event.payload.reason
      });
      return;
    }
    if (event.type === 'runtime.error') {
      this.deps.missions.update({
        ...currentMission,
        lifecycleStatus: 'failed',
        updatedAt: event.createdAt,
        lastError: event.payload.message
      });
    }
  }
}
