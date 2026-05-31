import type { AppliedMoorlineConfig, RuntimeSurfaceState } from '../../../types/config.js';
import type { CommandReactor } from '../../runtime/execution/commandReactor.js';
import type { RuntimeSnapshotQuery } from '../../system/projection/runtimeSnapshotQuery.js';
import { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type { RuntimeProvider } from '../../../types/provider.js';
import type { SessionOwnerLink, ArchivedSpaceTarget } from '../../../types/plugin.js';
import type { ProviderSessionDirectory } from '../../runtime/execution/providerSessionDirectory.js';
import type { RuntimeModeName } from '../../../types/runtime.js';
import type { SidecarScopeKind } from '../../runtime/supervision/managedSidecar.js';
import type { RuntimeSessionRow } from '../../system/state/sqliteSessionStore.js';
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
    const objective = input.objective ?? null;
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
    return null;
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
    return null;
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
        'Managed space creation requires transport support for spaces.create. Configure a transport with managed space creation or disable managed sessions.'
      );
    }
    return await transport.createSpace({
      scopeId: this.deps.config.transport.scopeId,
      name,
      kind: 'room',
      metadata: buildManagedSpaceMetadata({
        scopeId: this.deps.config.transport.scopeId,
        ...(typeof this.deps.config.transport.config.applicationId === 'string'
          ? { ownerApplicationId: this.deps.config.transport.config.applicationId }
          : {})
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
