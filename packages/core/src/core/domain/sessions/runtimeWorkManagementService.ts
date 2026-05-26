import type { AppliedMoorlineConfig, RuntimeSurfaceState } from '../../../types/config.js';
import { parseMissionSchedule, parseMissionStartTime } from '../missions/missionSchedule.js';
import type { CommandReactor } from '../../runtime/execution/commandReactor.js';
import type { RuntimeSnapshotQuery } from '../../system/projection/runtimeSnapshotQuery.js';
import { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type { RuntimeProvider } from '../../../types/provider.js';
import type { MissionRegistry } from '../missions/missionRegistry.js';
import type { SessionOwnerLink, ArchivedSpaceTarget } from '../../../types/plugin.js';
import type { ProviderSessionDirectory } from '../../runtime/execution/providerSessionDirectory.js';
import type { RuntimeModeName } from '../../../types/runtime.js';
import type { SidecarScopeKind } from '../../runtime/supervision/managedSidecar.js';
import type { RuntimeMissionRow, RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';
import type { RuntimeMessagePayload, RuntimeSpaceRecord, RuntimeTransport } from '../../../types/transport.js';
import { isManagedWorkerSession } from './managedWorkerSessions.js';
import type { SessionRegistry } from './sessionState.js';
import { slugifySpaceName, truncatePreview } from './workManagement/spaceNames.js';
import { enforceManagedSessionLimit } from './workManagement/managedSessionLimit.js';
import { buildManagedSpaceMetadata } from '../../runtime/hosting/managedSpaceMetadata.js';

const INITIAL_KICKOFF_PREVIEW_LIMIT = 700;

interface RuntimeWorkManagementServiceDeps {
  config: AppliedMoorlineConfig;
  getTransport(): RuntimeTransport;
  getGuard(): RuntimeActionGuard;
  requireNamespaceState(): RuntimeSurfaceState;
  sessionRegistry: SessionRegistry;
  missionRegistry: MissionRegistry;
  snapshots: RuntimeSnapshotQuery;
  reactor: CommandReactor;
  providerService: RuntimeProvider;
  providerDirectory: ProviderSessionDirectory;
  getProviderAutoStartDefault(): boolean;
  defaultSessionOwner(requestedByThreadId: string): SessionOwnerLink;
  queue<T>(key: string, work: () => Promise<T>): Promise<T>;
  now(): string;
  postTransportMessage(actorId: string, spaceId: string, payload: RuntimeMessagePayload): Promise<void>;
  sendStatusUpdate(payload: RuntimeMessagePayload): Promise<void>;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  runOrchestrationTurn(session: RuntimeSessionRow, actorId: string, content: string): Promise<RuntimeMessagePayload>;
  rejectTurnWaitersForThread(threadId: string, reason: string): void;
  cleanupScopedSidecars(scopeKind: SidecarScopeKind, scopeKey: string, reason: string): Promise<void>;
}

export class RuntimeWorkManagementService {
  constructor(private readonly deps: RuntimeWorkManagementServiceDeps) {}

  resolveMission(input: { spaceId: string; missionId?: string }): RuntimeMissionRow | null {
    return (input.missionId ? this.deps.missionRegistry.getById(input.missionId) : null) ?? this.deps.missionRegistry.getBySpaceId(input.spaceId);
  }

  async createManagedSession(input: {
    actorId: string;
    requestedName: string;
    runtimeMode: RuntimeModeName;
    initialInstruction?: string;
    objective?: string;
    owner?: SessionOwnerLink;
    tags?: string[];
  }): Promise<{ session: RuntimeSessionRow; spaceId: string }> {
    const namespace = this.deps.requireNamespaceState();
    const owner = input.owner ?? this.deps.defaultSessionOwner(input.actorId);
    const ownerMission = owner.kind === 'mission' ? this.deps.missionRegistry.getByThreadId(owner.id) : null;
    const objective = input.objective ?? ownerMission?.goal ?? null;
    enforceManagedSessionLimit(this.deps.snapshots, owner);
    const spaceName = slugifySpaceName('session', input.requestedName);
    await this.deps.getGuard().run({
      action: 'session.create',
      actor: input.actorId,
      target: `${this.deps.config.transport.scopeId}:${spaceName}`,
      payload: {
        runtimeMode: input.runtimeMode,
        owner,
        objective,
        tags: input.tags ?? []
      },
      execute: async () => undefined
    });
    const space = await this.deps.getGuard().run({
      action: 'transport.space.create',
      actor: input.actorId,
      target: `${this.deps.config.transport.scopeId}:${spaceName}`,
      execute: async () => await this.createRuntimeSpace(spaceName, namespace.sessionsCategoryId)
    });
    let session: RuntimeSessionRow;
    try {
      session = this.deps.reactor.createSession({
        scopeId: this.deps.config.transport.scopeId,
        spaceId: space.id,
        spaceName: space.name,
        requestedName: input.requestedName,
        runtimeMode: input.runtimeMode,
        nowIso: this.deps.now(),
        providerAutoStartEnabled: this.deps.getProviderAutoStartDefault(),
        owner,
        objective: objective ?? undefined,
        tags: input.tags,
        createdBy: input.actorId
      });
    } catch (error) {
      // Resource lifecycle adoption can race with explicit managed session creation.
      // If adoption already persisted the session for this new space, reuse it.
      const adopted = this.deps.sessionRegistry.getBySpaceId(space.id);
      if (adopted) {
        session = adopted;
      } else {
        await this.deleteRuntimeSpace(space.id, 'best-effort');
        throw error;
      }
    }
    this.deps.appendAuditEvent('session.created', {
      sessionId: session.sessionId,
      spaceId: session.spaceId,
      runtimeMode: session.runtimeMode,
      ownerKind: session.ownerKind,
      ownerId: session.ownerId,
      objective: session.objective,
      tags: session.tags ?? [],
      actorId: input.actorId
    });
    if (session.createdBy === 'runtime:transport/space-lifecycle') {
      this.deps.appendAuditEvent('session.created.race_recovered', {
        sessionId: session.sessionId,
        spaceId: session.spaceId,
        actorId: input.actorId
      });
    }

    if (input.initialInstruction?.trim()) {
      try {
        await this.deps.postTransportMessage(input.actorId, session.spaceId, {
          text: `Queued initial kickoff for ${session.sessionId}.`,
          blocks: [
            {
              kind: 'fields',
              title: 'Initial Kickoff',
              fields: [
                { label: 'Session', value: session.sessionId },
                { label: 'Mode', value: session.runtimeMode, inline: true },
                { label: 'Objective', value: session.objective ?? '(none)', inline: true },
                {
                  label: 'Prompt Preview',
                  value: truncatePreview(input.initialInstruction, INITIAL_KICKOFF_PREVIEW_LIMIT)
                }
              ],
              tone: 'info',
              metadata: {
                createdAt: this.deps.now()
              }
            }
          ]
        });
      } catch (error) {
        this.deps.appendAuditEvent('session.created.notification_failed', {
          sessionId: session.sessionId,
          spaceId: session.spaceId,
          actorId: input.actorId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      this.enqueueInitialManagedSessionKickoff({
        actorId: input.actorId,
        spaceId: session.spaceId,
        sessionId: session.sessionId,
        instruction: input.initialInstruction
      });
    }

    return { session, spaceId: space.id };
  }

  async directManagedSession(input: {
    actorId: string;
    sessionId?: string;
    spaceId?: string;
    instruction: string;
    reason?: string;
  }): Promise<{ session: RuntimeSessionRow; reply: RuntimeMessagePayload }> {
    const session = this.resolveManagedWorkerSession(input);
    if (!session) {
      throw new Error('No matching managed worker session found.');
    }
    if (session.lifecycleStatus === 'archived') {
      throw new Error(`Session ${session.sessionId} is archived.`);
    }
    const instruction = input.instruction.trim();
    if (!instruction) {
      throw new Error('instruction is required');
    }
    await this.deps.getGuard().run({
      action: 'session.direct',
      actor: input.actorId,
      target: session.sessionId,
      payload: { reason: input.reason ?? null },
      execute: async () => undefined
    });
    const prompt = input.reason?.trim()
      ? `Reason: ${input.reason.trim()}\n\nInstruction:\n${instruction}`
      : instruction;
    const reply = await this.deps.runOrchestrationTurn(session, input.actorId, prompt);
    const updatedSession = this.deps.sessionRegistry.markDirected({
      spaceId: session.spaceId,
      directedAt: this.deps.now(),
      directedBy: input.actorId
    }) ?? session;
    this.deps.appendAuditEvent('session.directed', {
      sessionId: session.sessionId,
      spaceId: session.spaceId,
      actorId: input.actorId,
      reason: input.reason ?? null
    });
    await this.deps.postTransportMessage(input.actorId, session.spaceId, reply);
    return {
      session: updatedSession,
      reply
    };
  }

  async archiveManagedSession(input: {
    actorId: string;
    spaceId: string;
    sessionId?: string;
  }): Promise<RuntimeSessionRow | null> {
    const session = this.resolveManagedWorkerSession(input);
    if (!session) {
      return null;
    }
    const namespace = this.deps.requireNamespaceState();
    await this.deps.getGuard().run({
      action: 'session.archive',
      actor: input.actorId,
      target: session.sessionId,
      execute: async () => undefined
    });
    await this.deps.getGuard().run({
      action: 'transport.space.update',
      actor: input.actorId,
      target: session.spaceId,
      execute: async () =>
        this.deps.getTransport().updateSpace?.({
          scopeId: this.deps.config.transport.scopeId,
          spaceId: session.spaceId,
          parentId: namespace.archiveCategoryId
        })
    });
    this.deps.providerService.stopSession(session.threadId);
    this.deps.providerDirectory.delete(session.threadId);
    this.deps.rejectTurnWaitersForThread(session.threadId, `Session ${session.sessionId} was archived.`);
    await this.deps.cleanupScopedSidecars('session', session.sessionId, `session ${session.sessionId} archived`);
    const nowIso = this.deps.now();
    const archived = this.deps.sessionRegistry.updateSession({
      ...session,
      lifecycleStatus: 'archived',
      archivedAt: nowIso,
      providerThreadId: null,
      resumeThreadId: null,
      providerStatus: 'closed',
      activeTurnId: null,
      updatedAt: nowIso
    });
    this.deps.appendAuditEvent('session.archived', {
      sessionId: archived.sessionId,
      spaceId: archived.spaceId,
      actorId: input.actorId
    });
    return archived;
  }

  async deleteManagedSession(input: {
    actorId: string;
    spaceId: string;
    sessionId?: string;
  }): Promise<RuntimeSessionRow | null> {
    const session = this.resolveManagedWorkerSession(input);
    if (!session || session.lifecycleStatus !== 'archived') {
      return null;
    }
    await this.deps.getGuard().run({
      action: 'session.delete',
      actor: input.actorId,
      target: session.sessionId,
      execute: async () => undefined
    });
    await this.deps.getGuard().run({
      action: 'transport.space.delete',
      actor: input.actorId,
      target: session.spaceId,
      execute: async () => await this.deleteRuntimeSpace(session.spaceId, 'strict')
    });
    this.deps.providerService.stopSession(session.threadId);
    this.deps.providerDirectory.delete(session.threadId);
    this.deps.rejectTurnWaitersForThread(session.threadId, `Session ${session.sessionId} was deleted.`);
    await this.deps.cleanupScopedSidecars('session', session.sessionId, `session ${session.sessionId} deleted`);
    const deleted = this.deps.sessionRegistry.deleteArchived(session.spaceId);
    if (deleted) {
      this.deps.appendAuditEvent('session.deleted', {
        sessionId: deleted.sessionId,
        spaceId: deleted.spaceId,
        workspacePath: deleted.workspacePath,
        actorId: input.actorId
      });
    }
    return deleted;
  }

  async createMission(input: {
    actorId: string;
    title: string;
    goal: string;
    schedule: string;
    startTime?: string;
    runtimeMode: RuntimeModeName;
  }): Promise<{ mission: RuntimeMissionRow; spaceId: string }> {
    const namespace = this.deps.requireNamespaceState();
    const spaceName = slugifySpaceName('mission', input.title);
    parseMissionSchedule(input.schedule);
    parseMissionStartTime(input.startTime, this.deps.now());
    await this.deps.getGuard().run({
      action: 'mission.create',
      actor: input.actorId,
      target: `${this.deps.config.transport.scopeId}:${spaceName}`,
      payload: { runtimeMode: input.runtimeMode, schedule: input.schedule, startTime: input.startTime ?? null },
      execute: async () => undefined
    });
    const space = await this.deps.getGuard().run({
      action: 'transport.space.create',
      actor: input.actorId,
      target: `${this.deps.config.transport.scopeId}:${spaceName}`,
      execute: async () => await this.createRuntimeSpace(spaceName, namespace.missionsCategoryId)
    });
    let mission: RuntimeMissionRow;
    try {
      mission = this.deps.missionRegistry.create({
        scopeId: this.deps.config.transport.scopeId,
        spaceId: space.id,
        spaceName: space.name,
        title: input.title,
        goal: input.goal,
        schedule: input.schedule,
        ...(input.startTime ? { startTime: input.startTime } : {}),
        runtimeMode: input.runtimeMode,
        nowIso: this.deps.now()
      });
    } catch (error) {
      await this.deleteRuntimeSpace(space.id, 'best-effort');
      throw error;
    }
    this.deps.appendAuditEvent('mission.created', {
      missionId: mission.missionId,
      spaceId: mission.spaceId,
      runtimeMode: mission.runtimeMode,
      actorId: input.actorId
    });
    return { mission, spaceId: space.id };
  }

  async adoptMissionChannel(input: {
    actorId: string;
    spaceId: string;
    spaceName: string;
  }): Promise<RuntimeMissionRow> {
    await this.deps.getGuard().run({
      action: 'mission.create',
      actor: input.actorId,
      target: `${this.deps.config.transport.scopeId}:${input.spaceName}`,
      execute: async () => undefined
    });
    const mission = this.deps.missionRegistry.createDraft({
      scopeId: this.deps.config.transport.scopeId,
      spaceId: input.spaceId,
      spaceName: input.spaceName,
      title: input.spaceName,
      runtimeMode: this.deps.config.defaults.runtimeMode,
      nowIso: this.deps.now()
    });
    this.deps.appendAuditEvent('mission.adopted_from_transport', {
      missionId: mission.missionId,
      spaceId: mission.spaceId,
      actorId: input.actorId
    });
    return mission;
  }

  async configureDraftMission(input: {
    actorId: string;
    spaceId: string;
    missionId?: string;
    goal: string;
    schedule: string;
    startTime?: string;
    runtimeMode?: RuntimeModeName;
  }): Promise<RuntimeMissionRow> {
    const mission = this.resolveMission({ spaceId: input.spaceId, missionId: input.missionId });
    if (!mission) {
      throw new Error('No matching mission found.');
    }
    if (mission.lifecycleStatus !== 'draft') {
      throw new Error(`Mission ${mission.missionId} is not waiting for initial setup.`);
    }
    const goal = input.goal.trim();
    const schedule = input.schedule.trim();
    if (!goal) {
      throw new Error('goal is required');
    }
    if (!schedule) {
      throw new Error('schedule is required');
    }
    await this.deps.getGuard().run({
      action: 'mission.create',
      actor: input.actorId,
      target: mission.missionId,
      payload: {
        schedule,
        startTime: input.startTime ?? null,
        runtimeMode: input.runtimeMode ?? mission.runtimeMode
      },
      execute: async () => undefined
    });
    const configured = this.deps.missionRegistry.configureDraftMission({
      missionId: mission.missionId,
      goal,
      schedule,
      ...(input.startTime ? { startTime: input.startTime } : {}),
      ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
      nowIso: this.deps.now()
    });
    this.deps.appendAuditEvent('mission.configured', {
      missionId: configured.missionId,
      spaceId: configured.spaceId,
      actorId: input.actorId,
      schedule: configured.scheduleText,
      runtimeMode: configured.runtimeMode
    });
    return configured;
  }

  async archiveMission(input: {
    actorId: string;
    spaceId: string;
    missionId?: string;
  }): Promise<RuntimeMissionRow | null> {
    const mission = this.resolveMission({ spaceId: input.spaceId, missionId: input.missionId });
    if (!mission) {
      return null;
    }
    const currentMission = this.deps.missionRegistry.getById(mission.missionId);
    if (!currentMission) {
      return null;
    }
    if (currentMission.archivedAt) {
      return currentMission;
    }
    const namespace = this.deps.requireNamespaceState();
    await this.deps.getGuard().run({
      action: 'mission.archive',
      actor: input.actorId,
      target: currentMission.missionId,
      execute: async () => undefined
    });
    await this.deps.getGuard().run({
      action: 'transport.space.update',
      actor: input.actorId,
      target: currentMission.spaceId,
      execute: async () =>
        this.deps.getTransport().updateSpace?.({
          scopeId: this.deps.config.transport.scopeId,
          spaceId: currentMission.spaceId,
          parentId: namespace.archiveCategoryId
        })
    });
    this.deps.providerService.stopSession(currentMission.threadId);
    this.deps.providerDirectory.delete(currentMission.threadId);
    this.deps.rejectTurnWaitersForThread(currentMission.threadId, `Mission ${currentMission.missionId} was archived.`);
    const archivedAt = this.deps.now();
    const archived = this.deps.missionRegistry.update({
      ...currentMission,
      lifecycleStatus: 'stopped',
      pausedAt: null,
      nextRunAt: null,
      stoppedAt: currentMission.stoppedAt ?? archivedAt,
      archivedAt,
      updatedAt: archivedAt
    });
    this.deps.appendAuditEvent('mission.archived', {
      missionId: archived.missionId,
      spaceId: archived.spaceId,
      actorId: input.actorId
    });
    return archived;
  }

  async deleteArchivedMission(input: {
    actorId: string;
    spaceId: string;
    missionId?: string;
  }): Promise<RuntimeMissionRow | null> {
    const mission = this.resolveMission({ spaceId: input.spaceId, missionId: input.missionId });
    if (!mission || !mission.archivedAt) {
      return null;
    }
    return await this.deps.queue(`mission:${mission.missionId}`, async () => {
      const currentMission = this.deps.missionRegistry.getById(mission.missionId);
      if (!currentMission || !currentMission.archivedAt) {
        return null;
      }
      await this.deps.getGuard().run({
        action: 'mission.delete',
        actor: input.actorId,
        target: currentMission.missionId,
        execute: async () => undefined
      });
      await this.deps.getGuard().run({
        action: 'transport.space.delete',
        actor: input.actorId,
        target: currentMission.spaceId,
        execute: async () => await this.deleteRuntimeSpace(currentMission.spaceId, 'strict')
      });
      this.deps.providerService.stopSession(currentMission.threadId);
      this.deps.providerDirectory.delete(currentMission.threadId);
      this.deps.rejectTurnWaitersForThread(currentMission.threadId, `Mission ${currentMission.missionId} was deleted.`);
      const deleted = this.deps.missionRegistry.deleteArchived(currentMission.spaceId);
      if (deleted) {
        this.deps.appendAuditEvent('mission.deleted', {
          missionId: deleted.missionId,
          spaceId: deleted.spaceId,
          workspacePath: deleted.workspacePath,
          actorId: input.actorId
        });
      }
      return deleted;
    });
  }

  async archiveChannelTarget(input: { actorId: string; spaceId: string }): Promise<ArchivedSpaceTarget | null> {
    const target = this.resolveArchivableChannelTarget(input.spaceId);
    if (!target) {
      return null;
    }
    if (target.kind === 'session') {
      const session = await this.archiveManagedSession({
        actorId: input.actorId,
        spaceId: target.session.spaceId,
        sessionId: target.session.sessionId
      });
      return session ? { kind: 'session', session } : null;
    }
    const mission = await this.archiveMission({
      actorId: input.actorId,
      spaceId: target.mission.spaceId,
      missionId: target.mission.missionId
    });
    return mission ? { kind: 'mission', mission } : null;
  }

  async deleteArchivedChannelTarget(input: { actorId: string; spaceId: string }): Promise<ArchivedSpaceTarget | null> {
    const target = this.resolveArchivableChannelTarget(input.spaceId);
    if (!target) {
      return null;
    }
    if (target.kind === 'session') {
      const session = await this.deleteManagedSession({
        actorId: input.actorId,
        spaceId: target.session.spaceId,
        sessionId: target.session.sessionId
      });
      return session ? { kind: 'session', session } : null;
    }
    const mission = await this.deleteArchivedMission({
      actorId: input.actorId,
      spaceId: target.mission.spaceId,
      missionId: target.mission.missionId
    });
    return mission ? { kind: 'mission', mission } : null;
  }

  async updateMissionLifecycle(
    actorId: string,
    input: { spaceId: string; missionId?: string },
    action: 'pause' | 'resume' | 'stop'
  ): Promise<RuntimeMissionRow | null> {
    const mission = this.resolveMission(input);
    if (!mission) {
      return null;
    }
    await this.deps.getGuard().run({
      action: 'mission.control',
      actor: actorId,
      target: mission.missionId,
      execute: async () => undefined
    });
    const nowIso = this.deps.now();
    if (mission.lifecycleStatus === 'draft') {
      throw new Error(`Mission ${mission.missionId} still needs goal and schedule setup before lifecycle controls are available.`);
    }
    if (action === 'pause') {
      if (mission.archivedAt) {
        throw new Error(`Mission ${mission.missionId} is archived and cannot be paused.`);
      }
      if (mission.lifecycleStatus === 'active' || mission.lifecycleStatus === 'waiting_on_user') {
        throw new Error(`Mission ${mission.missionId} is busy. Stop it before pausing.`);
      }
      return this.deps.missionRegistry.update({
        ...mission,
        pausedAt: nowIso,
        lifecycleStatus: 'sleeping',
        updatedAt: nowIso
      });
    }
    if (mission.archivedAt) {
      throw new Error(`Mission ${mission.missionId} is archived and cannot be resumed.`);
    }
    if (action === 'resume') {
      if (mission.lifecycleStatus === 'stopped' && mission.stoppedAt) {
        throw new Error(`Mission ${mission.missionId} is stopped and cannot be resumed.`);
      }
      const resumedNextRunAt = this.deps.missionRegistry.runAtOrAfter(mission, nowIso);
      const resumedOneShotComplete = this.deps.missionRegistry.isOneShotSchedule(mission) && !resumedNextRunAt;
      return this.deps.missionRegistry.update({
        ...mission,
        pausedAt: null,
        lifecycleStatus: resumedOneShotComplete ? 'completed' : 'sleeping',
        nextRunAt: resumedNextRunAt,
        completedAt: resumedOneShotComplete ? nowIso : mission.completedAt,
        updatedAt: nowIso
      });
    }
    this.deps.providerService.stopSession(mission.threadId);
    return this.deps.missionRegistry.update({
      ...mission,
      pausedAt: null,
      lifecycleStatus: 'stopped',
      stoppedAt: nowIso,
      nextRunAt: null,
      updatedAt: nowIso
    });
  }

  private resolveSession(input: { spaceId?: string; sessionId?: string }): RuntimeSessionRow | null {
    return (
      (input.sessionId ? this.deps.sessionRegistry.list().find((entry) => entry.sessionId === input.sessionId) : null) ??
      (input.spaceId ? this.deps.sessionRegistry.getBySpaceId(input.spaceId) : null)
    );
  }

  private resolveManagedWorkerSession(input: { spaceId?: string; sessionId?: string }): RuntimeSessionRow | null {
    const session = this.resolveSession(input);
    return session && isManagedWorkerSession(session) ? session : null;
  }

  private resolveArchivableChannelTarget(spaceId: string): ArchivedSpaceTarget | null {
    const session = this.resolveManagedWorkerSession({ spaceId });
    if (session) {
      return { kind: 'session', session };
    }
    const mission = this.deps.missionRegistry.getBySpaceId(spaceId);
    if (mission) {
      return { kind: 'mission', mission };
    }
    return null;
  }

  private enqueueInitialManagedSessionKickoff(input: {
    actorId: string;
    spaceId: string;
    sessionId: string;
    instruction: string;
  }): void {
    void this.deps.queue(input.spaceId, async () => {
      try {
        await this.directManagedSession({
          actorId: input.actorId,
          sessionId: input.sessionId,
          instruction: input.instruction,
          reason: 'Initial kickoff'
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const session = this.deps.sessionRegistry.list().find((entry) => entry.sessionId === input.sessionId) ?? null;
        this.deps.appendAuditEvent('session.kickoff.failed', {
          sessionId: input.sessionId,
          actorId: input.actorId,
          error: message
        });
        if (session) {
          try {
            await this.deps.sendStatusUpdate({
              text: `Initial kickoff failed for ${session.sessionId} in space ${session.spaceId}: ${message}`
            });
          } catch (statusError) {
            this.deps.appendAuditEvent('session.kickoff.status_update.failed', {
              sessionId: input.sessionId,
              actorId: input.actorId,
              kickoffError: message,
              statusUpdateError: statusError instanceof Error ? statusError.message : String(statusError)
            });
          }
        }
      }
    });
  }

  private async createRuntimeSpace(name: string, parentId: string | null): Promise<RuntimeSpaceRecord> {
    const transport = this.deps.getTransport();
    if (!transport.capabilities().spaces.create || !transport.createSpace) {
      throw new Error(
        'Managed space creation requires transport support for spaces.create. Configure a transport with managed space creation or disable managed sessions/missions.'
      );
    }
    return await transport.createSpace({
      scopeId: this.deps.config.transport.scopeId,
      name,
      kind: 'room',
      metadata: buildManagedSpaceMetadata({
        scopeId: this.deps.config.transport.scopeId,
        applicationId: this.deps.config.transport.applicationId
      }),
      parentId
    });
  }

  private async deleteRuntimeSpace(spaceId: string, mode: 'strict' | 'best-effort'): Promise<void> {
    const transport = this.deps.getTransport();
    if (!transport.capabilities().spaces.delete || !transport.deleteSpace) {
      return;
    }
    try {
      await transport.deleteSpace({
        scopeId: this.deps.config.transport.scopeId,
        spaceId: spaceId
      });
    } catch (error) {
      if (mode === 'best-effort') {
        // Best-effort cleanup after partial creation failures.
        return;
      }
      throw error;
    }
  }
}
