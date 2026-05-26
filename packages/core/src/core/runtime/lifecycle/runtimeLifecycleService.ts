import { randomUUID } from 'node:crypto';
import { buildLifecycleNotification } from '../../domain/sessions/lifecycleOrchestration.js';
import type { SessionLifecycleService } from '../../domain/sessions/sessionLifecycleService.js';
import type { RuntimeMessagePayload, RuntimeTransport } from '../../../types/transport.js';
import type { RuntimeMissionRow, RuntimeMissionRunRow, RuntimeSessionRow, SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import type { MissionRegistry } from '../../domain/missions/missionRegistry.js';
import type { SessionRegistry } from '../../domain/sessions/sessionState.js';
import type { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type { ProviderOrchestrator } from '../execution/providerOrchestration/providerOrchestrator.js';
import type { RuntimeSurfaceState } from '../../../types/config.js';
import type { SidecarScopeKind } from '../supervision/managedSidecar.js';

interface RuntimeLifecycleServiceDeps {
  store: SqliteSessionStore;
  transport: RuntimeTransport;
  transportScopeId: string;
  providerPackageId: string;
  sessionLifecycle: SessionLifecycleService;
  sessionRegistry: SessionRegistry;
  missionRegistry: MissionRegistry;
  providerOrchestrator: ProviderOrchestrator;
  requireGuard(): RuntimeActionGuard;
  getNamespaceState(): RuntimeSurfaceState | null;
  queue<T>(key: string, work: () => Promise<T>): Promise<T>;
  now(): string;
  postTransportMessage(actor: string, spaceId: string, payload: RuntimeMessagePayload): Promise<void>;
  sendStatusUpdate(payload: RuntimeMessagePayload): Promise<void>;
  normalizeReply(text: string): string;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  reportLifecycleFailure(error: unknown): void;
  cleanupScopedSidecars(scopeKind: SidecarScopeKind, scopeKey: string, reason: string): Promise<void>;
  runMaintenance?(): Promise<void>;
}

function lifecycleStatusLabel(status: RuntimeSessionRow['lifecycleStatus']): string {
  switch (status) {
    case 'hot':
      return 'Active';
    case 'cool':
      return 'Cooling';
    case 'archived':
      return 'Archived';
  }
}

export class RuntimeLifecycleService {
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(private readonly deps: RuntimeLifecycleServiceDeps) {}

  start(): void {
    this.stop();
    const tick = () => {
      void this.tick().catch((error: unknown) => {
        this.deps.reportLifecycleFailure(error);
      });
    };
    tick();
    this.timer = setInterval(tick, 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  missionAsSession(mission: RuntimeMissionRow): RuntimeSessionRow {
    return {
      sessionId: `mission-${mission.missionId}`,
      scopeId: mission.scopeId,
      spaceId: mission.spaceId,
      threadId: mission.threadId,
      spaceName: mission.spaceName,
      workspacePath: mission.workspacePath,
      runtimeMode: mission.runtimeMode,
      lifecycleStatus: 'hot',
      summary: mission.goal,
      provider: this.deps.providerPackageId,
      providerThreadId: null,
      resumeThreadId: null,
      providerStatus: mission.lifecycleStatus === 'failed' ? 'error' : 'ready',
      providerAutoStartEnabled: true,
      activeTurnId: this.deps.missionRegistry.getActiveRun(mission.missionId)?.runId ?? null,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
      lastActivityAt: mission.lastRunAt ?? mission.createdAt,
      archivedAt: null,
      lastError: mission.lastError
    };
  }

  async runMissionTurn(
    missionId: string,
    trigger: RuntimeMissionRunRow['trigger'],
    actorId: string,
    requesterUserId: string | null = null
  ): Promise<void> {
    await this.deps.queue(`mission:${missionId}`, async () => {
      const mission = this.deps.missionRegistry.getById(missionId);
      if (
        !mission ||
        mission.archivedAt ||
        mission.pausedAt ||
        mission.lifecycleStatus === 'draft' ||
        mission.lifecycleStatus === 'stopped' ||
        mission.lifecycleStatus === 'completed'
      ) {
        return;
      }
      if (this.deps.missionRegistry.getActiveRun(missionId)) {
        return;
      }

      const preservedNextRunAt = trigger === 'schedule' ? null : mission.nextRunAt;
      const nowIso = this.deps.now();
      const runId = randomUUID();
      this.deps.store.upsertMissionRun({
        runId,
        missionId,
        trigger,
        lifecycleStatus: 'running',
        summary: null,
        errorMessage: null,
        startedAt: nowIso,
        finishedAt: null
      });
      this.deps.missionRegistry.update({
        ...mission,
        lifecycleStatus: 'active',
        lastRunAt: nowIso,
        nextRunAt: trigger === 'schedule' ? null : mission.nextRunAt,
        updatedAt: nowIso,
        lastError: null
      });

      try {
        const prompt = [
          'You are executing a long-lived Moorline mission.',
          `Mission ID: ${mission.missionId}`,
          `Title: ${mission.title}`,
          `Goal: ${mission.goal}`,
          `Schedule: ${mission.scheduleText}`,
          `Workspace: ${mission.workspacePath}`,
          `Trigger: ${trigger}`,
          '',
          'Do one bounded execution pass toward the goal.',
          'If there is nothing useful to do, say so briefly.',
          'Be concise and include concrete next steps for the next scheduled run when relevant.'
        ].join('\n');
        const result = await this.deps.providerOrchestrator.runTurn({
          actorId,
          session: this.missionAsSession(mission),
          spaceId: mission.spaceId,
          surface: 'mission',
          promptContent: prompt,
          authorId: requesterUserId ?? actorId,
          providerInput: { text: prompt }
        });
        const formatted = this.deps.normalizeReply(
          result.text || (result.attachments?.length ? '' : 'Mission completed without a textual result.')
        );
        const completedAt = this.deps.now();
        this.deps.store.upsertMissionRun({
          runId,
          missionId,
          trigger,
          lifecycleStatus: 'completed',
          summary: formatted,
          errorMessage: null,
          startedAt: nowIso,
          finishedAt: completedAt
        });
        const latestMission = this.deps.missionRegistry.getById(missionId);
        if (!latestMission || latestMission.archivedAt) {
          return;
        }
        const nextRunAt =
          trigger === 'schedule'
            ? this.deps.missionRegistry.nextRunAt(mission, completedAt)
            : this.resolveManualNextRunAt(mission, preservedNextRunAt, completedAt);
        const oneShotCompleted = trigger === 'schedule' && this.deps.missionRegistry.isOneShotSchedule(mission) && !nextRunAt;
        this.deps.missionRegistry.update({
          ...latestMission,
          lifecycleStatus: oneShotCompleted ? 'completed' : 'sleeping',
          pausedAt: null,
          nextRunAt,
          lastSuccessAt: completedAt,
          completedAt: oneShotCompleted ? completedAt : latestMission.completedAt,
          updatedAt: completedAt,
          lastError: null
        });
        try {
          await this.deps.postTransportMessage(actorId, mission.spaceId, {
            text: formatted,
            blocks: [
              {
                kind: 'fields',
                title: 'Mission Run Complete',
                fields: [
                  { label: 'Mission', value: mission.title },
                  { label: 'Trigger', value: trigger, inline: true },
                  { label: 'Next Run', value: nextRunAt ?? 'unscheduled', inline: true }
                ],
                tone: 'success',
                metadata: { completedAt }
              }
            ]
          });
        } catch (notificationError) {
          this.deps.appendAuditEvent('mission.run.notification_failed', {
            missionId,
            runId,
            trigger,
            spaceId: mission.spaceId,
            actorId,
            error: notificationError instanceof Error ? notificationError.message : String(notificationError),
            occurredAt: this.deps.now()
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedAt = this.deps.now();
        const nextRetryAt =
          trigger === 'schedule'
            ? this.deps.missionRegistry.nextRunAt(mission, failedAt)
            : this.resolveManualNextRunAt(mission, preservedNextRunAt, failedAt);
        this.deps.store.upsertMissionRun({
          runId,
          missionId,
          trigger,
          lifecycleStatus: 'failed',
          summary: null,
          errorMessage: message,
          startedAt: nowIso,
          finishedAt: failedAt
        });
        const latestMission = this.deps.missionRegistry.getById(missionId);
        if (!latestMission || latestMission.archivedAt) {
          return;
        }
        this.deps.missionRegistry.update({
          ...latestMission,
          lifecycleStatus: 'failed',
          nextRunAt: nextRetryAt,
          updatedAt: failedAt,
          lastError: message
        });
        try {
          await this.deps.postTransportMessage(actorId, mission.spaceId, {
            text: `Mission run failed: ${message}`,
            blocks: [
              {
                kind: 'fields',
                title: 'Mission Run Failed',
                fields: [
                  { label: 'Mission', value: mission.title },
                  { label: 'Trigger', value: trigger, inline: true },
                  { label: 'Next Retry', value: nextRetryAt ?? 'unscheduled', inline: true },
                  { label: 'Detail', value: message.slice(0, 1024) }
                ],
                tone: 'danger',
                metadata: { failedAt }
              }
            ]
          });
        } catch (notificationError) {
          this.deps.appendAuditEvent('mission.run.failure_notification_failed', {
            missionId,
            runId,
            trigger,
            spaceId: mission.spaceId,
            actorId,
            originalError: message,
            error: notificationError instanceof Error ? notificationError.message : String(notificationError),
            occurredAt: this.deps.now()
          });
        }
      }
    });
  }

  private resolveManualNextRunAt(mission: RuntimeMissionRow, preservedNextRunAt: string | null, anchorIso: string): string | null {
    const preservedMs = preservedNextRunAt ? Date.parse(preservedNextRunAt) : Number.NaN;
    const anchorMs = Date.parse(anchorIso);
    if (Number.isFinite(preservedMs) && Number.isFinite(anchorMs) && preservedMs > anchorMs) {
      return preservedNextRunAt;
    }
    return this.deps.missionRegistry.runAtOrAfter(mission, anchorIso);
  }

  private async tick(): Promise<void> {
    if (this.deps.runMaintenance) {
      await this.deps.runMaintenance();
    }
    const nowIso = this.deps.now();
    const transitions = this.deps.sessionLifecycle.sweep(this.deps.now());
    for (const transition of transitions) {
      const session = this.deps.sessionRegistry.getByThreadId(transition.threadId);
      if (!session) {
        continue;
      }

      if (transition.to === 'archived') {
        await this.archiveTransitionSession(session, transition);
        continue;
      }

      await this.deps.sendStatusUpdate(
        buildLifecycleNotification({
          state: transition.to,
          sessionId: transition.sessionId,
          detail: `${session.spaceName} moved to ${lifecycleStatusLabel(transition.to)}.`,
          nowIso: transition.at
        })
      );
    }

    for (const mission of this.deps.missionRegistry.list()) {
      if (
        mission.archivedAt ||
        mission.pausedAt ||
        mission.lifecycleStatus === 'draft' ||
        mission.lifecycleStatus === 'stopped' ||
        mission.lifecycleStatus === 'completed' ||
        mission.lifecycleStatus === 'active' ||
        mission.lifecycleStatus === 'waiting_on_user' ||
        !mission.nextRunAt ||
        Date.parse(mission.nextRunAt) > Date.parse(nowIso)
      ) {
        continue;
      }
      await this.runMissionTurn(mission.missionId, 'schedule', 'runtime:mission/scheduler');
    }
  }

  private async archiveTransitionSession(
    session: RuntimeSessionRow,
    transition: {
      sessionId: string;
      threadId: string;
      spaceId: string;
      from: RuntimeSessionRow['lifecycleStatus'];
      to: RuntimeSessionRow['lifecycleStatus'];
      at: string;
    }
  ): Promise<void> {
    const current = this.deps.sessionRegistry.getByThreadId(session.threadId);
    if (!current || current.lifecycleStatus === 'archived') {
      return;
    }

    const namespace = this.deps.getNamespaceState();
    if (namespace) {
      await this.deps.requireGuard().run({
        action: 'transport.space.update',
        actor: 'runtime:lifecycle/archive',
        target: current.spaceId,
        execute: async () =>
          this.deps.transport.updateSpace?.({
            scopeId: this.deps.transportScopeId,
            spaceId: current.spaceId,
            parentId: namespace.archiveCategoryId
          })
      });
    }

    this.deps.providerOrchestrator.teardownThread(
      current.threadId,
      `Session ${current.sessionId} was archived by lifecycle sweep.`
    );
    await this.deps.cleanupScopedSidecars('session', current.sessionId, `session ${current.sessionId} archived by lifecycle sweep`);
    const nowIso = this.deps.now();
    this.deps.sessionRegistry.updateSession({
      ...current,
      lifecycleStatus: 'archived',
      archivedAt: nowIso,
      providerThreadId: null,
      resumeThreadId: null,
      providerStatus: 'closed',
      activeTurnId: null,
      updatedAt: nowIso
    });

    await this.deps.sendStatusUpdate(
      buildLifecycleNotification({
        state: transition.to,
        sessionId: transition.sessionId,
        detail: `${current.spaceName} moved to ${lifecycleStatusLabel(transition.to)}.`,
        nowIso: nowIso
      })
    );
  }
}
