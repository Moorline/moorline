import { randomUUID } from 'node:crypto';
import {
  defaultAdminConfig,
  usesProviderDefaultModel,
  type RuntimeSurfaceState
} from '../../types/config.js';
import { buildHealthEmbed } from './hosting/systemEmbeds.js';
import { PluginHost, type PluginHookFailureRecord } from '../extension/plugins/pluginHost.js';
import type { RuntimePluginContext } from '../../types/plugin.js';
import { createPolicyEngine } from '../system/policy/policyEngine.js';
import { loadPolicyProfile } from '../system/policy/policyProfile.js';
import { createActorRulePolicyHook } from '../system/policy/actorRulePolicy.js';
import { createNetworkPolicyHook } from '../system/policy/networkPolicy.js';
import { RuntimeActionGuard } from '../system/policy/runtimeActionGuard.js';
import type { PendingRuntimeRequestRecord } from '../../types/runtime.js';
import { DEFAULT_PROVIDER_TOOL_POLICY, type RuntimeProvider, type RuntimeProviderSessionInput } from '../../types/provider.js';
import { SessionLifecycleService } from '../domain/sessions/sessionLifecycleService.js';
import { SkillRegistry } from '../extension/skills/skillRegistry.js';
import { type RuntimeSessionRow, SqliteSessionStore } from '../system/state/sqliteSessionStore.js';
import { JsonAuditLogger } from '../system/audit/auditLogger.js';
import { SessionRegistry } from '../domain/sessions/sessionState.js';
import { MemoryStore } from '../domain/memory/store.js';
import { RuntimeIngestion } from './execution/runtimeIngestion.js';
import { CommandReactor } from './execution/commandReactor.js';
import type { RuntimeDomainEvent } from './execution/runtimeDomain.js';
import { RuntimeReceiptBus } from './execution/runtimeReceiptBus.js';
import { OrchestrationEngine } from './execution/orchestrationEngine.js';
import { KeyedDrainableWorker } from './execution/drainableWorker.js';
import { RuntimeActivityStore, type RuntimeActivityRecord } from '../system/projection/runtimeActivityStore.js';
import { ProjectionStateStore } from '../system/projection/projectionStateStore.js';
import { PendingRequestProjectionStore } from '../system/projection/pendingRequestProjectionStore.js';
import { RuntimeSnapshotQuery } from '../system/projection/runtimeSnapshotQuery.js';
import { RuntimeReconciler } from '../system/projection/runtimeReconciler.js';
import { ProviderSessionDirectory } from './execution/providerSessionDirectory.js';
import { CanonicalEventLogStore } from '../system/state/canonicalEventLogStore.js';
import { loadRuntimePluginsWithDiagnostics } from '../extension/plugins/runtimePluginLoader.js';
import { SidecarManager } from './supervision/sidecarManager.js';
import type {
  RuntimeMessagePayload,
  RuntimeAttachmentPayload,
  RuntimeActorIdentity
} from '../../types/transport.js';
import type {
  RuntimeControlExecutionRequest,
  RuntimeControlResult,
  RuntimeControlStatus,
  RuntimeReloadMode
} from './supervision/runtimeControl.js';
import type { SidecarScopeKind } from './supervision/managedSidecar.js';
import { ManagementReadModelService } from '../system/projection/managementReadModelService.js';
import { RuntimeControlService } from './supervision/runtimeControlService.js';
import type { RuntimeManagementSurfaceHandle } from './hosting/runtimeManagementPort.js';
import { RuntimeWorkManagementService } from '../domain/sessions/runtimeWorkManagementService.js';
import { RuntimeInteractionService } from './execution/runtimeInteractionService.js';
import { RuntimeTransportIntentService } from './hosting/runtimeTransportIntentService.js';
import { RuntimeTransportSurfaceService } from './hosting/runtimeTransportSurfaceService.js';
import { ProviderOrchestrator } from './execution/providerOrchestration/providerOrchestrator.js';
import { RuntimeProjectionService } from '../system/projection/runtimeProjectionService.js';
import { RuntimeOrchestrationRequestService } from './execution/runtimeOrchestrationRequestService.js';
import { RuntimeLifecycleService } from './lifecycle/runtimeLifecycleService.js';
import { PackageJobSchedulerService } from './lifecycle/packageJobSchedulerService.js';
import { RuntimePluginContextService } from './execution/runtimePluginContextService.js';
import { RuntimePendingRequestService } from './execution/runtimePendingRequestService.js';
import { RuntimeHostingService } from './hosting/runtimeHostingService.js';
import {
  buildMoorlineRuntimeServiceGraph,
  type MoorlineRuntimeDeps,
  prepareRuntimeLayout
} from './moorlineRuntimeBuilder.js';
import { prepareProviderImages } from '../shared/utils/runtimeMessageUtils.js';
import {
  createRuntimePackageLoadReport,
  saveRuntimePackageLoadReport
} from '../system/release/runtimePackageLoadReport.js';
import {
  detectMoorlineRuntimeMode,
  readMoorlineReleaseManifest,
  resolveMoorlineAssetRoot
} from '../system/release/releaseArtifacts.js';
import { appendRuntimeAuditLine, flushRuntimeAuditLines } from './runtimeAudit.js';
import { computeRuntimeStatus, type MoorlineRuntimeStatus } from './runtimeStatus.js';

export class MoorlineRuntime {
  private static readonly PROVIDER_AUTO_START_DEFAULT_KEY = 'runtime.provider.auto_start.default';
  private readonly now: () => string;
  private readonly paths;
  private readonly store: SqliteSessionStore;
  private readonly sessionRegistry: SessionRegistry;
  private readonly sessionLifecycle: SessionLifecycleService;
  private pluginHost: PluginHost;
  private readonly skillRegistry: SkillRegistry;
  private readonly memoryStore: MemoryStore;
  private readonly audit: JsonAuditLogger;
  private readonly providerService: RuntimeProvider;
  private readonly ingestion: RuntimeIngestion;
  private readonly reactor: CommandReactor;
  private readonly receiptBus: RuntimeReceiptBus;
  private readonly activities: RuntimeActivityStore;
  private readonly pendingRequests: PendingRequestProjectionStore;
  private readonly projectionState: ProjectionStateStore;
  private readonly orchestration: OrchestrationEngine;
  private readonly snapshots: RuntimeSnapshotQuery;
  private readonly reconciler: RuntimeReconciler;
  private readonly providerDirectory: ProviderSessionDirectory;
  private readonly canonicalEvents: CanonicalEventLogStore;
  private readonly sidecars: SidecarManager;
  private readonly managementReadModel: ManagementReadModelService;
  private readonly runtimeControl: RuntimeControlService;
  private readonly workManagement: RuntimeWorkManagementService;
  private readonly interactions: RuntimeInteractionService;
  private readonly transportIntents: RuntimeTransportIntentService;
  private readonly transportSurface: RuntimeTransportSurfaceService;
  private readonly providerOrchestrator: ProviderOrchestrator;
  private readonly projectionService: RuntimeProjectionService;
  private readonly managementSurface: RuntimeManagementSurfaceHandle;
  private readonly hostingService: RuntimeHostingService;
  private readonly orchestrationRequests: RuntimeOrchestrationRequestService;
  private readonly lifecycleService: RuntimeLifecycleService;
  private readonly pendingRequestService: RuntimePendingRequestService;
  private readonly packageJobScheduler: PackageJobSchedulerService;
  private readonly pluginHostRef: { current: PluginHost };
  private pluginContexts!: RuntimePluginContextService;
  private readonly providerQueue: KeyedDrainableWorker;
  private readonly commandQueue: KeyedDrainableWorker;
  private readonly projectionQueue: KeyedDrainableWorker;
  private readonly transportQueue: KeyedDrainableWorker;
  private stoppingReason: string | null = null;
  private acceptingNewWork = true;
  private readonly coordinationWorkspacePath: string;
  private readonly runtimePolicyPath: string;
  private guard: RuntimeActionGuard | null = null;
  private startedAtIso: string | null = null;
  private surfaceState: RuntimeSurfaceState | null = null;
  private providerAutoStartDefault = true;

  private configuredProviderModel(): string | undefined {
    return usesProviderDefaultModel(this.deps.config.defaults.model) ? undefined : this.deps.config.defaults.model;
  }

  private async prepareProviderImages(threadId: string, attachments: RuntimeAttachmentPayload[] | undefined) {
    return await prepareProviderImages({
      runtimeRoot: this.paths.runtimeRoot,
      threadId,
      attachments
    });
  }

  constructor(private readonly deps: MoorlineRuntimeDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    const graph = buildMoorlineRuntimeServiceGraph(deps, {
      now: this.now,
      requireGuard: () => this.requireGuard(),
      getEffectiveAdminConfig: () => this.getEffectiveAdminConfig(),
      createPluginContext: (actorId) => this.createPluginContext(actorId),
      cleanupScopedSidecars: async (scopeKind, scopeKey, reason) => await this.cleanupScopedSidecars(scopeKind, scopeKey, reason),
      runOrchestrationTurn: async (session, actorId, content) => await this.runOrchestrationTurn(session, actorId, content),
      ensureCoordinationSession: async (transportResourceId, cwd) => await this.ensureCoordinationSession(transportResourceId, cwd),
      isAdminActor: (input) => this.isAdminActor(input),
      postTransportMessage: async (actor, transportResourceId, payload) => await this.postTransportMessage(actor, transportResourceId, payload),
      sendStatusUpdate: async (payload) => await this.sendStatusUpdate(payload),
      runGuardedAction: async (input) => await this.runGuardedAction(input),
      requireSurfaceState: () => this.requireSurfaceState(),
      getSurfaceState: () => this.surfaceState,
      getRuntimeStatus: () => this.getRuntimeStatus(),
      getRuntimeControlStatus: () => this.getRuntimeControlStatus(),
      appendAuditEvent: (event, payload) => {
        this.appendAuditEvent(event, payload);
      },
      recordRuntimeActivity: (input) => {
        this.recordRuntimeActivity(input);
      },
      setAcceptingNewWork: (accepting) => {
        this.acceptingNewWork = accepting;
      },
      setProviderAutoStartDefault: (enabled) => {
        this.providerAutoStartDefault = enabled;
      },
      getProviderAutoStartDefault: () => this.providerAutoStartDefault,
      rejectTurnWaitersForThread: (threadId, reason) => {
        this.providerOrchestrator.rejectThread(threadId, reason);
      }
    });
    this.deps = graph.deps;
    this.paths = graph.paths;
    this.coordinationWorkspacePath = graph.coordinationWorkspacePath;
    this.runtimePolicyPath = graph.runtimePolicyPath;
    this.store = graph.store;
    this.sessionRegistry = graph.sessionRegistry;
    this.sessionLifecycle = graph.sessionLifecycle;
    this.pluginHostRef = graph.pluginHostRef;
    this.pluginHost = graph.pluginHost;
    this.skillRegistry = graph.skillRegistry;
    this.memoryStore = graph.memoryStore;
    this.audit = graph.audit;
    this.providerService = graph.providerService;
    this.ingestion = graph.ingestion;
    this.reactor = graph.reactor;
    this.receiptBus = graph.receiptBus;
    this.activities = graph.activities;
    this.pendingRequests = graph.pendingRequests;
    this.projectionState = graph.projectionState;
    this.orchestration = graph.orchestration;
    this.snapshots = graph.snapshots;
    this.reconciler = graph.reconciler;
    this.providerDirectory = graph.providerDirectory;
    this.canonicalEvents = graph.canonicalEvents;
    this.sidecars = graph.sidecars;
    this.managementReadModel = graph.managementReadModel;
    this.runtimeControl = graph.runtimeControl;
    this.workManagement = graph.workManagement;
    this.interactions = graph.interactions;
    this.transportIntents = graph.transportIntents;
    this.transportSurface = graph.transportSurface;
    this.providerOrchestrator = graph.providerOrchestrator;
    this.projectionService = graph.projectionService;
    this.managementSurface = graph.managementSurface;
    this.hostingService = graph.hostingService;
    this.orchestrationRequests = graph.orchestrationRequests;
    this.lifecycleService = graph.lifecycleService;
    this.pendingRequestService = graph.pendingRequestService;
    this.packageJobScheduler = graph.packageJobScheduler;
    this.pluginContexts = graph.pluginContexts;
    this.providerQueue = graph.providerQueue;
    this.commandQueue = graph.commandQueue;
    this.projectionQueue = graph.projectionQueue;
    this.transportQueue = graph.transportQueue;
  }

  async start(): Promise<void> {
    this.stoppingReason = null;
    this.acceptingNewWork = true;
    this.providerAutoStartDefault = this.store.getMetadata<boolean>(MoorlineRuntime.PROVIDER_AUTO_START_DEFAULT_KEY) ?? true;
    await prepareRuntimeLayout(this.paths.runtimeRoot);
    const runtimeMode = detectMoorlineRuntimeMode(import.meta.url);
    const assetRoot = resolveMoorlineAssetRoot(import.meta.url);
    const releaseManifest = readMoorlineReleaseManifest(assetRoot, runtimeMode);
    const pluginLoad = await loadRuntimePluginsWithDiagnostics(this.paths.runtimeRoot, 'startup', this.now);
    saveRuntimePackageLoadReport(
      this.paths.packageLoadReportPath,
      createRuntimePackageLoadReport({
        runtimeMode,
        releaseManifest,
        failures: pluginLoad.failures,
        updatedAt: this.now()
      })
    );
    this.pluginHost = new PluginHost(pluginLoad.plugins, {
      onHookFailure: (failure) => this.recordPluginHookFailure(failure)
    });
    this.pluginHostRef.current = this.pluginHost;
    this.initializePolicyGuard();
    this.surfaceState = await this.hostingService.start({
      actions: this.pluginHost.listActions((pluginId) => this.createPluginContext(`plugin:${pluginId}`)),
      onTransportIntent: async (intent) => {
        await this.transportIntents.handleIntent(intent);
      }
    });
    await this.transportIntents.drainPendingIntents();
    this.providerService.on('providerEvent', (event) => {
      void this.providerQueue
        .push(event.threadId, async () => {
          await this.providerOrchestrator.handleProviderEvent(event);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.appendAuditEvent('runtime.queue.reject', {
            queue: this.providerQueue.getStats(),
            threadId: event.threadId,
            source: 'providerEvent',
            error: message
          });
          this.recordRuntimeActivity({
            threadId: event.threadId,
            sessionId: null,
            transportResourceId: null,
            sourceEventId: randomUUID(),
            kind: 'runtime.queue.reject',
            severity: 'warning',
            title: 'Runtime queue rejected provider event',
            detail: message,
            createdAt: this.now()
          });
        });
    });
    await this.pluginHost.onRuntimeStarted((pluginId) => this.createPluginContext(`plugin:${pluginId}`));
    await this.sidecars.recover();
    await this.providerService.recoverSessions({
      sessions: this.sessionRegistry.list().map((session) => this.toProviderSessionInput(session)),
      runtimeRoot: this.paths.runtimeRoot,
      ...(this.configuredProviderModel() ? { model: this.configuredProviderModel() } : {})
    });
    await this.recoverOpenRequests();
    await this.reconcileRecoveredState();
    this.lifecycleService.start();
    this.packageJobScheduler.start();
    this.orchestrationRequests.start();
    this.startedAtIso = this.now();
    this.appendAuditEvent('runtime.started', {
      scopeId: this.deps.config.transport!.scopeId,
      transportKind: this.deps.config.transport!.kind,
      transportApplicationId: this.deps.config.transport!.config.applicationId
    });
    await this.sendStatusUpdate({
      text: 'Moorline runtime online.',
      blocks: [
        {
          kind: 'fields',
          title: 'Runtime Status',
          fields: this.buildStatusEmbed().fields.map((field) => ({
            label: field.name,
            value: field.value,
            inline: field.inline
          })),
          tone: 'success'
        }
      ]
    });
  }

  async stop(): Promise<void> {
    const safeClose = (label: string, close: () => void): void => {
      try {
        close();
      } catch (error) {
        this.appendAuditEvent('runtime.resource-close.failed', {
          label,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };
    this.stoppingReason = 'Moorline runtime stopped before the active turn completed.';
    try {
      this.lifecycleService.stop();
      this.packageJobScheduler.stop();
      this.orchestrationRequests.stop();
      this.providerOrchestrator.clearRequestAttribution();
      this.rejectKnownProviderThreads(this.stoppingReason);
      this.providerOrchestrator.rejectAll(this.stoppingReason);
      this.providerOrchestrator.clearCompactionLatches();
      await this.sidecars.shutdown('runtime stop');
      this.providerService.stopAll();
      await this.providerService.drain();
      await this.providerQueue.drain();
      await this.commandQueue.drain();
      await this.projectionQueue.drain();
      await this.transportQueue.drain();
      await this.orchestrationRequests.drain();
      await this.hostingService.stop();
      this.appendAuditEvent('runtime.stopped', { scopeId: this.deps.config.transport!.scopeId });
    } finally {
      await flushRuntimeAuditLines(this.paths.logsDir);
      safeClose('runtime.receiptBus', () => this.receiptBus.close());
      safeClose('runtime.activityStore', () => this.activities.close());
      safeClose('runtime.pendingRequestStore', () => this.pendingRequests.close());
      safeClose('runtime.projectionStateStore', () => this.projectionState.close());
      safeClose('runtime.snapshotQuery', () => this.snapshots.close());
      safeClose('runtime.canonicalEventStore', () => this.canonicalEvents.close());
      safeClose('runtime.sessionStore', () => this.store.close());
    }
  }

  private rejectKnownProviderThreads(reason: string): void {
    const threadIds = new Set<string>();
    for (const session of this.sessionRegistry.list()) {
      threadIds.add(session.threadId);
    }
    for (const threadId of threadIds) {
      this.providerOrchestrator.rejectThread(threadId, reason);
    }
  }

  private recordPluginHookFailure(failure: PluginHookFailureRecord): void {
    this.appendAuditEvent('plugin.hook.failed', {
      pluginId: failure.pluginId,
      hook: failure.hook,
      timeout: failure.timeout,
      timeoutMs: failure.timeoutMs,
      durationMs: failure.durationMs,
      error: failure.error
    });
    this.recordRuntimeActivity({
      threadId: `plugin:${failure.pluginId}`,
      sessionId: null,
      transportResourceId: null,
      sourceEventId: randomUUID(),
      kind: 'plugin.hook.failed',
      severity: 'warning',
      title: 'Plugin hook failed',
      detail: `${failure.pluginId} ${failure.hook}: ${failure.error}`,
      createdAt: this.now()
    });
  }

  async drain(): Promise<void> {
    await this.providerService.drain();
    await this.providerQueue.drain();
    await this.commandQueue.drain();
    await this.projectionQueue.drain();
    await this.transportQueue.drain();
    await this.orchestrationRequests.drain();
  }

  async shutdownForSupervisor(mode: RuntimeReloadMode, timeoutMs = 30_000): Promise<void> {
    this.acceptingNewWork = false;
    try {
      await this.waitForActiveTurnsToQuiesce(timeoutMs);
    } catch {
      // Both graceful and force shutdowns get the same bounded quiesce window.
      // The supervisor decides when to escalate to process termination.
    }
    await this.stop();
  }

  private initializePolicyGuard(): void {
    const policyProfile = loadPolicyProfile(this.runtimePolicyPath);
    const pluginActorRules = this.pluginHost.listPluginManifests().map((manifest) => ({
      actorPrefix: `plugin:${manifest.id}`,
      allowCapabilities: [...manifest.capabilities],
      denyCapabilities: [],
      targetPrefixes: []
    }));
    const policyEngine = createPolicyEngine({
      grantedCapabilities: new Set(policyProfile.allowCapabilities),
      denyUnknownCapabilities: policyProfile.denyUnknownCapabilities,
      hooks: [
        createActorRulePolicyHook({
          rules: [...policyProfile.actorRules, ...pluginActorRules]
        }),
        createNetworkPolicyHook(policyProfile.network)
      ]
    });
    this.guard = new RuntimeActionGuard({
      evaluate: (input) => policyEngine.evaluate(input),
      audit: this.audit
    });
  }

  private requireGuard(): RuntimeActionGuard {
    if (!this.guard) {
      throw new Error('Runtime policy guard is not initialized');
    }
    return this.guard;
  }

  private getEffectiveAdminConfig() {
    return this.deps.config.admin ?? defaultAdminConfig();
  }

  private createPluginContext(actorId: string): RuntimePluginContext {
    return this.pluginContexts.createContext(actorId);
  }

  private async cleanupScopedSidecars(scopeKind: SidecarScopeKind, scopeKey: string, reason: string): Promise<void> {
    await this.sidecars.cleanupScope({
      scopeKind,
      scopeKey,
      reason
    });
  }

  private async runOrchestrationTurn(
    session: RuntimeSessionRow,
    actorId: string,
    content: string
  ): Promise<RuntimeMessagePayload> {
    return await this.createPluginContext(actorId).runAgent({
      surface: 'session',
      transportResourceId: session.transportResourceId,
      actorId,
      actorLabel: 'Moorline Orchestrator',
      message: content,
      session,
      cwd: session.workspacePath,
      runtimeMode: session.runtimeMode,
      context: {
        systemPromptSections: await this.pluginContexts.loadSessionPromptSections(session)
      },
      promptSource: 'orchestration'
    });
  }

  private async ensureCoordinationSession(transportResourceId: string, cwd: string): Promise<RuntimeSessionRow> {
    const existing = this.sessionRegistry.getByTransportResourceId(transportResourceId);
    if (existing) {
      return existing;
    }
    return this.reactor.createCoordinationSession({
      scopeId: this.deps.config.transport!.scopeId,
      transportResourceId,
      threadId: `coordination:${transportResourceId}`,
      transportResourceName: 'moorline-coordination',
      workspacePath: cwd,
      runtimeMode: this.deps.config.defaults.runtimeMode,
      nowIso: this.now(),
      providerAutoStartEnabled: this.providerAutoStartDefault
    })!;
  }

  private toProviderSessionInput(session: RuntimeSessionRow): RuntimeProviderSessionInput {
    const agentKind = session.agentKind ?? 'workspace';
    if (agentKind === 'workspace' && !session.workspacePath) {
      throw new Error(`Workspace provider session ${session.sessionId} is missing workspacePath.`);
    }
    if (agentKind === 'ephemeral' && session.workspacePath !== null) {
      throw new Error(`Ephemeral provider session ${session.sessionId} must not have a workspacePath.`);
    }
    return {
      sessionId: session.sessionId,
      threadId: session.threadId,
      transportResourceId: session.transportResourceId,
      runtimeMode: session.runtimeMode,
      agentKind,
      workspacePath: session.workspacePath,
      providerCwd: session.providerCwd ?? null,
      resumeCursor: session.resumeCursor ?? null,
      lifecycleStatus: session.lifecycleStatus,
      providerAutoStartEnabled: session.providerAutoStartEnabled,
      toolGrantIds: session.toolGrantIds ?? [],
      toolPolicy: this.deps.providerToolPolicy ?? DEFAULT_PROVIDER_TOOL_POLICY
    };
  }

  private providerAutoStartEnabled(session: RuntimeSessionRow): boolean {
    return this.providerOrchestrator.providerAutoStartEnabled(session);
  }

  private setProviderAutoStartDefault(enabled: boolean): void {
    this.providerOrchestrator.setProviderAutoStartDefault(enabled);
  }

  private providerStoppedReply(session: RuntimeSessionRow): string {
    return this.providerOrchestrator.providerStoppedReply(session);
  }

  private async ensureProviderSession(
    session: RuntimeSessionRow,
    actor: string,
    options: { persistSessionState?: boolean } = {}
  ): Promise<void> {
    await this.providerOrchestrator.ensureSession(session, actor, options);
  }

  private refreshActiveSessionsForProviderDefault(): void {
    this.providerOrchestrator.refreshActiveSessionsForProviderDefault();
  }

  private async handleDomainEvent(event: RuntimeDomainEvent): Promise<void> {
    await this.projectionService.handleDomainEvent(event);
  }

  private async postRuntimeRequestMessage(transportResourceId: string, request: PendingRuntimeRequestRecord): Promise<void> {
    await this.pendingRequestService.postRuntimeRequestMessage(transportResourceId, request);
  }

  private async recoverOpenRequests(): Promise<void> {
    await this.projectionService.recoverOpenRequests();
  }

  private async reconcileRecoveredState(): Promise<void> {
    this.projectionService.reconcileRecoveredState();
  }

  private async postTransportMessage(actor: string, transportResourceId: string, payload: RuntimeMessagePayload): Promise<{ id: string }> {
    return await this.transportSurface.postMessage(actor, transportResourceId, payload);
  }

  private async sendStatusUpdate(payload: RuntimeMessagePayload): Promise<void> {
    await this.transportSurface.sendStatusUpdate(payload);
  }

  private buildStatusEmbed() {
    const status = this.getRuntimeStatus();
    const projectionFailures = this.projectionState.list().filter((entry) => entry.failure !== null);
    const providerErrorCount = Number(this.providerService.getDiagnostics().statusCounts.error ?? 0);
    return buildHealthEmbed({
      uptimeSeconds: status.uptimeSeconds,
      dbOk: projectionFailures.length === 0,
      environmentOk: providerErrorCount === 0,
      activeSessions: status.openSessions,
      coolSessions: status.coolSessions,
      archivedSessions: status.archivedSessions
    });
  }

  private getRuntimeStatus(): MoorlineRuntimeStatus {
    return computeRuntimeStatus({
      snapshots: this.snapshots,
      startedAtIso: this.startedAtIso,
      now: this.now
    });
  }

  getRuntimeControlStatus(): RuntimeControlStatus {
    return {
      acceptingNewWork: this.acceptingNewWork,
      supervised: this.deps.supervised === true
    };
  }

  getManagementUrl(): string | null {
    return this.managementSurface.getUrl();
  }

  getManagementAccessUrl(): string | null {
    return this.managementSurface.getAccessUrl();
  }

  private isAdminActor(input: RuntimeActorIdentity): boolean {
    const adminConfig = this.getEffectiveAdminConfig();
    if (adminConfig.userIds.includes(input.actorId)) {
      return true;
    }
    if ((input.accessGroupIds ?? []).some((accessGroupId) => adminConfig.accessGroupIds.includes(accessGroupId))) {
      return true;
    }
    return adminConfig.allowTransportAdmin === true && input.isSurfaceAdmin === true;
  }

  async waitForActiveTurnsToQuiesce(timeoutMs = 30_000): Promise<void> {
    const activeReceipts = this.receiptBus
      .list()
      .filter((receipt) => receipt.state === 'running' || receipt.state === 'waiting_for_approval' || receipt.state === 'waiting_for_input');
    await Promise.all(activeReceipts.map((receipt) => this.receiptBus.waitForQuiesced(receipt.threadId, timeoutMs)));
  }

  async executeSupervisorControl(input: RuntimeControlExecutionRequest): Promise<RuntimeControlResult> {
    return await this.runtimeControl.executeSupervisorControl(input);
  }

  private async respondToProviderRequest(
    actor: string,
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
    title: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    await this.pendingRequestService.respondToProviderRequest(actor, threadId, requestId, decision, title, payload);
  }

  private async respondToProviderUserInput(
    actor: string,
    threadId: string,
    requestId: string,
    answers: Record<string, string | string[]>
  ): Promise<void> {
    await this.pendingRequestService.respondToProviderUserInput(actor, threadId, requestId, answers);
  }

  private async cancelProviderUserInput(actor: string, threadId: string, requestId: string): Promise<void> {
    await this.pendingRequestService.cancelProviderUserInput(actor, threadId, requestId);
  }

  private async runGuardedAction<T>(input: {
    action: Parameters<RuntimeActionGuard['run']>[0]['action'];
    actor: string;
    target?: string;
    payload?: unknown;
    threadId?: string;
    title: string;
    execute: () => Promise<T>;
  }): Promise<T> {
    try {
      return await this.requireGuard().run({
        action: input.action,
        actor: input.actor,
        target: input.target,
        payload: input.payload,
        execute: input.execute
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Action blocked by policy:')) {
        this.recordRuntimeActivity({
          threadId: input.threadId ?? 'runtime',
          sessionId: this.sessionRegistry.getByThreadId(input.threadId ?? '')?.sessionId ?? null,
          transportResourceId: this.sessionRegistry.getByThreadId(input.threadId ?? '')?.transportResourceId ?? null,
          sourceEventId: randomUUID(),
          kind: 'policy.denied',
          severity: 'error',
          title: input.title,
          detail: error.message.replace('Action blocked by policy: ', ''),
          createdAt: this.now()
        });
      } else {
        this.recordRuntimeActivity({
          threadId: input.threadId ?? 'runtime',
          sessionId: this.sessionRegistry.getByThreadId(input.threadId ?? '')?.sessionId ?? null,
          transportResourceId: this.sessionRegistry.getByThreadId(input.threadId ?? '')?.transportResourceId ?? null,
          sourceEventId: randomUUID(),
          kind: 'provider.operation.failed',
          severity: 'error',
          title: input.title,
          detail: error instanceof Error ? error.message : String(error),
          createdAt: this.now()
        });
      }
      throw error;
    }
  }

  private recordRuntimeActivity(input: Omit<RuntimeActivityRecord, 'activityId'>): void {
    const activity: RuntimeActivityRecord = {
      activityId: randomUUID(),
      ...input
    };
    this.activities.append(activity);
    void this.pluginHost.onRuntimeActivity(activity, (pluginId) => this.createPluginContext(`plugin:${pluginId}`));
  }

  private requireSurfaceState(): RuntimeSurfaceState {
    if (!this.surfaceState) {
      throw new Error('Managed surface is not available before runtime start');
    }
    return this.surfaceState;
  }

  private appendAuditEvent(event: string, payload: Record<string, unknown>): void {
    appendRuntimeAuditLine({ logsDir: this.paths.logsDir, now: this.now, event, payload });
  }
}
