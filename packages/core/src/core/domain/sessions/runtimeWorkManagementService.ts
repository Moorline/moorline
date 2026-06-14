import type { AppliedMoorlineConfig, RuntimeSurfaceState } from '../../../types/config.js';
import type { CommandReactor } from '../../runtime/execution/commandReactor.js';
import type { RuntimeSnapshotQuery } from '../../system/projection/runtimeSnapshotQuery.js';
import { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type { RuntimeProvider } from '../../../types/provider.js';
import type { SessionOwnerLink, ArchivedTransportResourceTarget } from '../../../types/plugin.js';
import type { ProviderSessionDirectory } from '../../runtime/execution/providerSessionDirectory.js';
import type { RuntimeModeName } from '../../../types/runtime.js';
import type { SidecarScopeKind } from '../../runtime/supervision/managedSidecar.js';
import type { RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';
import type { RuntimeMessagePayload, RuntimeTransportResourceRecord, RuntimeTransport } from '../../../types/transport.js';
import { isManagedWorkerSession } from './managedWorkerSessions.js';
import type { SessionRegistry } from './sessionState.js';
import { slugifyResourceName, truncatePreview } from './workManagement/transportResourceNames.js';
import { enforceManagedSessionLimit } from './workManagement/managedSessionLimit.js';
import { buildManagedTransportResourceMetadata } from '../../runtime/hosting/managedTransportResourceMetadata.js';
import { MoorlineStatusError } from '../../shared/errors/statusError.js';

const INITIAL_KICKOFF_PREVIEW_LIMIT = 700;

interface RuntimeWorkManagementServiceDeps {
  config: AppliedMoorlineConfig;
  getTransport(): RuntimeTransport;
  getGuard(): RuntimeActionGuard;
  requireSurfaceState(): RuntimeSurfaceState;
  sessionRegistry: SessionRegistry;
  snapshots: RuntimeSnapshotQuery;
  reactor: CommandReactor;
  providerService: RuntimeProvider;
  providerDirectory: ProviderSessionDirectory;
  getProviderAutoStartDefault(): boolean;
  defaultSessionOwner(requestedByThreadId: string): SessionOwnerLink;
  queue<T>(key: string, work: () => Promise<T>): Promise<T>;
  now(): string;
  postTransportMessage(actorId: string, transportResourceId: string, payload: RuntimeMessagePayload): Promise<void>;
  sendStatusUpdate(payload: RuntimeMessagePayload): Promise<void>;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  runOrchestrationTurn(session: RuntimeSessionRow, actorId: string, content: string): Promise<RuntimeMessagePayload>;
  rejectTurnWaitersForThread(threadId: string, reason: string): void;
  cleanupScopedSidecars(scopeKind: SidecarScopeKind, scopeKey: string, reason: string): Promise<void>;
}

export class RuntimeWorkManagementService {
  constructor(private readonly deps: RuntimeWorkManagementServiceDeps) {}

  async createManagedSession(input: {
    actorId: string;
    requestedName: string;
    runtimeMode: RuntimeModeName;
    initialInstruction?: string;
    objective?: string;
    owner?: SessionOwnerLink;
    tags?: string[];
  }): Promise<{ session: RuntimeSessionRow; transportResourceId: string }> {
    const surface = this.deps.requireSurfaceState();
    const owner = input.owner ?? this.deps.defaultSessionOwner(input.actorId);
    const objective = input.objective ?? null;
    enforceManagedSessionLimit(this.deps.snapshots, owner);
    const transportResourceName = slugifyResourceName('session', input.requestedName);
    await this.deps.getGuard().run({
      action: 'session.create',
      actor: input.actorId,
      target: `${this.deps.config.transport.scopeId}:${transportResourceName}`,
      payload: {
        runtimeMode: input.runtimeMode,
        owner,
        objective,
        tags: input.tags ?? []
      },
      execute: async () => undefined
    });
    const resource = await this.deps.getGuard().run({
      action: 'transport.resource.create',
      actor: input.actorId,
      target: `${this.deps.config.transport.scopeId}:${transportResourceName}`,
      execute: async () => await this.createRuntimeTransportResource(transportResourceName, surface.sessionsCategoryId)
    });
    let session: RuntimeSessionRow;
    let recoveredFromLifecycleRace = false;
    try {
      session = this.deps.reactor.createSession({
        scopeId: this.deps.config.transport.scopeId,
        transportResourceId: resource.id,
        transportResourceName: resource.name,
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
      // If adoption already persisted the session for this new resource, reuse it.
      const adopted = this.deps.sessionRegistry.getByTransportResourceId(resource.id);
      if (adopted) {
        recoveredFromLifecycleRace = adopted.createdBy === 'runtime:transport/resource-lifecycle';
        session = this.deps.sessionRegistry.updateSession({
          ...adopted,
          runtimeMode: input.runtimeMode,
          providerAutoStartEnabled: this.deps.getProviderAutoStartDefault(),
          ownerKind: owner.kind,
          ownerId: owner.id,
          ownerLabel: owner.label,
          objective: objective ?? adopted.objective,
          tags: input.tags ?? adopted.tags ?? [],
          createdBy: input.actorId,
          updatedAt: this.deps.now()
        });
      } else {
        await this.deleteRuntimeTransportResource(resource.id, 'best-effort');
        throw error;
      }
    }
    this.deps.appendAuditEvent('session.created', {
      sessionId: session.sessionId,
      transportResourceId: session.transportResourceId,
      runtimeMode: session.runtimeMode,
      ownerKind: session.ownerKind,
      ownerId: session.ownerId,
      objective: session.objective,
      tags: session.tags ?? [],
      actorId: input.actorId
    });
    if (recoveredFromLifecycleRace) {
      this.deps.appendAuditEvent('session.created.race_recovered', {
        sessionId: session.sessionId,
        transportResourceId: session.transportResourceId,
        actorId: input.actorId
      });
    }

    if (input.initialInstruction?.trim()) {
      try {
        await this.deps.postTransportMessage(input.actorId, session.transportResourceId, {
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
          transportResourceId: session.transportResourceId,
          actorId: input.actorId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      this.enqueueInitialManagedSessionKickoff({
        actorId: input.actorId,
        transportResourceId: session.transportResourceId,
        sessionId: session.sessionId,
        instruction: input.initialInstruction
      });
    }

    return { session, transportResourceId: resource.id };
  }

  async directManagedSession(input: {
    actorId: string;
    sessionId?: string;
    transportResourceId?: string;
    instruction: string;
    reason?: string;
  }): Promise<{ session: RuntimeSessionRow; reply: RuntimeMessagePayload }> {
    const session = this.resolveManagedWorkerSession(input);
    if (!session) {
      throw new MoorlineStatusError(404, 'No matching managed worker session found.');
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
      transportResourceId: session.transportResourceId,
      directedAt: this.deps.now(),
      directedBy: input.actorId
    }) ?? session;
    this.deps.appendAuditEvent('session.directed', {
      sessionId: session.sessionId,
      transportResourceId: session.transportResourceId,
      actorId: input.actorId,
      reason: input.reason ?? null
    });
    await this.deps.postTransportMessage(input.actorId, session.transportResourceId, reply);
    return {
      session: updatedSession,
      reply
    };
  }

  async archiveManagedSession(input: {
    actorId: string;
    transportResourceId?: string;
    sessionId?: string;
  }): Promise<RuntimeSessionRow | null> {
    const session = this.resolveManagedWorkerSession(input);
    if (!session) {
      return null;
    }
    const surface = this.deps.requireSurfaceState();
    await this.deps.getGuard().run({
      action: 'session.archive',
      actor: input.actorId,
      target: session.sessionId,
      execute: async () => undefined
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
    await this.deps.getGuard().run({
      action: 'transport.resource.update',
      actor: input.actorId,
      target: session.transportResourceId,
      execute: async () => {
        try {
          await this.deps.getTransport().updateTransportResource?.({
            scopeId: this.deps.config.transport.scopeId,
            transportResourceId: session.transportResourceId,
            parentId: surface.archiveCategoryId
          });
        } catch (error) {
          this.deps.appendAuditEvent('session.archive.transport_update_failed', {
            sessionId: session.sessionId,
            transportResourceId: session.transportResourceId,
            actorId: input.actorId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });
    this.deps.appendAuditEvent('session.archived', {
      sessionId: archived.sessionId,
      transportResourceId: archived.transportResourceId,
      actorId: input.actorId
    });
    return archived;
  }

  async deleteManagedSession(input: {
    actorId: string;
    transportResourceId?: string;
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
      action: 'transport.resource.delete',
      actor: input.actorId,
      target: session.transportResourceId,
      execute: async () => await this.deleteRuntimeTransportResource(session.transportResourceId, 'best-effort')
    });
    this.deps.providerService.stopSession(session.threadId);
    this.deps.providerDirectory.delete(session.threadId);
    this.deps.rejectTurnWaitersForThread(session.threadId, `Session ${session.sessionId} was deleted.`);
    await this.deps.cleanupScopedSidecars('session', session.sessionId, `session ${session.sessionId} deleted`);
    const deleted = this.deps.sessionRegistry.deleteArchived(session.transportResourceId);
    if (deleted) {
      this.deps.appendAuditEvent('session.deleted', {
        sessionId: deleted.sessionId,
        transportResourceId: deleted.transportResourceId,
        workspacePath: deleted.workspacePath,
        actorId: input.actorId
      });
    }
    return deleted;
  }

  async archiveResourceTarget(input: { actorId: string; transportResourceId: string }): Promise<ArchivedTransportResourceTarget | null> {
    const target = this.resolveArchivableResourceTarget(input.transportResourceId);
    if (!target) {
      return null;
    }
    if (target.kind === 'session') {
      const session = await this.archiveManagedSession({
        actorId: input.actorId,
        transportResourceId: target.session.transportResourceId,
        sessionId: target.session.sessionId
      });
      return session ? { kind: 'session', session } : null;
    }
    return null;
  }

  async deleteArchivedResourceTarget(input: { actorId: string; transportResourceId: string }): Promise<ArchivedTransportResourceTarget | null> {
    const target = this.resolveArchivableResourceTarget(input.transportResourceId);
    if (!target) {
      return null;
    }
    if (target.kind === 'session') {
      const session = await this.deleteManagedSession({
        actorId: input.actorId,
        transportResourceId: target.session.transportResourceId,
        sessionId: target.session.sessionId
      });
      return session ? { kind: 'session', session } : null;
    }
    return null;
  }

  private resolveSession(input: { transportResourceId?: string; sessionId?: string }): RuntimeSessionRow | null {
    return (
      (input.sessionId ? this.deps.sessionRegistry.list().find((entry) => entry.sessionId === input.sessionId) : null) ??
      (input.transportResourceId ? this.deps.sessionRegistry.getByTransportResourceId(input.transportResourceId) : null)
    );
  }

  private resolveManagedWorkerSession(input: { transportResourceId?: string; sessionId?: string }): RuntimeSessionRow | null {
    const session = this.resolveSession(input);
    return session && isManagedWorkerSession(session) ? session : null;
  }

  private resolveArchivableResourceTarget(transportResourceId: string): ArchivedTransportResourceTarget | null {
    const session = this.resolveManagedWorkerSession({ transportResourceId });
    if (session) {
      return { kind: 'session', session };
    }
    return null;
  }

  private enqueueInitialManagedSessionKickoff(input: {
    actorId: string;
    transportResourceId: string;
    sessionId: string;
    instruction: string;
  }): void {
    void this.deps.queue(input.transportResourceId, async () => {
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
              text: `Initial kickoff failed for ${session.sessionId} in transport resource ${session.transportResourceId}: ${message}`
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

  private async createRuntimeTransportResource(name: string, parentId: string | null): Promise<RuntimeTransportResourceRecord> {
    const transport = this.deps.getTransport();
    if (!transport.capabilities().resources.create || !transport.createTransportResource) {
      throw new Error(
        'Managed resource creation requires transport support for resources.create. Configure a transport with managed resource creation or disable managed sessions.'
      );
    }
    return await transport.createTransportResource({
      scopeId: this.deps.config.transport.scopeId,
      name,
      kind: 'conversation',
      metadata: buildManagedTransportResourceMetadata({
        scopeId: this.deps.config.transport.scopeId,
        ...(typeof this.deps.config.transport.config.applicationId === 'string'
          ? { ownerApplicationId: this.deps.config.transport.config.applicationId }
          : {})
      }),
      parentId
    });
  }

  private async deleteRuntimeTransportResource(transportResourceId: string, mode: 'strict' | 'best-effort'): Promise<void> {
    const transport = this.deps.getTransport();
    if (!transport.capabilities().resources.delete || !transport.deleteTransportResource) {
      return;
    }
    try {
      await transport.deleteTransportResource({
        scopeId: this.deps.config.transport.scopeId,
        transportResourceId: transportResourceId
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
