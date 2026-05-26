import {
  type AdminConfig,
  usesProviderDefaultModel,
  type AppliedMoorlineConfig,
  type RuntimeSurfaceState
} from '../../../types/config.js';
import { saveMoorlineConfig } from '../../system/config/configStore.js';
import type { RuntimeControlStatus } from '../supervision/runtimeControl.js';
import type { MissionRegistry } from '../../domain/missions/missionRegistry.js';
import type { MissionHookService } from '../../domain/missions/missionHookService.js';
import type { RuntimeDomainEvent } from './runtimeDomain.js';
import type { RuntimeActivityStore } from '../../system/projection/runtimeActivityStore.js';
import type { ProjectionStateStore } from '../../system/projection/projectionStateStore.js';
import type { RuntimeSnapshotQuery } from '../../system/projection/runtimeSnapshotQuery.js';
import type { RuntimeProvider } from '../../../types/provider.js';
import type { CanonicalEventLogStore } from '../../system/state/canonicalEventLogStore.js';
import type { RuntimePluginAdminConfig, RuntimePluginContext } from '../../../types/plugin.js';
import type { PluginHost } from '../../extension/plugins/pluginHost.js';
import type { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type { SidecarManager } from '../supervision/sidecarManager.js';
import type { SkillRegistry } from '../../extension/skills/skillRegistry.js';
import type { RuntimeMissionRow, RuntimeSessionRow, SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import type {
  RuntimeAttachmentPayload,
  RuntimeActorIdentity,
  RuntimeMessagePayload
} from '../../../types/transport.js';
import { parseRuntimeModeName } from '../../../types/runtime.js';
import { refreshMemoryIndex, retrieveFromMemoryWithSQLite } from '../../domain/memory/retrieval.js';
import { MemoryStore } from '../../domain/memory/store.js';
import type { RuntimeControlService } from '../supervision/runtimeControlService.js';
import type { RuntimeLifecycleService } from '../lifecycle/runtimeLifecycleService.js';
import type { ProviderOrchestrator } from './providerOrchestration/providerOrchestrator.js';
import type { RuntimeWorkManagementService } from '../../domain/sessions/runtimeWorkManagementService.js';
import type { SessionRegistry } from '../../domain/sessions/sessionState.js';
import { recordHistoryCheckpoint } from '../../system/vcs/gitCheckpointService.js';
import { createPluginContextCapabilities } from './pluginContext/pluginContextFactory.js';
import { describeTransportAuthor } from './pluginContext/transportAuthor.js';
import { toPluginPackageId } from '../../extension/plugins/pluginId.js';
import { normalizeAndValidateDefaultModel } from './defaultModelSelection.js';

export { defaultSessionOwner } from './pluginContext/defaultSessionOwner.js';

interface RuntimePluginContextServiceDeps {
  config: AppliedMoorlineConfig;
  configPath?: string;
  runtimeRoot: string;
  homeRoot: string;
  sqlitePath: string;
  chatWorkspacePath: string;
  store: SqliteSessionStore;
  sessionRegistry: SessionRegistry;
  missionRegistry: MissionRegistry;
  missionHooks: MissionHookService;
  skillRegistry: SkillRegistry;
  memoryStore: MemoryStore;
  activities: RuntimeActivityStore;
  projectionState: ProjectionStateStore;
  snapshots: RuntimeSnapshotQuery;
  providerService: RuntimeProvider;
  canonicalEvents: CanonicalEventLogStore;
  workManagement: RuntimeWorkManagementService;
  lifecycleService: RuntimeLifecycleService;
  runtimeControl: RuntimeControlService;
  sidecars: SidecarManager;
  providerOrchestrator: ProviderOrchestrator;
  getPluginHost(): PluginHost;
  getAdminConfig(): AdminConfig;
  isAdminActor(input: RuntimeActorIdentity): boolean;
  requireNamespaceState(): RuntimeSurfaceState;
  getNamespaceState(): RuntimeSurfaceState | null;
  getRuntimeStatus(): RuntimePluginContext['getRuntimeStatus'] extends () => infer T ? T : never;
  getRuntimeControlStatus(): RuntimeControlStatus;
  ensureChatSession(spaceId: string, cwd: string): Promise<RuntimeSessionRow>;
  prepareProviderImages(threadId: string, attachments: RuntimeAttachmentPayload[] | undefined): Promise<Array<{ localPath: string } | { url: string }> | undefined>;
  normalizeReply(text: string): string;
  postTransportMessage(actor: string, spaceId: string, payload: RuntimeMessagePayload): Promise<void>;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  now(): string;
  runGuardedAction<T>(input: {
    action: Parameters<RuntimeActionGuard['run']>[0]['action'];
    actor: string;
    target?: string;
    payload?: unknown;
    threadId?: string;
    title: string;
    execute: () => Promise<T>;
  }): Promise<T>;
  resolvePendingRequest(input: {
    actorId: string;
    requestId: string;
    decision: 'accept' | 'decline' | 'cancel';
    deniedTitle: string;
    metadata?: Record<string, unknown>;
    requestActor?: RuntimeActorIdentity;
  }): Promise<void>;
  answerPendingRequest(input: {
    actorId: string;
    requestId: string;
    answers: Record<string, string | string[]>;
    requestActor?: RuntimeActorIdentity;
  }): Promise<void>;
  drainRuntimeWork(): Promise<void>;
}

export class RuntimePluginContextService {
  constructor(private readonly deps: RuntimePluginContextServiceDeps) {}

  private getProviderDiagnostics(): ReturnType<RuntimeProvider['getDiagnostics']> {
    const live = this.deps.providerService.getDiagnostics();
    const persisted =
      typeof this.deps.snapshots.overview === 'function'
        ? this.deps.snapshots.overview().providers.at(-1) ?? null
        : null;
    return {
      accountLabel: live.accountLabel ?? persisted?.accountLabel ?? null,
      availableModels: live.availableModels.length > 0 ? live.availableModels : persisted?.availableModels ?? [],
      connectedSessions: live.connectedSessions,
      statusCounts: live.statusCounts,
      capabilityMetadata: {
        ...(persisted?.capabilityMetadata ?? {}),
        ...live.capabilityMetadata
      }
    };
  }

  private pluginAdminConfig(): RuntimePluginAdminConfig {
    const adminConfig = this.deps.getAdminConfig();
    return {
      accessGroupIds: adminConfig.accessGroupIds,
      userIds: adminConfig.userIds,
      allowTransportAdmin: adminConfig.allowTransportAdmin,
      managedAdminAccessGroup: adminConfig.managedRole,
      managedMemberAccessGroup: adminConfig.managedUserRole
    };
  }

  private providerPolicyTarget(threadId: string, suffix: string): string {
    const providerId = this.deps.config.provider.packageId ?? this.deps.config.provider.kind;
    return `provider:${providerId}:${threadId}:${suffix}`;
  }

  createContext(actorId: string): RuntimePluginContext {
    const capabilities = createPluginContextCapabilities({
      actorId,
      homeRoot: this.deps.homeRoot,
      runtimeRoot: this.deps.runtimeRoot,
      skillRegistry: this.deps.skillRegistry,
      getAdminConfig: () => this.pluginAdminConfig(),
      runGuardedAction: async (input) =>
        await this.deps.runGuardedAction({
          action: input.action as Parameters<RuntimeActionGuard['run']>[0]['action'],
          actor: input.actor,
          target: input.target,
          title: input.title,
          execute: async () => await input.execute()
        })
    });
    return {
      actorId,
      config: this.deps.config,
      getAdminConfig: () => capabilities.admin!.getAdminConfig(),
      isAdminActor: (input) => this.deps.isAdminActor(input),
      getNamespaceState: () => this.deps.requireNamespaceState(),
      getCurrentSpaceId: () => this.deps.getNamespaceState()?.chatChannelId ?? this.deps.config.transport.scopeId,
      getCurrentThreadId: () => `chat:${this.deps.getNamespaceState()?.chatChannelId ?? this.deps.config.transport.scopeId}`,
      getCurrentWorkspacePath: () => this.deps.chatWorkspacePath,
      getChatWorkspacePath: () => this.deps.chatWorkspacePath,
      listSkills: () => capabilities.memory.listSkills(),
      loadSkill: async (name) => await capabilities.memory.loadSkill(name),
      writeSkill: async (input) => await capabilities.memory.writeSkill(input),
      listSessions: () => this.deps.snapshots.listSessions().map((entry) => entry.session),
      getSessionBySpaceId: (spaceId) => this.deps.snapshots.getSessionBySpaceId(spaceId)?.session ?? null,
      getSessionById: (sessionId) => this.deps.snapshots.getSessionById(sessionId)?.session ?? null,
      listMissions: () => this.deps.missionRegistry.list(),
      getMissionBySpaceId: (spaceId) => this.deps.missionRegistry.getBySpaceId(spaceId),
      getMissionById: (missionId) => this.deps.missionRegistry.getById(missionId),
      listMissionRuns: (missionId, limit) => this.deps.missionRegistry.listRuns(missionId, limit),
      listMissionHookBindings: (filter) =>
        this.deps.missionHooks.listBindings({
          ...(filter?.missionId ? { missionId: filter.missionId } : {}),
          ...(filter?.hookKey ? { hookKey: filter.hookKey } : {})
        }),
      bindMissionHook: ({ missionId, hookKey, condition }) =>
        this.deps.runGuardedAction({
          action: 'mission.control',
          actor: actorId,
          target: missionId,
          payload: { hookKey, hasCondition: Boolean(condition) },
          title: 'Mission hook binding blocked',
          execute: async () =>
            this.deps.missionHooks.bind({
              actorId,
              missionId,
              hookKey,
              ...(condition ? { condition } : {})
            })
        }),
      unbindMissionHook: ({ bindingId }) =>
        this.deps.runGuardedAction({
          action: 'mission.control',
          actor: actorId,
          target: bindingId,
          title: 'Mission hook binding removal blocked',
          execute: async () =>
            this.deps.missionHooks.unbind({
              actorId,
              bindingId
            })
        }),
      emitMissionHook: ({ hookKey, payload, source }) =>
        this.deps.runGuardedAction({
          action: 'mission.control',
          actor: actorId,
          target: hookKey,
          payload: { source: source ?? actorId, payloadKeys: Object.keys(payload ?? {}) },
          title: 'Mission hook trigger blocked',
          execute: async () =>
            await this.deps.missionHooks.emit({
              actorId,
              hookKey,
              ...(payload ? { payload } : {}),
              ...(source ? { source } : {})
            })
        }),
      listPendingRequests: (spaceId) =>
        this.deps.store.listPendingRequestsBySpace(spaceId).filter((request) => request.status === 'open'),
      listRuntimeReceipts: () => this.deps.snapshots.overview().receipts,
      listProviderConnections: () => this.deps.snapshots.overview().providers,
      listRuntimeActivities: (threadId) =>
        threadId ? this.deps.snapshots.getSessionByThreadId(threadId)?.recentActivities ?? [] : this.deps.activities.listRecent(25),
      getSessionSnapshotBySpaceId: (spaceId) => this.deps.snapshots.getSessionBySpaceId(spaceId),
      getSessionSnapshotById: (sessionId) => this.deps.snapshots.getSessionById(sessionId),
      getRuntimeOverview: () => this.deps.snapshots.overview(),
      querySessions: (filter) => this.deps.snapshots.querySessions(filter),
      listProjectionStates: () => this.deps.projectionState.list(),
      getProviderDiagnostics: () => this.getProviderDiagnostics(),
      getDefaultModel: () => this.deps.config.defaults.model,
      setDefaultModel: async (model) => {
        const normalizedModel = normalizeAndValidateDefaultModel({
          model,
          availableModels: this.getProviderDiagnostics().availableModels
        });
        await this.deps.runGuardedAction({
          action: 'fs.write',
          actor: actorId,
          target: this.deps.configPath ?? 'config:in-memory',
          payload: { model: normalizedModel },
          title: 'Default model change blocked',
          execute: async () => {
            const previousModel = this.deps.config.defaults.model;
            if (previousModel === normalizedModel) {
              return;
            }
            if (usesProviderDefaultModel(normalizedModel) && !usesProviderDefaultModel(previousModel)) {
              this.deps.providerOrchestrator.refreshActiveSessionsForProviderDefault();
            }
            this.deps.config.defaults.model = normalizedModel;
            if (this.deps.configPath) {
              saveMoorlineConfig(this.deps.config, this.deps.configPath);
              recordHistoryCheckpoint({
                homeRoot: this.deps.homeRoot,
                actor: actorId,
                reason: `Updated default model to ${normalizedModel}.`,
                operation: 'set default model',
                configPath: this.deps.configPath
              });
            }
          }
        });
      },
      getRuntimeStatus: () => this.deps.getRuntimeStatus(),
      listRuntimeEvents: (threadId) => this.deps.canonicalEvents.listByThread(threadId),
      listDomainEvents: (threadId) =>
        this.deps.store.listDomainEvents(threadId).map((row) => ({
          eventId: row.eventId,
          threadId: row.threadId,
          spaceId: row.spaceId,
          sessionId: row.sessionId,
          sourceProviderEventId: row.sourceProviderEventId,
          createdAt: row.createdAt,
          type: row.type as RuntimeDomainEvent['type'],
          payload: JSON.parse(row.payloadJson) as RuntimeDomainEvent['payload']
        })) as RuntimeDomainEvent[],
      updateSessionSummary: async (spaceId, summary, nowIso) => {
        this.deps.sessionRegistry.updateSummary(spaceId, summary, nowIso);
      },
      retrieveMemory: async ({ query, scopeId, spaceId, threadId, maxResults, enableRerank }) =>
        this.deps.runGuardedAction({
          action: 'memory.read',
          actor: actorId,
          target: spaceId ? `${scopeId}:${spaceId}:${threadId ?? 'root'}` : scopeId,
          payload: { query, maxResults, enableRerank },
          title: 'Memory read blocked',
          execute: async () =>
            await retrieveFromMemoryWithSQLite(
              query,
              this.deps.runtimeRoot,
              { scopeId: scopeId, spaceId: spaceId, threadId: threadId ?? null, projectKey: 'default' },
              this.deps.sqlitePath,
              { maxResults, enableRerank }
            )
        }),
      writeSessionMemory: async ({ scopeId, spaceId, threadId, kind, content, sourceRefs }) => {
        await this.deps.runGuardedAction({
          action: kind === 'summary' ? 'memory.write' : 'fs.write',
          actor: actorId,
          target: `${scopeId}:${spaceId}:${threadId ?? 'root'}:${kind}`,
          payload: { sourceRefs },
          title: 'Session memory write blocked',
          execute: async () =>
            this.deps.memoryStore.writeSessionRecord({
              scopeId: scopeId,
              spaceId: spaceId,
              threadId: threadId ?? null,
              kind,
              content,
              sourceRefs
            }).then(() => {
              void refreshMemoryIndex(
                this.deps.runtimeRoot,
                { scopeId: scopeId, spaceId: spaceId, threadId: threadId ?? null, projectKey: 'default' },
                this.deps.sqlitePath
              );
            })
        });
      },
      writeServerMemory: async ({ scopeId, kind, content, sourceRefs }) => {
        await this.deps.runGuardedAction({
          action: 'memory.write',
          actor: actorId,
          target: `${scopeId}:${kind}`,
          payload: { sourceRefs },
          title: 'Server memory write blocked',
          execute: async () =>
            this.deps.memoryStore.writeServerRecord({ scopeId: scopeId, kind, content, sourceRefs }).then(() => {
              void refreshMemoryIndex(
                this.deps.runtimeRoot,
                { scopeId: scopeId, projectKey: 'default' },
                this.deps.sqlitePath
              );
            })
        });
      },
      writeProjectMemory: async ({ projectKey, kind, content, sourceRefs }) => {
        await this.deps.runGuardedAction({
          action: 'memory.write',
          actor: actorId,
          target: `${projectKey ?? 'default'}:${kind}`,
          payload: { sourceRefs },
          title: 'Project memory write blocked',
          execute: async () =>
            this.deps.memoryStore.writeProjectRecord({ projectKey, kind, content, sourceRefs }).then(() => {
              void refreshMemoryIndex(
                this.deps.runtimeRoot,
                { scopeId: this.deps.config.transport.scopeId, projectKey: projectKey ?? 'default' },
                this.deps.sqlitePath
              );
            })
        });
      },
      createSession: async ({ requestedName, runtimeMode, initialInstruction, objective, owner, tags }) => {
        const safeRuntimeMode = parseRuntimeModeName(runtimeMode, 'runtime_mode');
        const created = await this.deps.workManagement.createManagedSession({
          actorId,
          requestedName,
          runtimeMode: safeRuntimeMode,
          initialInstruction,
          objective,
          owner,
          tags
        });
        return { session: created.session, spaceId: created.spaceId };
      },
      directSession: async ({ sessionId, spaceId, instruction, reason }) =>
        await this.deps.workManagement.directManagedSession({
          actorId,
          sessionId,
          spaceId: spaceId,
          instruction,
          reason
        }),
      archiveSession: async ({ spaceId, sessionId }) =>
        await this.deps.workManagement.archiveManagedSession({
          actorId,
          spaceId: spaceId,
          sessionId
        }),
      deleteArchivedSession: async ({ spaceId, sessionId }) =>
        await this.deps.workManagement.deleteManagedSession({
          actorId,
          spaceId: spaceId,
          sessionId
        }),
      archiveMission: async ({ spaceId, missionId }) =>
        await this.deps.workManagement.archiveMission({
          actorId,
          spaceId: spaceId,
          missionId
        }),
      deleteArchivedMission: async ({ spaceId, missionId }) =>
        await this.deps.workManagement.deleteArchivedMission({
          actorId,
          spaceId: spaceId,
          missionId
        }),
      archiveSpaceTarget: async ({ spaceId }) =>
        await this.deps.workManagement.archiveChannelTarget({
          actorId,
          spaceId: spaceId
        }),
      deleteArchivedSpaceTarget: async ({ spaceId }) =>
        await this.deps.workManagement.deleteArchivedChannelTarget({
          actorId,
          spaceId: spaceId
        }),
      createMission: async ({ title, goal, schedule, startTime, runtimeMode }) => {
        const safeRuntimeMode = parseRuntimeModeName(runtimeMode, 'runtime_mode');
        const created = await this.deps.workManagement.createMission({
          actorId,
          title,
          goal,
          schedule,
          startTime,
          runtimeMode: safeRuntimeMode
        });
        return { mission: created.mission, spaceId: created.spaceId };
      },
      pauseMission: async ({ spaceId, missionId }) => this.deps.workManagement.updateMissionLifecycle(actorId, { spaceId: spaceId, missionId }, 'pause'),
      resumeMission: async ({ spaceId, missionId }) => this.deps.workManagement.updateMissionLifecycle(actorId, { spaceId: spaceId, missionId }, 'resume'),
      stopMission: async ({ spaceId, missionId }) => this.deps.workManagement.updateMissionLifecycle(actorId, { spaceId: spaceId, missionId }, 'stop'),
      runMissionNow: async ({ spaceId, missionId, requesterActorId }) => {
        const mission = this.deps.workManagement.resolveMission({ spaceId, missionId });
        if (!mission) {
          return null;
        }
        await this.deps.runGuardedAction({
          action: 'mission.control',
          actor: actorId,
          target: mission.missionId,
          title: 'Mission control blocked',
          execute: async () => undefined
        });
        if (mission.lifecycleStatus === 'draft' || mission.lifecycleStatus === 'stopped' || mission.completedAt || mission.archivedAt) {
          throw new Error(`Mission ${mission.missionId} cannot be run because it is not fully configured or is stopped.`);
        }
        void this.deps.lifecycleService
          .runMissionTurn(mission.missionId, 'manual', 'runtime:mission/manual', requesterActorId ?? null)
          .catch((error) => {
            this.deps.appendAuditEvent('mission.trigger.failed', {
              missionId: mission.missionId,
              actorId,
              error: error instanceof Error ? error.message : String(error)
            });
        });
        return this.deps.missionRegistry.getById(mission.missionId) ?? mission;
      },
      respondToRuntimeRequest: async ({ threadId, requestId, decision, requesterActor }) => {
        await this.deps.resolvePendingRequest({
          actorId,
          requestId,
          decision,
          deniedTitle: 'Provider approval response blocked',
          metadata: { source: 'plugin-context', threadId },
          requestActor: requesterActor
        });
      },
      respondToRuntimeUserInput: async ({ threadId, requestId, answers, requesterActor }) => {
        void threadId;
        await this.deps.answerPendingRequest({
          actorId,
          requestId,
          answers,
          requestActor: requesterActor
        });
      },
      cancelRuntimeRequest: async ({ threadId, requestId, requestType, requesterActor }) => {
        void requestType;
        await this.deps.resolvePendingRequest({
          actorId,
          requestId,
          decision: 'cancel',
          deniedTitle: 'Provider request cancel blocked',
          metadata: { source: 'plugin-context', threadId },
          requestActor: requesterActor
        });
      },
      interruptTurn: async ({ threadId }) => {
        await this.deps.runGuardedAction({
          action: 'net.connect',
          actor: actorId,
          target: this.providerPolicyTarget(threadId, 'interrupt'),
          threadId,
          title: 'Provider turn interrupt blocked',
          execute: async () => this.deps.providerService.interruptTurn(threadId)
        });
      },
      getRuntimeControlStatus: () => this.deps.getRuntimeControlStatus(),
      requestRuntimeReload: async ({ mode, reason, requestedBy }) =>
        await this.deps.runtimeControl.requestRuntimeReload({ actorId, mode, reason, requestedBy }),
      setRuntimeAcceptingNewWork: async ({ accepting, reason, requestedBy }) => {
        await this.deps.runtimeControl.requestSetRuntimeAcceptingNewWork({ actorId, accepting, reason, requestedBy });
      },
      testProvider: async ({ sendTurn, prompt }) => {
        if (typeof this.deps.providerService.testConnection !== 'function') {
          return {
            ok: false,
            message: 'The selected provider does not expose a startup test.',
            remediation: 'Create a session to test provider startup through normal work execution.',
            accountLabel: null,
            availableModels: [],
            sentTurn: false,
            error: 'Provider test capability is not implemented.'
          };
        }
        return await this.deps.runGuardedAction({
          action: 'net.connect',
          actor: actorId,
          target: this.providerPolicyTarget('provider-test', 'test'),
          title: 'Provider startup test blocked',
          execute: async () =>
            await this.deps.providerService.testConnection!({
              runtimeRoot: this.deps.runtimeRoot,
              actor: actorId,
              ...(this.deps.config.defaults.model ? { model: this.deps.config.defaults.model } : {}),
              sendTurn: sendTurn === true,
              ...(prompt ? { prompt } : {})
            })
        });
      },
      stopProvider: async ({ threadId, reason, requestedBy }) => {
        return await this.deps.runtimeControl.requestStopProviderSessions({ actorId, threadId, reason, requestedBy });
      },
      startProvider: async ({ threadId, reason, requestedBy }) => {
        return await this.deps.runtimeControl.requestStartProviderSessions({ actorId, threadId, reason, requestedBy });
      },
      ensureSidecar: async ({ name, scope, launch }) =>
        await this.deps.runGuardedAction({
          action: 'sidecar.manage',
          actor: actorId,
          target: `${actorId}:${name}:${scope.kind}:${scope.kind === 'global' ? 'runtime' : scope.key}`,
          payload: {
            command: launch.command,
            scopeKind: scope.kind,
            scopeKey: scope.kind === 'global' ? null : scope.key
          },
          title: 'Sidecar create blocked',
          execute: async () => {
            const normalizedScope = this.normalizePluginSidecarScope(scope);
            return await this.deps.sidecars.ensure({
              pluginId: toPluginPackageId(actorId),
              name,
              scope: normalizedScope,
              launch
            });
          }
        }),
      stopSidecar: async ({ name, scopeKind, scopeKey }) =>
        await this.deps.runGuardedAction({
          action: 'sidecar.manage',
          actor: actorId,
          target: `${actorId}:${name}:${scopeKind}:${scopeKey}`,
          title: 'Sidecar stop blocked',
          execute: async () =>
            await this.deps.sidecars.stop({
              pluginId: toPluginPackageId(actorId),
              name,
              scopeKind,
              scopeKey: scopeKind === 'session' ? this.resolveSessionScopedSidecarKey(scopeKey) : scopeKey
            })
        }),
      listSidecars: (filter) =>
        this.deps.sidecars.listSidecars().filter((sidecar) => {
          const normalizedScopeKey =
            filter?.scopeKind === 'session' && filter.scopeKey
              ? this.resolveSessionScopedSidecarKey(filter.scopeKey)
              : filter?.scopeKey;
          if (filter?.pluginId && sidecar.pluginId !== toPluginPackageId(filter.pluginId)) {
            return false;
          }
          if (filter?.scopeKind && sidecar.scopeKind !== filter.scopeKind) {
            return false;
          }
          if (normalizedScopeKey && sidecar.scopeKey !== normalizedScopeKey) {
            return false;
          }
          if (filter?.status && sidecar.status !== filter.status) {
            return false;
          }
          return true;
        }),
      sendMessage: async (spaceId, payload) => {
        await this.deps.postTransportMessage(actorId, spaceId, payload);
      },
      sendStatusUpdate: async (payload) => {
        const namespaceState = this.deps.getNamespaceState();
        if (namespaceState) {
          await this.deps.postTransportMessage(actorId, namespaceState.statusChannelId, payload);
        }
      },
      appendAuditEvent: (event, payload) => {
        this.deps.appendAuditEvent(event, payload);
      },
      nowIso: () => this.deps.now(),
      runAgent: async ({
        surface,
        spaceId,
        actorId: promptActorId,
        actorLabel,
        text,
        attachments,
        session,
        cwd,
        runtimeMode,
        basePromptSections,
        promptSource
      }) => {
        const promptSections = [
          ...basePromptSections,
          ...(await this.deps.getPluginHost().beforeAgentPrompt(
            {
              surface,
              spaceId,
              actorId: promptActorId,
              actorLabel,
              text,
              attachments,
              session
            },
            (pluginId) => this.createContext(`plugin:${pluginId}`)
          ))
        ];
        const activeSession = session ?? (await this.deps.ensureChatSession(spaceId, cwd));
        const prompt = [
          ...promptSections,
          '',
          promptSource === 'orchestration'
            ? `Orchestration instruction from ${actorLabel} (${promptActorId}): ${text || '(no text content)'}`
            : `Transport message from ${describeTransportAuthor({
                authorId: promptActorId,
                authorUsername: actorLabel,
                authorGlobalName: null,
                authorDisplayName: actorLabel,
                authorLabel: actorLabel
              })}: ${text || '(no text content)'}`,
          ...((attachments ?? []).length > 0 ? [`Attached image count: ${(attachments ?? []).length}`] : [])
        ].join('\n');
        const providerImages = await this.deps.prepareProviderImages(activeSession.threadId, attachments);
        const result = await this.deps.providerOrchestrator.runTurn({
          actorId,
          session: activeSession,
          spaceId: spaceId,
          surface,
          promptContent: text,
          promptSource,
          authorId: promptActorId,
          authorLabel: actorLabel,
          providerInput: {
            text: prompt,
            ...(providerImages && providerImages.length > 0 ? { images: providerImages } : {})
          }
        });
        const formattedResult = this.deps.normalizeReply(
          result.text || (result.attachments?.length ? '' : 'I could not finish that cleanly.')
        );

        await this.deps.getPluginHost().afterAgentResponse(
          {
            surface,
            spaceId,
            actorId: promptActorId,
            actorLabel,
            text,
            attachments,
            session,
            replyMessage: formattedResult
          },
          (pluginId) => this.createContext(`plugin:${pluginId}`)
        );

        void runtimeMode;
        return {
          ...result,
          ...(formattedResult ? { text: formattedResult } : {})
        };
      },
      drainRuntimeWork: async () => {
        await this.deps.drainRuntimeWork();
      }
    };
  }

  async loadSessionPromptSections(session: RuntimeSessionRow): Promise<string[]> {
    const dynamicSections = [
      `Session ID: ${session.sessionId}`,
      `Workspace: ${session.workspacePath}`,
      `Runtime mode: ${session.runtimeMode}`
    ];
    if (session.objective) {
      dynamicSections.push(`Objective: ${session.objective}`);
    }
    if ((session.tags ?? []).length > 0) {
      dynamicSections.push(`Tags: ${(session.tags ?? []).join(', ')}`);
    }
    if (session.ownerKind && session.ownerId) {
      dynamicSections.push(`Owner: ${session.ownerKind}:${session.ownerId}${session.ownerLabel ? ` (${session.ownerLabel})` : ''}`);
    }

    return dynamicSections;
  }

  async loadMissionPromptSections(mission: RuntimeMissionRow): Promise<string[]> {
    return [
      `Mission ID: ${mission.missionId}`,
      `Mission title: ${mission.title}`,
      `Mission goal: ${mission.goal}`,
      `Mission schedule: ${mission.scheduleText}`,
      `Mission workspace: ${mission.workspacePath}`,
      `Runtime mode: ${mission.runtimeMode}`,
      'Mission interactions are independent operator messages. Respond directly to the current message while using the persistent mission thread context when helpful.',
      'Manual mission messages must not change or cancel the recurring mission schedule.'
    ];
  }

  private normalizePluginSidecarScope(scope: { kind: 'global' } | { kind: 'session' | 'ephemeral'; key: string }) {
    if (scope.kind === 'session') {
      return {
        kind: 'session' as const,
        key: this.resolveSessionScopedSidecarKey(scope.key)
      };
    }
    return scope;
  }

  private resolveSessionScopedSidecarKey(candidate: string): string {
    const normalized = candidate.trim();
    const sessions = this.deps.sessionRegistry.list();
    const session =
      sessions.find((entry) => entry.sessionId === normalized) ??
      sessions.find((entry) => entry.spaceId === normalized) ??
      sessions.find((entry) => entry.threadId === normalized) ??
      null;
    if (!session) {
      throw new Error(`Session-scoped sidecars require a known session identity. No session matches ${candidate}.`);
    }
    return session.sessionId;
  }
}
