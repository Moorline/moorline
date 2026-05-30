import { randomUUID } from 'node:crypto';
import type { AppliedMoorlineConfig, RuntimeSurfaceState } from '../../../types/config.js';
import type { RuntimeActivityRecord } from '../../system/projection/runtimeActivityStore.js';
import type { RuntimeProvider } from '../../../types/provider.js';
import type { RuntimeMessagePayload, RuntimeTransportEvent } from '../../../types/transport.js';
import type { RuntimeMissionRow, RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';
import type { MissionRegistry } from '../../domain/missions/missionRegistry.js';
import type { ProviderSessionDirectory } from '../execution/providerSessionDirectory.js';
import type { SidecarScopeKind } from '../supervision/managedSidecar.js';
import type { SessionRegistry } from '../../domain/sessions/sessionState.js';
import type { RuntimeWorkManagementService } from '../../domain/sessions/runtimeWorkManagementService.js';
import { buildDraftMissionSetupPrompt } from '../../domain/missions/missionDraftSetup.js';

interface ManagedSpaceLifecycleServiceDeps {
  config: AppliedMoorlineConfig;
  getNamespaceState(): RuntimeSurfaceState | null;
  sessionRegistry: SessionRegistry;
  missionRegistry: MissionRegistry;
  providerService: RuntimeProvider;
  providerDirectory: ProviderSessionDirectory;
  workManagement: RuntimeWorkManagementService;
  getProviderAutoStartDefault(): boolean;
  queue<T>(key: string, work: () => Promise<T>): Promise<T>;
  now(): string;
  postTransportMessage(actor: string, spaceId: string, payload: RuntimeMessagePayload): Promise<void>;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  recordRuntimeActivity(input: Omit<RuntimeActivityRecord, 'activityId'>): void;
  rejectTurnWaitersForThread(threadId: string, reason: string): void;
  cleanupScopedSidecars(scopeKind: SidecarScopeKind, scopeKey: string, reason: string): Promise<void>;
}

function sameName(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

type ResourceLifecycleEvent = Extract<RuntimeTransportEvent, { type: 'resource.lifecycle' }>;

export class ManagedSpaceLifecycleService {
  constructor(private readonly deps: ManagedSpaceLifecycleServiceDeps) {}

  async handleEvent(event: RuntimeTransportEvent): Promise<void> {
    if (event.type !== 'resource.lifecycle') {
      return;
    }

    const namespace = this.deps.getNamespaceState();
    if (!namespace || event.scopeId !== this.deps.config.transport.scopeId) {
      return;
    }

    if (event.resource.kind !== 'room' && event.resource.kind !== 'thread') {
      this.recordTransportActivity({
        threadId: null,
        sessionId: null,
        spaceId: event.resource.id,
        kind: `transport.space.${event.action}`,
        title: 'Transport lifecycle observed',
        detail: `Observed ${event.resource.kind} ${event.resource.name}.`
      });
      return;
    }

    await this.deps.queue(`transport:lifecycle:${event.resource.id}`, async () => {
      const session = this.deps.sessionRegistry.getBySpaceId(event.resource.id);
      if (session) {
        await this.handleSessionEvent(session, event, namespace);
        return;
      }

      const mission = this.deps.missionRegistry.getBySpaceId(event.resource.id);
      if (mission) {
        await this.handleMissionEvent(mission, event, namespace);
        return;
      }

      if ((event.action === 'created' || event.action === 'updated') && event.resource.parentId === namespace.sessionsCategoryId) {
        await this.adoptSessionSpace(event.resource.id, event.resource.name);
        return;
      }

      if ((event.action === 'created' || event.action === 'updated') && event.resource.parentId === namespace.missionsCategoryId) {
        const mission = await this.deps.workManagement.adoptMissionChannel({
          actorId: 'runtime:transport/space-lifecycle',
          spaceId: event.resource.id,
          spaceName: event.resource.name
        });
        this.recordTransportActivity({
          threadId: mission.threadId,
          sessionId: null,
          spaceId: event.resource.id,
          kind: 'transport.mission_space.adopted',
          title: 'Mission adopted from transport',
          detail: `Adopted ${event.resource.name} as draft mission ${mission.missionId}.`
        });
        await this.deps.postTransportMessage('runtime:transport/space-lifecycle', event.resource.id, {
          text: buildDraftMissionSetupPrompt({
            title: mission.title,
            missionId: mission.missionId
          })
        });
      }
    });
  }

  private async handleSessionEvent(
    session: RuntimeSessionRow,
    event: ResourceLifecycleEvent,
    namespace: RuntimeSurfaceState
  ): Promise<void> {
    if (event.action === 'deleted') {
      await this.preserveDeletedSession(session);
      return;
    }

    if (!sameName(session.spaceName, event.resource.name)) {
      const updated = this.deps.sessionRegistry.updateSession({
        ...session,
        spaceName: event.resource.name,
        updatedAt: this.deps.now()
      });
      this.deps.appendAuditEvent('session.space.renamed', {
        sessionId: updated.sessionId,
        spaceId: updated.spaceId,
        previousName: session.spaceName,
        nextName: updated.spaceName,
        actorId: 'runtime:transport/space-lifecycle'
      });
      this.recordTransportActivity({
        threadId: updated.threadId,
        sessionId: updated.sessionId,
        spaceId: updated.spaceId,
        kind: 'transport.session_space.renamed',
        title: 'Session space renamed from transport',
        detail: `${session.spaceName} -> ${updated.spaceName}`
      });
      session = updated;
    }

    if (event.resource.parentId === namespace.archiveCategoryId && session.lifecycleStatus !== 'archived') {
      await this.deps.workManagement.archiveManagedSession({
        actorId: 'runtime:transport/space-lifecycle',
        spaceId: session.spaceId,
        sessionId: session.sessionId
      });
      this.recordTransportActivity({
        threadId: session.threadId,
        sessionId: session.sessionId,
        spaceId: session.spaceId,
        kind: 'transport.session_space.archived',
        title: 'Session archived from transport move',
        detail: `${session.spaceName} moved into the managed archive group.`
      });
    }
  }

  private async handleMissionEvent(
    mission: RuntimeMissionRow,
    event: ResourceLifecycleEvent,
    namespace: RuntimeSurfaceState
  ): Promise<void> {
    if (event.action === 'deleted') {
      const nowIso = this.deps.now();
      const updated = this.deps.missionRegistry.update({
        ...mission,
        lifecycleStatus: 'stopped',
        pausedAt: null,
        nextRunAt: null,
        stoppedAt: mission.stoppedAt ?? nowIso,
        archivedAt: mission.archivedAt ?? nowIso,
        lastError: 'Managed transport space deleted outside Moorline.',
        updatedAt: nowIso
      });
      this.deps.providerService.stopSession(updated.threadId);
      this.deps.providerDirectory.delete(updated.threadId);
      this.deps.rejectTurnWaitersForThread(updated.threadId, `Mission ${updated.missionId} lost its transport space.`);
      this.deps.appendAuditEvent('mission.space.deleted_externally', {
        missionId: updated.missionId,
        spaceId: updated.spaceId,
        actorId: 'runtime:transport/space-lifecycle'
      });
      this.recordTransportActivity({
        threadId: updated.threadId,
        sessionId: null,
        spaceId: updated.spaceId,
        kind: 'transport.mission_space.deleted',
        title: 'Mission space deleted externally',
        detail: `Preserved mission ${updated.missionId} after its managed transport space was deleted.`
      });
      return;
    }

    if (!sameName(mission.spaceName, event.resource.name) || !sameName(mission.title, event.resource.name)) {
      const updated = this.deps.missionRegistry.update({
        ...mission,
        spaceName: event.resource.name,
        title: event.resource.name,
        updatedAt: this.deps.now()
      });
      this.deps.appendAuditEvent('mission.space.renamed', {
        missionId: updated.missionId,
        spaceId: updated.spaceId,
        previousName: mission.spaceName,
        nextName: updated.spaceName,
        actorId: 'runtime:transport/space-lifecycle'
      });
      this.recordTransportActivity({
        threadId: updated.threadId,
        sessionId: null,
        spaceId: updated.spaceId,
        kind: 'transport.mission_space.renamed',
        title: 'Mission space renamed from transport',
        detail: `${mission.spaceName} -> ${updated.spaceName}`
      });
      mission = updated;
    }

    if (event.resource.parentId === namespace.archiveCategoryId && !mission.archivedAt) {
      await this.deps.workManagement.archiveMission({
        actorId: 'runtime:transport/space-lifecycle',
        spaceId: mission.spaceId,
        missionId: mission.missionId
      });
      this.recordTransportActivity({
        threadId: mission.threadId,
        sessionId: null,
        spaceId: mission.spaceId,
        kind: 'transport.mission_space.archived',
        title: 'Mission archived from transport move',
        detail: `${mission.spaceName} moved into the managed archive group.`
      });
    }
  }

  private async adoptSessionSpace(spaceId: string, spaceName: string): Promise<void> {
    if (this.deps.sessionRegistry.getBySpaceId(spaceId) || this.deps.missionRegistry.getBySpaceId(spaceId)) {
      return;
    }

    const session = this.deps.sessionRegistry.create({
      scopeId: this.deps.config.transport.scopeId,
      spaceId,
      spaceName,
      requestedName: spaceName,
      runtimeMode: this.deps.config.defaults.runtimeMode,
      nowIso: this.deps.now(),
      providerAutoStartEnabled: this.deps.getProviderAutoStartDefault(),
      createdBy: 'runtime:transport/space-lifecycle'
    });
    this.deps.appendAuditEvent('session.adopted_from_transport', {
      sessionId: session.sessionId,
      spaceId: session.spaceId,
      actorId: 'runtime:transport/space-lifecycle'
    });
    this.recordTransportActivity({
      threadId: session.threadId,
      sessionId: session.sessionId,
      spaceId: session.spaceId,
      kind: 'transport.session_space.adopted',
      title: 'Session adopted from transport',
      detail: `Adopted ${spaceName} as managed session ${session.sessionId}.`
    });
  }

  private async preserveDeletedSession(session: RuntimeSessionRow): Promise<void> {
    const nowIso = this.deps.now();
    this.deps.providerService.stopSession(session.threadId);
    this.deps.providerDirectory.delete(session.threadId);
    this.deps.rejectTurnWaitersForThread(session.threadId, `Session ${session.sessionId} lost its transport space.`);
    await this.deps.cleanupScopedSidecars('session', session.sessionId, `session ${session.sessionId} lost its transport space`);
    const updated = this.deps.sessionRegistry.updateSession({
      ...session,
      lifecycleStatus: 'archived',
      archivedAt: session.archivedAt ?? nowIso,
      providerThreadId: null,
      resumeThreadId: null,
      providerStatus: 'closed',
      activeTurnId: null,
      lastError: 'Managed transport space deleted outside Moorline.',
      updatedAt: nowIso
    });
    this.deps.appendAuditEvent('session.space.deleted_externally', {
      sessionId: updated.sessionId,
      spaceId: updated.spaceId,
      actorId: 'runtime:transport/space-lifecycle'
    });
    this.recordTransportActivity({
      threadId: updated.threadId,
      sessionId: updated.sessionId,
      spaceId: updated.spaceId,
      kind: 'transport.session_space.deleted',
      title: 'Session space deleted externally',
      detail: `Preserved session ${updated.sessionId} after its managed transport space was deleted.`
    });
  }

  private recordTransportActivity(input: {
    threadId: string | null;
    sessionId: string | null;
    spaceId: string | null;
    kind: string;
    title: string;
    detail: string;
  }): void {
    this.deps.recordRuntimeActivity({
      threadId: input.threadId ?? `transport:${input.spaceId ?? 'unknown'}`,
      sessionId: input.sessionId,
      spaceId: input.spaceId,
      sourceEventId: randomUUID(),
      kind: input.kind,
      severity: 'info',
      title: input.title,
      detail: input.detail,
      createdAt: this.deps.now()
    });
  }
}
