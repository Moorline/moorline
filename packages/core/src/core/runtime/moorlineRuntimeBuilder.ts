import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AppliedMoorlineConfig,
  defaultAdminConfig,
  defaultMainProcessConfig,
  homeRootForRuntime,
  usesProviderDefaultModel,
  type MoorlineConfig
} from '../../types/config.js';
import { ensureRuntimePaths } from '../system/config/configStore.js';
import { PluginHost } from '../extension/plugins/pluginHost.js';
import { PackageInventoryStore } from '../extension/packages/packageInventoryStore.js';
import { appliedPackageRefs } from '../extension/packages/packageActivation.js';
import type { RuntimePluginContext } from '../../types/plugin.js';
import type { RuntimeActionGuard } from '../system/policy/runtimeActionGuard.js';
import { SessionLifecycleService } from '../domain/sessions/sessionLifecycleService.js';
import { SkillRegistry } from '../extension/skills/skillRegistry.js';
import { runMigrations } from '../system/state/migrationRunner.js';
import { SqliteSessionStore, type RuntimeSessionRow } from '../system/state/sqliteSessionStore.js';
import { JsonAuditLogger } from '../system/audit/auditLogger.js';
import { SessionRegistry } from '../domain/sessions/sessionState.js';
import { MemoryStore } from '../domain/memory/store.js';
import { RuntimeIngestion } from './execution/runtimeIngestion.js';
import { CommandReactor } from './execution/commandReactor.js';
import { RuntimeReceiptBus } from './execution/runtimeReceiptBus.js';
import { OrchestrationEngine } from './execution/orchestrationEngine.js';
import type { KeyedDrainableWorker } from './execution/drainableWorker.js';
import { RuntimeReceiptStore } from '../system/projection/runtimeReceiptStore.js';
import { RuntimeActivityStore, type RuntimeActivityRecord } from '../system/projection/runtimeActivityStore.js';
import { ProjectionStateStore } from '../system/projection/projectionStateStore.js';
import { PendingRequestProjectionStore } from '../system/projection/pendingRequestProjectionStore.js';
import { RuntimeSnapshotQuery } from '../system/projection/runtimeSnapshotQuery.js';
import { RuntimeReconciler } from '../system/projection/runtimeReconciler.js';
import { ProviderSessionDirectory } from './execution/providerSessionDirectory.js';
import { CanonicalEventLogStore } from '../system/state/canonicalEventLogStore.js';
import { SidecarManager } from './supervision/sidecarManager.js';
import type {
  RuntimeAttachmentPayload,
  RuntimeMessagePayload,
  RuntimeTransport,
  RuntimeActorIdentity
} from '../../types/transport.js';
import type {
  RuntimeControlRequest,
  RuntimeControlResult,
  RuntimeControlStatus
} from './supervision/runtimeControl.js';
import type { SidecarScopeKind } from './supervision/managedSidecar.js';
import { ManagementReadModelService } from '../system/projection/managementReadModelService.js';
import { RuntimeControlService } from './supervision/runtimeControlService.js';
import {
  NoopRuntimeManagementSurface,
  type RuntimeManagementSurfaceFactory,
  type RuntimeManagementSurfaceHandle
} from './hosting/runtimeManagementPort.js';
import { RuntimeWorkManagementService } from '../domain/sessions/runtimeWorkManagementService.js';
import { ManagedSpaceLifecycleService } from './lifecycle/managedSpaceLifecycleService.js';
import { RuntimeInteractionService } from './execution/runtimeInteractionService.js';
import { RuntimeTransportSurfaceService } from './hosting/runtimeTransportSurfaceService.js';
import { ProviderRequestAttributionService } from './execution/providerCoordination/providerRequestAttributionService.js';
import { ProviderAttachmentResolver } from './execution/providerOrchestration/providerAttachmentResolver.js';
import { ProviderCompactionPolicy } from './execution/providerOrchestration/providerCompactionPolicy.js';
import { ProviderEventPipeline } from './execution/providerOrchestration/providerEventPipeline.js';
import { ProviderOrchestrator } from './execution/providerOrchestration/providerOrchestrator.js';
import { ProviderRequestProjector } from './execution/providerOrchestration/providerRequestProjector.js';
import { ProviderSessionOrchestrator } from './execution/providerOrchestration/providerSessionOrchestrator.js';
import { ProviderTurnBroker } from './execution/providerOrchestration/providerTurnBroker.js';
import { providerPolicyTarget } from './execution/providerCoordination/providerPolicyTarget.js';
import { RuntimeProjectionService } from '../system/projection/runtimeProjectionService.js';
import { RuntimeOrchestrationRequestService } from './execution/runtimeOrchestrationRequestService.js';
import { RuntimeLifecycleService } from './lifecycle/runtimeLifecycleService.js';
import { PackageJobSchedulerService } from './lifecycle/packageJobSchedulerService.js';
import { RuntimePluginContextService, defaultSessionOwner } from './execution/runtimePluginContextService.js';
import { RuntimePendingRequestService } from './execution/runtimePendingRequestService.js';
import { RuntimeHostingService } from './hosting/runtimeHostingService.js';
import { resolveMoorlineAssetRoot } from './hosting/runtimeLayout.js';
import { getDefaultRuntimeEnvironmentVerifier, getDefaultRuntimeProviderFactory } from './runtimeBootstrapRegistry.js';
import { createRuntimeWorkerQueues } from './execution/runtimeWorkerQueues.js';
import {
  normalizeRuntimeReply,
  prepareProviderImages,
  pruneProviderInputImages,
  validateLocalRuntimeFiles
} from '../shared/utils/runtimeMessageUtils.js';
import type { RuntimeEnvironmentVerifier, RuntimeProvider, RuntimeProviderFactory } from '../../types/provider.js';
import type { RuntimeCommandRunner } from '../../types/runtime.js';
import { prepareMoorlineRuntimeLayout, resolveRuntimeMigrationsDir } from './graph/runtimePaths.js';

function resolveDefaultRuntimePolicyPath(runtimeRoot: string, fromUrl: string): string {
  const runtimePolicyPath = join(runtimeRoot, 'policies', 'default-secure.json');
  if (existsSync(runtimePolicyPath)) {
    return runtimePolicyPath;
  }

  const assetRoot = resolveMoorlineAssetRoot(fromUrl);
  const packagedPolicyPath = join(assetRoot, 'resources', 'policies', 'default-secure.json');
  if (existsSync(packagedPolicyPath)) {
    return packagedPolicyPath;
  }

  return join(assetRoot, 'policies', 'default-secure.json');
}

export interface MoorlineRuntimeDeps {
  config: MoorlineConfig;
  configPath?: string;
  commandRunner?: RuntimeCommandRunner;
  transport?: RuntimeTransport;
  now?: () => string;
  provider?: RuntimeProvider;
  providerFactory?: RuntimeProviderFactory;
  verifyEnvironment?: RuntimeEnvironmentVerifier;
  supervised?: boolean;
  providerTurnWaitTimeoutMs?: number;
  queueLimits?: {
    provider?: {
      maxPendingPerKey?: number;
      maxPendingTotal?: number;
    };
    command?: {
      maxPendingPerKey?: number;
      maxPendingTotal?: number;
    };
    projection?: {
      maxPendingPerKey?: number;
      maxPendingTotal?: number;
    };
    transport?: {
      maxPendingPerKey?: number;
      maxPendingTotal?: number;
    };
  };
  requestControl?: (input: RuntimeControlRequest) => Promise<RuntimeControlResult>;
  managementSurfaceFactory?: RuntimeManagementSurfaceFactory;
  managementPresentation?: import('../../types/app.js').ManagementReadModelPresentation;
}

interface MoorlineRuntimeBuilderCallbacks {
  now(): string;
  requireGuard(): RuntimeActionGuard;
  getEffectiveAdminConfig(): ReturnType<typeof defaultAdminConfig>;
  createPluginContext(actorId: string): RuntimePluginContext;
  cleanupScopedSidecars(scopeKind: SidecarScopeKind, scopeKey: string, reason: string): Promise<void>;
  runOrchestrationTurn(session: RuntimeSessionRow, actorId: string, content: string): Promise<RuntimeMessagePayload>;
  ensureChatSession(spaceId: string, cwd: string): Promise<RuntimeSessionRow>;
  isAdminActor(input: RuntimeActorIdentity): boolean;
  postTransportMessage(actor: string, spaceId: string, payload: RuntimeMessagePayload): Promise<{ id: string }>;
  sendStatusUpdate(payload: RuntimeMessagePayload): Promise<void>;
  runGuardedAction<T>(input: {
    action: Parameters<RuntimeActionGuard['run']>[0]['action'];
    actor: string;
    target?: string;
    payload?: unknown;
    threadId?: string;
    title: string;
    execute: () => Promise<T>;
  }): Promise<T>;
  requireNamespaceState(): import('../../types/config.js').RuntimeSurfaceState;
  getNamespaceState(): import('../../types/config.js').RuntimeSurfaceState | null;
  getRuntimeStatus(): {
    uptimeSeconds: number;
    openSessions: number;
    coolSessions: number;
    archivedSessions: number;
    waitingSessions: number;
    runningSessions: number;
  };
  getRuntimeControlStatus(): RuntimeControlStatus;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  recordRuntimeActivity(input: Omit<RuntimeActivityRecord, 'activityId'>): void;
  setAcceptingNewWork(accepting: boolean): void;
  setProviderAutoStartDefault(enabled: boolean): void;
  getProviderAutoStartDefault(): boolean;
  rejectTurnWaitersForThread(threadId: string, reason: string): void;
}

export interface RuntimeStateGraph {
  store: SqliteSessionStore;
  sessionRegistry: SessionRegistry;
  sessionLifecycle: SessionLifecycleService;
  memoryStore: MemoryStore;
  audit: JsonAuditLogger;
  ingestion: RuntimeIngestion;
  reactor: CommandReactor;
  receiptBus: RuntimeReceiptBus;
  activities: RuntimeActivityStore;
  pendingRequests: PendingRequestProjectionStore;
  projectionState: ProjectionStateStore;
  orchestration: OrchestrationEngine;
  snapshots: RuntimeSnapshotQuery;
  reconciler: RuntimeReconciler;
  canonicalEvents: CanonicalEventLogStore;
  projectionService: RuntimeProjectionService;
}

export interface RuntimeExtensionGraph {
  pluginHostRef: { current: PluginHost };
  pluginHost: PluginHost;
  skillRegistry: SkillRegistry;
  sidecars: SidecarManager;
  pluginContexts: RuntimePluginContextService;
}

export interface RuntimeTransportGraph {
  managedSpaceLifecycle: ManagedSpaceLifecycleService;
  interactions: RuntimeInteractionService;
  transportSurface: RuntimeTransportSurfaceService;
  hostingService: RuntimeHostingService;
}

export interface RuntimeProviderGraph {
  providerService: RuntimeProvider;
  providerDirectory: ProviderSessionDirectory;
  providerOrchestrator: ProviderOrchestrator;
}

export interface RuntimeManagementGraph {
  managementReadModel: ManagementReadModelService;
  runtimeControl: RuntimeControlService;
  workManagement: RuntimeWorkManagementService;
  managementSurface: RuntimeManagementSurfaceHandle;
  orchestrationRequests: RuntimeOrchestrationRequestService;
  lifecycleService: RuntimeLifecycleService;
  pendingRequestService: RuntimePendingRequestService;
  packageJobScheduler: PackageJobSchedulerService;
}

export interface MoorlineRuntimeServiceGraph
  extends RuntimeStateGraph,
    RuntimeExtensionGraph,
    RuntimeTransportGraph,
    RuntimeProviderGraph,
    RuntimeManagementGraph {
  deps: MoorlineRuntimeDeps;
  paths: ReturnType<typeof ensureRuntimePaths>;
  chatWorkspacePath: string;
  runtimePolicyPath: string;
  providerQueue: KeyedDrainableWorker;
  commandQueue: KeyedDrainableWorker;
  projectionQueue: KeyedDrainableWorker;
  transportQueue: KeyedDrainableWorker;
}

export function buildMoorlineRuntimeServiceGraph(
  deps: MoorlineRuntimeDeps,
  callbacks: MoorlineRuntimeBuilderCallbacks
): MoorlineRuntimeServiceGraph {
  const transport = deps.transport;
  if (!transport) {
    throw new Error('MoorlineRuntime requires a transport adapter');
  }
  if (!deps.config.transport || !deps.config.provider) {
    throw new Error('MoorlineRuntime requires an applied transport and provider configuration');
  }

  const normalizedConfig: AppliedMoorlineConfig = {
    ...deps.config,
    transport: deps.config.transport,
    provider: deps.config.provider,
    main: deps.config.main ?? defaultMainProcessConfig(),
    namespace: deps.config.surface
  };
  const normalizedDeps = { ...deps, transport, config: normalizedConfig };
  const paths = ensureRuntimePaths(normalizedConfig.runtimeRoot);
  const homeRoot = homeRootForRuntime(paths.runtimeRoot);
  const providerPackageId = normalizedConfig.provider.packageId ?? normalizedConfig.provider.kind;
  const RETENTION_POLICY = {
    runtimeEventTtlMs: 14 * 24 * 60 * 60 * 1000,
    domainEventTtlMs: 14 * 24 * 60 * 60 * 1000,
    resolvedRequestTtlMs: 14 * 24 * 60 * 60 * 1000,
    orchestrationTtlMs: 14 * 24 * 60 * 60 * 1000,
    imageTtlMs: 24 * 60 * 60 * 1000
  };
  const MAINTENANCE_MIN_INTERVAL_MS = 15 * 60 * 1000;
  let lastMaintenanceRunMs = 0;
  const chatWorkspacePath = join(paths.runtimeRoot, 'chat');
  const runtimePolicyPath = resolveDefaultRuntimePolicyPath(paths.runtimeRoot, import.meta.url);
  runMigrations(paths.sqlitePath, resolveRuntimeMigrationsDir(import.meta.url));
  const store = new SqliteSessionStore(paths.sqlitePath);
  const sessionRegistry = new SessionRegistry(store, paths.workspacesDir, providerPackageId);
  const sessionLifecycle = new SessionLifecycleService(store, {
    cooldownMinutes: 120,
    archiveAfterDays: 14
  });
  const pluginHostRef = { current: new PluginHost([]) };
  const inventory = new PackageInventoryStore(paths.runtimeRoot).load();
  const activatedPackages = appliedPackageRefs(inventory.applied);
  const enabledSkillRoots = inventory.installed
    .filter(
      (entry) => entry.surface === 'skill' && activatedPackages.some((ref) => ref.surface === 'skill' && ref.packageId === entry.packageId)
    )
    .map((entry) => join(entry.installPath, 'skills'));
  const skillRegistry = new SkillRegistry(enabledSkillRoots);
  const memoryStore = new MemoryStore(paths.runtimeRoot);
  const audit = new JsonAuditLogger(join(paths.logsDir, 'policy-audit.jsonl'));
  const providerState = new ProviderSessionDirectory(store);
  const providerService =
    deps.provider ??
    deps.providerFactory?.({ providerPackageId }) ??
    getDefaultRuntimeProviderFactory()?.({ providerPackageId });
  if (!providerService) {
    throw new Error('MoorlineRuntime requires a provider or providerFactory');
  }
  const ingestion = new RuntimeIngestion(store);
  const reactor = new CommandReactor(sessionRegistry);
  const sharedDb = store.database();
  const receiptBus = new RuntimeReceiptBus(new RuntimeReceiptStore(sharedDb));
  const activities = new RuntimeActivityStore(sharedDb);
  const pendingRequests = new PendingRequestProjectionStore(sharedDb);
  const projectionState = new ProjectionStateStore(sharedDb);
  const orchestration = new OrchestrationEngine(activities, pendingRequests);
  const providerDirectory = providerState;
  const canonicalEvents = new CanonicalEventLogStore(sharedDb);
  const sidecars = new SidecarManager({
    runtimeRoot: paths.runtimeRoot,
    store,
    now: callbacks.now,
    appendAuditEvent: callbacks.appendAuditEvent
  });
  const snapshots = new RuntimeSnapshotQuery(store, sharedDb);
  const reconciler = new RuntimeReconciler(store, snapshots);
  const { providerQueue, commandQueue, projectionQueue, transportQueue, enqueueWithDiagnostics } =
    createRuntimeWorkerQueues(normalizedDeps.queueLimits, callbacks);
  let providerOrchestrator!: ProviderOrchestrator;
  let pluginContexts!: RuntimePluginContextService;
  let managementSurface!: RuntimeManagementSurfaceHandle;

  const runtimeControl = new RuntimeControlService({
    requestControl: normalizedDeps.requestControl,
    authorize: async ({ actorId, target, reason, requestedBy }) => {
      await callbacks.requireGuard().run({
        action: 'runtime.control',
        actor: actorId,
        target,
        payload: { reason, requestedBy },
        execute: async () => undefined
      });
    },
    appendAuditEvent: callbacks.appendAuditEvent,
    now: callbacks.now,
    setAcceptingNewWork: callbacks.setAcceptingNewWork,
    setProviderAutoStartDefault: (enabled) => {
      providerOrchestrator.setProviderAutoStartDefault(enabled);
    },
    getSessionByThreadId: (threadId) => sessionRegistry.getByThreadId(threadId),
    listSessions: () => sessionRegistry.list(),
    upsertSession: (session) => {
      store.upsertSession(session);
    },
    updateSession: (session) => sessionRegistry.updateSession(session),
    stopProviderSession: (threadId) => {
      providerService.stopSession(threadId);
    },
    stopAllProviders: () => {
      providerService.stopAll();
    },
    drainProviders: async () => await providerService.drain(),
    ensureProviderSession: async (session, actorId) => await providerOrchestrator.ensureSession(session, actorId)
  });
  const workManagement = new RuntimeWorkManagementService({
    config: normalizedConfig,
    getTransport: () => transport,
    getGuard: callbacks.requireGuard,
    requireNamespaceState: callbacks.requireNamespaceState,
    sessionRegistry,
    snapshots,
    reactor,
    providerService,
    providerDirectory,
    getProviderAutoStartDefault: callbacks.getProviderAutoStartDefault,
    defaultSessionOwner,
    queue: async (key, work) => await enqueueWithDiagnostics(commandQueue, key, 'work-management', work),
    now: callbacks.now,
    postTransportMessage: async (actorId, spaceId, payload) => {
      await callbacks.postTransportMessage(actorId, spaceId, payload);
    },
    sendStatusUpdate: async (payload) => await callbacks.sendStatusUpdate(payload),
    appendAuditEvent: callbacks.appendAuditEvent,
    runOrchestrationTurn: callbacks.runOrchestrationTurn,
    rejectTurnWaitersForThread: callbacks.rejectTurnWaitersForThread,
    cleanupScopedSidecars: callbacks.cleanupScopedSidecars
  });
  const managedSpaceLifecycle = new ManagedSpaceLifecycleService({
    config: normalizedConfig,
    getNamespaceState: callbacks.getNamespaceState,
    sessionRegistry,
    providerService,
    providerDirectory,
    workManagement,
    getProviderAutoStartDefault: callbacks.getProviderAutoStartDefault,
    queue: async (key, work) => await enqueueWithDiagnostics(commandQueue, key, 'managed-work-lifecycle', work),
    now: callbacks.now,
    postTransportMessage: async (actor, spaceId, payload) => {
      await callbacks.postTransportMessage(actor, spaceId, payload);
    },
    appendAuditEvent: callbacks.appendAuditEvent,
    recordRuntimeActivity: callbacks.recordRuntimeActivity,
    rejectTurnWaitersForThread: callbacks.rejectTurnWaitersForThread,
    cleanupScopedSidecars: callbacks.cleanupScopedSidecars
  });
  const interactions = new RuntimeInteractionService({
    config: normalizedConfig,
    sessionRegistry,
    sessionLifecycle,
    snapshots,
    getPluginHost: () => pluginHostRef.current,
    queue: async (key, work) => await enqueueWithDiagnostics(commandQueue, key, 'runtime-interactions', work),
    now: callbacks.now,
    getNamespaceReady: () => callbacks.getNamespaceState() !== null,
    getAcceptingNewWork: () => callbacks.getRuntimeControlStatus().acceptingNewWork,
    postTransportMessage: async (actor, spaceId, payload) => {
      await callbacks.postTransportMessage(actor, spaceId, payload);
    },
    appendAuditEvent: callbacks.appendAuditEvent,
    createPluginContext: callbacks.createPluginContext,
    isAdminActor: callbacks.isAdminActor,
    respondToProviderRequest: async (actorId, threadId, requestId, decision, deniedTitle, metadata) =>
      await pendingRequestService.respondToProviderRequest(actorId, threadId, requestId, decision, deniedTitle, metadata),
    resolvePendingRequest: async (input) =>
      void (await pendingRequestService.resolvePendingRequest({
        actorId: input.actorId,
        requestId: input.requestId,
        decision: input.decision,
        deniedTitle: input.deniedTitle,
        metadata: input.metadata,
        requestActor: input.requestActor
      }))
  });
  const transportSurface = new RuntimeTransportSurfaceService({
    queue: async (key, work) => await enqueueWithDiagnostics(transportQueue, key, 'runtime-transport-surface', work),
    guard: callbacks.requireGuard,
    transport: () => transport,
    getNamespaceState: callbacks.getNamespaceState
  });
  const providerAttribution = new ProviderRequestAttributionService();
  const providerModelPorts = {
    configuredProviderModel: () =>
      usesProviderDefaultModel(normalizedConfig.defaults.model) ? undefined : normalizedConfig.defaults.model,
    providerPolicyTarget: (threadId: string, suffix: string) => providerPolicyTarget(normalizedConfig, threadId, suffix)
  };
  const providerGuardPort = {
    runGuardedProviderAction: callbacks.runGuardedAction
  };
  const providerAuditPort = {
    appendAuditEvent: callbacks.appendAuditEvent,
    recordRuntimeActivity: callbacks.recordRuntimeActivity
  };
  const providerSessionOrchestrator = new ProviderSessionOrchestrator({
    config: normalizedConfig,
    runtimeRoot: paths.runtimeRoot,
    provider: providerService,
    connections: providerDirectory,
    sessions: sessionRegistry,
    now: callbacks.now,
    upsertSession: (session) => store.upsertSession(session),
    setProviderAutoStartDefault: (enabled) => {
      callbacks.setProviderAutoStartDefault(enabled);
      store.putMetadata('runtime.provider.auto_start.default', enabled, callbacks.now());
    },
    ...providerModelPorts,
    ...providerGuardPort
  });
  const providerTurnBroker = new ProviderTurnBroker({
    provider: providerService,
    sessions: providerSessionOrchestrator,
    typing: transportSurface,
    attribution: providerAttribution,
    now: callbacks.now,
    turnWaitTimeoutMs: normalizedDeps.providerTurnWaitTimeoutMs,
    ...providerModelPorts,
    ...providerGuardPort,
    ...providerAuditPort
  });
  const providerRequestProjector = new ProviderRequestProjector({
    pending: {
      upsertPendingRequest: (request) => store.upsertPendingRequest(request),
      getPendingRequest: (requestId) => snapshots.getOpenRequestById(requestId) ?? store.getPendingRequest(requestId)
    },
    attribution: providerAttribution,
    postRuntimeRequestMessage: async (spaceId, request) => await pendingRequestService.postRuntimeRequestMessage(spaceId, request)
  });
  const providerAttachmentResolver = new ProviderAttachmentResolver({
    runtimeRoot: paths.runtimeRoot,
    now: callbacks.now,
    getSessionByThreadId: (threadId) => sessionRegistry.getByThreadId(threadId),
    ...providerAuditPort
  });
  const providerCompactionPolicy = new ProviderCompactionPolicy({
    provider: providerService,
    now: callbacks.now,
    getSessionByThreadId: (threadId) => sessionRegistry.getByThreadId(threadId),
    ...providerModelPorts,
    ...providerGuardPort,
    ...providerAuditPort
  });
  const providerEventPipeline = new ProviderEventPipeline({
    canonicalEvents,
    ingestion,
    receiptBus,
    compaction: providerCompactionPolicy,
    requests: providerRequestProjector,
    turns: providerTurnBroker,
    attachments: providerAttachmentResolver,
    getPluginHost: () => pluginHostRef.current,
    createPluginContext: callbacks.createPluginContext,
    getSessionByThreadId: (threadId) => sessionRegistry.getByThreadId(threadId),
    handleDomainEvent: async (event) => await projectionService.handleDomainEvent(event)
  });
  providerOrchestrator = new ProviderOrchestrator({
    provider: providerService,
    connections: providerDirectory,
    sessions: providerSessionOrchestrator,
    turns: providerTurnBroker,
    compaction: providerCompactionPolicy,
    events: providerEventPipeline
  });
  const projectionService = new RuntimeProjectionService({
    store,
    snapshots,
    ingestion,
    receiptBus,
    pendingRequests,
    projectionState,
    orchestration,
    reconciler,
    queue: async (key, work) => await enqueueWithDiagnostics(projectionQueue, key, 'runtime-projection', work),
    now: callbacks.now,
    getPluginHost: () => pluginHostRef.current,
    createPluginContext: callbacks.createPluginContext,
    sendStatusUpdate: async (payload) => await callbacks.sendStatusUpdate(payload),
    postRuntimeRequestMessage: async (spaceId, request) => await pendingRequestService.postRuntimeRequestMessage(spaceId, request),
    recordRuntimeActivity: callbacks.recordRuntimeActivity
  });
  const orchestrationRequests = new RuntimeOrchestrationRequestService({
    store,
    workManagement,
    createPluginContext: callbacks.createPluginContext,
    now: callbacks.now,
    validateLocalFiles: (
      files: RuntimeAttachmentPayload[] | undefined,
      input: { requestedByThreadId: string | null }
    ) => {
      const allowlistedRoots = [join(paths.runtimeRoot, 'chat')];
      if (input.requestedByThreadId) {
        const session = sessionRegistry.getByThreadId(input.requestedByThreadId);
        if (session?.workspacePath) {
          allowlistedRoots.push(session.workspacePath);
        }
        allowlistedRoots.push(join(paths.runtimeRoot, 'state', 'input-images', input.requestedByThreadId));
      }
      validateLocalRuntimeFiles(files, allowlistedRoots);
    },
    postTransportMessage: async (actor, spaceId, payload) => await callbacks.postTransportMessage(actor, spaceId, payload),
    onForcedDrain: (signal) => {
      callbacks.appendAuditEvent('runtime.orchestration.drain_forced', {
        timeoutMs: signal.timeoutMs,
        inFlightRequestIds: signal.inFlightRequestIds,
        oldestInFlightAgeMs: signal.oldestInFlightAgeMs,
        at: signal.at
      });
      callbacks.recordRuntimeActivity({
        threadId: 'runtime:orchestration',
        sessionId: null,
        spaceId: null,
        sourceEventId: randomUUID(),
        kind: 'runtime.orchestration.forced_drain',
        severity: 'warning',
        title: 'Forced orchestration drain',
        detail: `${signal.inFlightRequestIds.length} in-flight orchestration request(s) exceeded drain timeout ${signal.timeoutMs}ms.`,
        createdAt: callbacks.now()
      });
    }
  });
  const lifecycleService = new RuntimeLifecycleService({
    store,
    transport,
    transportScopeId: normalizedConfig.transport.scopeId,
    sessionLifecycle,
    sessionRegistry,
    requireGuard: callbacks.requireGuard,
    getNamespaceState: callbacks.getNamespaceState,
    now: callbacks.now,
    sendStatusUpdate: async (payload) => await callbacks.sendStatusUpdate(payload),
    appendAuditEvent: callbacks.appendAuditEvent,
    runMaintenance: async () => {
      const nowMs = Date.now();
      if (nowMs - lastMaintenanceRunMs < MAINTENANCE_MIN_INTERVAL_MS) {
        return;
      }
      lastMaintenanceRunMs = nowMs;
      const nowIso = callbacks.now();
      const dbStats = store.pruneRuntimeHistory({
        nowIso,
        runtimeEventTtlMs: RETENTION_POLICY.runtimeEventTtlMs,
        domainEventTtlMs: RETENTION_POLICY.domainEventTtlMs,
        resolvedRequestTtlMs: RETENTION_POLICY.resolvedRequestTtlMs,
        orchestrationTtlMs: RETENTION_POLICY.orchestrationTtlMs
      });
      const imageStats = pruneProviderInputImages({
        runtimeRoot: paths.runtimeRoot,
        nowMs,
        ttlMs: RETENTION_POLICY.imageTtlMs
      });
      store.putMetadata(
        'runtime.retention.last_prune',
        {
          lastPrunedAt: nowIso,
          policy: RETENTION_POLICY,
          stats: {
            ...dbStats,
            removedInputImageFiles: imageStats.removedFiles,
            removedInputImageDirectories: imageStats.removedDirectories
          }
        },
        nowIso
      );
      if (
        dbStats.runtimeEventsDeleted > 0 ||
        dbStats.domainEventsDeleted > 0 ||
        dbStats.resolvedRequestsDeleted > 0 ||
        dbStats.closedOrchestrationRequestsDeleted > 0 ||
        imageStats.removedFiles > 0
      ) {
        callbacks.appendAuditEvent('runtime.retention.pruned', {
          ...dbStats,
          removedInputImageFiles: imageStats.removedFiles,
          removedInputImageDirectories: imageStats.removedDirectories,
          scannedInputImageThreads: imageStats.scannedThreads
        });
      }
    },
    reportLifecycleFailure: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      callbacks.appendAuditEvent('runtime.lifecycle.tick.failed', {
        error: message
      });
      try {
        callbacks.recordRuntimeActivity({
          threadId: 'runtime:lifecycle',
          sessionId: null,
          spaceId: null,
          sourceEventId: randomUUID(),
          kind: 'runtime.lifecycle.failed',
          severity: 'error',
          title: 'Lifecycle sweep failed',
          detail: message,
          createdAt: callbacks.now()
        });
      } catch (activityError) {
        callbacks.appendAuditEvent('runtime.lifecycle.tick.failure_record.failed', {
          error: activityError instanceof Error ? activityError.message : String(activityError),
          originalError: message
        });
      }
    },
    cleanupScopedSidecars: callbacks.cleanupScopedSidecars
  });
  const packageJobScheduler = new PackageJobSchedulerService({
    store,
    getPluginHost: () => pluginHostRef.current,
    createPluginContext: callbacks.createPluginContext,
    queue: async (key, work) => await enqueueWithDiagnostics(commandQueue, key, 'package-jobs', work),
    now: callbacks.now,
    appendAuditEvent: callbacks.appendAuditEvent
  });
  const pendingRequestService = new RuntimePendingRequestService({
    store,
    snapshots,
    providerService,
    providerId: normalizedConfig.provider.packageId ?? normalizedConfig.provider.kind,
    isAdminActor: callbacks.isAdminActor,
    now: callbacks.now,
    postTransportMessage: async (actor, spaceId, payload) => await callbacks.postTransportMessage(actor, spaceId, payload),
    runGuardedAction: callbacks.runGuardedAction,
    recordRuntimeActivity: callbacks.recordRuntimeActivity
  });
  pluginContexts = new RuntimePluginContextService({
    config: normalizedConfig,
    configPath: normalizedDeps.configPath,
    runtimeRoot: paths.runtimeRoot,
    homeRoot,
    sqlitePath: paths.sqlitePath,
    chatWorkspacePath,
    store,
    sessionRegistry,
    skillRegistry,
    memoryStore,
    activities,
    projectionState,
    snapshots,
    providerService,
    canonicalEvents,
    workManagement,
    runtimeControl,
    sidecars,
    providerOrchestrator,
    getPluginHost: () => pluginHostRef.current,
    getAdminConfig: callbacks.getEffectiveAdminConfig,
    isAdminActor: callbacks.isAdminActor,
    requireNamespaceState: callbacks.requireNamespaceState,
    getNamespaceState: callbacks.getNamespaceState,
    getRuntimeStatus: callbacks.getRuntimeStatus,
    getRuntimeControlStatus: callbacks.getRuntimeControlStatus,
    ensureChatSession: callbacks.ensureChatSession,
    prepareProviderImages: async (threadId, attachments) =>
      await prepareProviderImages({
        runtimeRoot: paths.runtimeRoot,
        threadId,
        attachments
      }),
    normalizeReply: (text) => normalizeRuntimeReply(text),
    postTransportMessage: async (actor, spaceId, payload) => {
      await callbacks.postTransportMessage(actor, spaceId, payload);
    },
    appendAuditEvent: callbacks.appendAuditEvent,
    now: callbacks.now,
    runGuardedAction: callbacks.runGuardedAction,
    resolvePendingRequest: async (input) =>
      void (await pendingRequestService.resolvePendingRequest(input)),
    answerPendingRequest: async (input) =>
      void (await pendingRequestService.answerPendingRequest(input)),
    drainRuntimeWork: async () => {
      await providerQueue.drain();
      await commandQueue.drain();
      await projectionQueue.drain();
      await transportQueue.drain();
      await orchestrationRequests.drain();
    }
  });
  const managementReadModel = new ManagementReadModelService({
    homeRoot,
    runtimeRoot: paths.runtimeRoot,
    config: normalizedConfig,
    snapshots,
    skills: skillRegistry,
    provider: providerService,
    sidecars,
    now: callbacks.now,
    getRuntimeControlStatus: callbacks.getRuntimeControlStatus,
    getRuntimeStatus: callbacks.getRuntimeStatus,
    getNamespaceState: callbacks.getNamespaceState,
    getManagementSurface: () => managementSurface.getSurfaceState(),
    getPluginHost: () => pluginHostRef.current,
    createPluginContext: callbacks.createPluginContext,
    getRuntimeWorkerQueues: () => [providerQueue.getStats(), commandQueue.getStats(), projectionQueue.getStats(), transportQueue.getStats()],
    ...(normalizedDeps.managementPresentation ? { presentation: normalizedDeps.managementPresentation } : {})
  });
  managementSurface = normalizedDeps.managementSurfaceFactory?.create({
    config: normalizedConfig,
    configPath: normalizedDeps.configPath,
    managementReadModel,
    createPluginContext: callbacks.createPluginContext,
    requestSetRuntimeAcceptingNewWork: async (input) => await runtimeControl.requestSetRuntimeAcceptingNewWork(input),
    requestRuntimeReload: async (input) => await runtimeControl.requestRuntimeReload(input),
    requestStopProviderSessions: async (input) => await runtimeControl.requestStopProviderSessions(input),
    requestStartProviderSessions: async (input) => await runtimeControl.requestStartProviderSessions(input)
  }) ?? new NoopRuntimeManagementSurface();
  const hostingService = new RuntimeHostingService({
    config: normalizedConfig,
    transport,
    managementSurface,
    installationPath: paths.installationPath,
    now: callbacks.now,
    verifyEnvironment: normalizedDeps.verifyEnvironment ?? getDefaultRuntimeEnvironmentVerifier() ?? undefined,
    authorizeTransportSetup: async ({ target, execute }) =>
      await callbacks.requireGuard().run({
        action: 'transport.action.register',
        actor: 'runtime:transport/register-commands',
        target,
        execute
      })
  });
  receiptBus.on('quiesced', (receipt) => {
    providerOrchestrator.flushThread(receipt.threadId);
  });
  mkdirSync(chatWorkspacePath, { recursive: true });

  return {
    deps: normalizedDeps,
    paths,
    chatWorkspacePath,
    runtimePolicyPath,
    store,
    sessionRegistry,
    sessionLifecycle,
    pluginHostRef,
    pluginHost: pluginHostRef.current,
    skillRegistry,
    memoryStore,
    audit,
    providerService,
    ingestion,
    reactor,
    receiptBus,
    activities,
    pendingRequests,
    projectionState,
    orchestration,
    snapshots,
    reconciler,
    providerDirectory,
    canonicalEvents,
    sidecars,
    managementReadModel,
    runtimeControl,
    workManagement,
    managedSpaceLifecycle,
    interactions,
    transportSurface,
    providerOrchestrator,
    projectionService,
    managementSurface,
    hostingService,
    orchestrationRequests,
    lifecycleService,
    pendingRequestService,
    packageJobScheduler,
    pluginContexts,
    providerQueue,
    commandQueue,
    projectionQueue,
    transportQueue
  };
}

export async function prepareRuntimeLayout(runtimeRoot: string): Promise<void> {
  await prepareMoorlineRuntimeLayout(runtimeRoot, import.meta.url);
}
