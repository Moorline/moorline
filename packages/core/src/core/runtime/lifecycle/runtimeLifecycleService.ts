import { randomUUID } from 'node:crypto';
import { buildLifecycleNotification } from '../../domain/sessions/lifecycleOrchestration.js';
import type { SessionLifecycleService } from '../../domain/sessions/sessionLifecycleService.js';
import type { RuntimeMessagePayload, RuntimeTransport } from '../../../types/transport.js';
import type { RuntimeSessionRow, SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import type { SessionRegistry } from '../../domain/sessions/sessionState.js';
import type { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type { RuntimeSurfaceState } from '../../../types/config.js';
import type { SidecarScopeKind } from '../supervision/managedSidecar.js';

interface RuntimeLifecycleServiceDeps {
  store: SqliteSessionStore;
  transport: RuntimeTransport;
  transportScopeId: string;
  sessionLifecycle: SessionLifecycleService;
  sessionRegistry: SessionRegistry;
  requireGuard(): RuntimeActionGuard;
  getNamespaceState(): RuntimeSurfaceState | null;
  now(): string;
  sendStatusUpdate(payload: RuntimeMessagePayload): Promise<void>;
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

  private async tick(): Promise<void> {
    if (this.deps.runMaintenance) {
      await this.deps.runMaintenance();
    }
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

    const archived = this.deps.sessionRegistry.updateSession({
      ...current,
      lifecycleStatus: 'archived',
      archivedAt: transition.at,
      updatedAt: transition.at
    });
    await this.deps.cleanupScopedSidecars('session', archived.sessionId, `session ${archived.sessionId} archived by lifecycle`);
    this.deps.appendAuditEvent('session.archived.lifecycle', {
      sessionId: archived.sessionId,
      spaceId: archived.spaceId,
      previousState: transition.from,
      actorId: 'runtime:lifecycle/archive',
      sourceEventId: randomUUID()
    });
  }
}
