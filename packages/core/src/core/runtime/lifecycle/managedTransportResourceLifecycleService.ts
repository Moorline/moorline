import { randomUUID } from 'node:crypto';
import type { AppliedMoorlineConfig, RuntimeSurfaceState } from '../../../types/config.js';
import type { RuntimeActivityRecord } from '../../system/projection/runtimeActivityStore.js';
import type { RuntimeProvider } from '../../../types/provider.js';
import type { RuntimeMessagePayload, RuntimeTransportEvent } from '../../../types/transport.js';
import type { RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';
import type { ProviderSessionDirectory } from '../execution/providerSessionDirectory.js';
import type { SidecarScopeKind } from '../supervision/managedSidecar.js';
import type { SessionRegistry } from '../../domain/sessions/sessionState.js';
import type { RuntimeWorkManagementService } from '../../domain/sessions/runtimeWorkManagementService.js';

interface ManagedTransportResourceLifecycleServiceDeps {
  config: AppliedMoorlineConfig;
  getSurfaceState(): RuntimeSurfaceState | null;
  sessionRegistry: SessionRegistry;
  providerService: RuntimeProvider;
  providerDirectory: ProviderSessionDirectory;
  workManagement: RuntimeWorkManagementService;
  getProviderAutoStartDefault(): boolean;
  queue<T>(key: string, work: () => Promise<T>): Promise<T>;
  now(): string;
  postTransportMessage(actor: string, transportResourceId: string, payload: RuntimeMessagePayload): Promise<void>;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  recordRuntimeActivity(input: Omit<RuntimeActivityRecord, 'activityId'>): void;
  rejectTurnWaitersForThread(threadId: string, reason: string): void;
  cleanupScopedSidecars(scopeKind: SidecarScopeKind, scopeKey: string, reason: string): Promise<void>;
}

function sameName(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

type ResourceLifecycleEvent = Extract<RuntimeTransportEvent, { type: 'resource.lifecycle' }>;

export class ManagedTransportResourceLifecycleService {
  constructor(private readonly deps: ManagedTransportResourceLifecycleServiceDeps) {}

  async handleEvent(event: RuntimeTransportEvent): Promise<void> {
    if (event.type !== 'resource.lifecycle') {
      return;
    }

    const surface = this.deps.getSurfaceState();
    if (!surface || event.scopeId !== this.deps.config.transport.scopeId) {
      return;
    }

    if (event.resource.kind !== 'conversation' && event.resource.kind !== 'item') {
      this.recordTransportActivity({
        threadId: null,
        sessionId: null,
        transportResourceId: event.resource.id,
        kind: `transport.resource.${event.action}`,
        title: 'Transport lifecycle observed',
        detail: `Observed ${event.resource.kind} ${event.resource.name}.`
      });
      return;
    }

    await this.deps.queue(`transport:lifecycle:${event.resource.id}`, async () => {
      const session = this.deps.sessionRegistry.getByTransportResourceId(event.resource.id);
      if (session) {
        await this.handleSessionEvent(session, event, surface);
        return;
      }

      if ((event.action === 'created' || event.action === 'updated') && event.resource.parentId === surface.sessionsCategoryId) {
        await this.adoptSessionResource(event.resource.id, event.resource.name);
        return;
      }
    });
  }

  private async handleSessionEvent(
    session: RuntimeSessionRow,
    event: ResourceLifecycleEvent,
    surface: RuntimeSurfaceState
  ): Promise<void> {
    if (event.action === 'deleted') {
      await this.preserveDeletedSession(session);
      return;
    }

    if (!sameName(session.transportResourceName, event.resource.name)) {
      const updated = this.deps.sessionRegistry.updateSession({
        ...session,
        transportResourceName: event.resource.name,
        updatedAt: this.deps.now()
      });
      this.deps.appendAuditEvent('session.resource.renamed', {
        sessionId: updated.sessionId,
        transportResourceId: updated.transportResourceId,
        previousName: session.transportResourceName,
        nextName: updated.transportResourceName,
        actorId: 'runtime:transport/resource-lifecycle'
      });
      this.recordTransportActivity({
        threadId: updated.threadId,
        sessionId: updated.sessionId,
        transportResourceId: updated.transportResourceId,
        kind: 'transport.session_resource.renamed',
        title: 'Session resource renamed from transport',
        detail: `${session.transportResourceName} -> ${updated.transportResourceName}`
      });
      session = updated;
    }

    if (event.resource.parentId === surface.archiveCategoryId && session.lifecycleStatus !== 'archived') {
      await this.deps.workManagement.archiveManagedSession({
        actorId: 'runtime:transport/resource-lifecycle',
        transportResourceId: session.transportResourceId,
        sessionId: session.sessionId
      });
      this.recordTransportActivity({
        threadId: session.threadId,
        sessionId: session.sessionId,
        transportResourceId: session.transportResourceId,
        kind: 'transport.session_resource.archived',
        title: 'Session archived from transport move',
        detail: `${session.transportResourceName} moved into the managed archive group.`
      });
    }
  }

  private async adoptSessionResource(transportResourceId: string, transportResourceName: string): Promise<void> {
    if (this.deps.sessionRegistry.getByTransportResourceId(transportResourceId)) {
      return;
    }

    const session = this.deps.sessionRegistry.create({
      scopeId: this.deps.config.transport.scopeId,
      transportResourceId,
      transportResourceName,
      requestedName: transportResourceName,
      runtimeMode: this.deps.config.defaults.runtimeMode,
      nowIso: this.deps.now(),
      providerAutoStartEnabled: this.deps.getProviderAutoStartDefault(),
      createdBy: 'runtime:transport/resource-lifecycle'
    });
    this.deps.appendAuditEvent('session.adopted_from_transport', {
      sessionId: session.sessionId,
      transportResourceId: session.transportResourceId,
      actorId: 'runtime:transport/resource-lifecycle'
    });
    this.recordTransportActivity({
      threadId: session.threadId,
      sessionId: session.sessionId,
      transportResourceId: session.transportResourceId,
      kind: 'transport.session_resource.adopted',
      title: 'Session adopted from transport',
      detail: `Adopted ${transportResourceName} as managed session ${session.sessionId}.`
    });
  }

  private async preserveDeletedSession(session: RuntimeSessionRow): Promise<void> {
    const nowIso = this.deps.now();
    this.deps.providerService.stopSession(session.threadId);
    this.deps.providerDirectory.delete(session.threadId);
    this.deps.rejectTurnWaitersForThread(session.threadId, `Session ${session.sessionId} lost its transport resource.`);
    await this.deps.cleanupScopedSidecars('session', session.sessionId, `session ${session.sessionId} lost its transport resource`);
    const updated = this.deps.sessionRegistry.updateSession({
      ...session,
      lifecycleStatus: 'archived',
      archivedAt: session.archivedAt ?? nowIso,
      providerThreadId: null,
      resumeThreadId: null,
      providerStatus: 'closed',
      activeTurnId: null,
      lastError: 'Managed transport resource deleted outside Moorline.',
      updatedAt: nowIso
    });
    this.deps.appendAuditEvent('session.resource.deleted_externally', {
      sessionId: updated.sessionId,
      transportResourceId: updated.transportResourceId,
      actorId: 'runtime:transport/resource-lifecycle'
    });
    this.recordTransportActivity({
      threadId: updated.threadId,
      sessionId: updated.sessionId,
      transportResourceId: updated.transportResourceId,
      kind: 'transport.session_resource.deleted',
      title: 'Session resource deleted externally',
      detail: `Preserved session ${updated.sessionId} after its managed transport resource was deleted.`
    });
  }

  private recordTransportActivity(input: {
    threadId: string | null;
    sessionId: string | null;
    transportResourceId: string | null;
    kind: string;
    title: string;
    detail: string;
  }): void {
    this.deps.recordRuntimeActivity({
      threadId: input.threadId ?? `transport:${input.transportResourceId ?? 'unknown'}`,
      sessionId: input.sessionId,
      transportResourceId: input.transportResourceId,
      sourceEventId: randomUUID(),
      kind: input.kind,
      severity: 'info',
      title: input.title,
      detail: input.detail,
      createdAt: this.deps.now()
    });
  }
}
