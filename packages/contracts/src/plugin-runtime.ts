import type { Capability } from './capabilities.js';
import type { JsonSchemaLike } from './package.js';
import type { PluginManifest, RuntimeManagementContribution } from './plugin.js';
import type { RuntimeProviderTestResult } from './provider.js';
import type {
  RuntimeActionDefinition,
  RuntimeActorIdentity,
  RuntimeAttachmentPayload,
  RuntimeMessagePayload,
  RuntimeSurfaceState,
  RuntimeTransportEvent
} from './transport.js';
import type {
  PendingRuntimeRequestRecord,
  ProviderRuntimeEvent,
  ProviderSessionStatus,
  ProviderThreadTokenUsage,
  RuntimeModeName
} from './runtime.js';
import type {
  RuntimeExternalResourceRecord,
  RuntimeExternalResourceRef,
  RuntimeGateRunRecord,
  RuntimeHeadlessRunResult,
  RuntimeWorkItemRecord,
  RuntimeWorkItemStatus
} from './external.js';

export interface RuntimeDomainEvent {
  eventId: string;
  threadId: string;
  transportResourceId?: string | null;
  sessionId?: string | null;
  sourceProviderEventId?: string | null;
  createdAt: string;
  type: string;
  payload?: unknown;
}

export interface RuntimeActionDispatchResult {
  handled: boolean;
  reply?: RuntimeMessagePayload;
  audit?: {
    event: string;
    payload?: Record<string, unknown>;
  };
  continueDispatch?: boolean;
}

export interface RuntimeToolResult {
  content: string;
}

export interface SkillCatalogEntry {
  name: string;
  description?: string;
  tags?: string[];
}

export interface LoadedSkill extends SkillCatalogEntry {
  body?: string;
}

export interface WrittenSkillResult {
  skillDir: string;
  skillPath: string;
  resourcePaths: string[];
}

export type RuntimeEntityRecord = {
  id?: string;
  sessionId?: string;
  threadId?: string;
  transportResourceId?: string;
  name?: string;
  title?: string;
  status?: string;
  lifecycleStatus?: string;
  runtimeMode?: RuntimeModeName;
};

export type SessionLifecycleStatus = 'hot' | 'cool' | 'archived';

export type RuntimeSessionRow = RuntimeEntityRecord & {
  sessionId: string;
  scopeId: string;
  threadId: string;
  transportResourceId: string;
  transportResourceName: string;
  workspacePath: string;
  summary: string | null;
  provider: string;
  providerThreadId: string | null;
  resumeThreadId: string | null;
  providerStatus: ProviderSessionStatus;
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  archivedAt: string | null;
  lastError: string | null;
  lifecycleStatus: SessionLifecycleStatus;
  runtimeMode: RuntimeModeName;
};

export interface RuntimeReceiptRecord {
  threadId: string;
  sessionId: string | null;
  transportResourceId: string | null;
  state: string;
  updatedAt: string;
}

export interface RuntimeActivityRecord {
  id?: string;
  threadId?: string;
  type?: string;
  createdAt?: string;
}

export interface RuntimeProviderConnectionSnapshot {
  threadId: string;
  providerPackageId: string;
  runtimeMode: RuntimeModeName;
  workspacePath: string;
  providerThreadId: string | null;
  status: ProviderSessionStatus;
  model: string | null;
  accountLabel: string | null;
  availableModels: string[];
  updatedAt: string;
  lastError: string | null;
  tokenUsage?: ProviderThreadTokenUsage;
  capabilityMetadata: Record<string, unknown>;
}

export interface RuntimeSessionSnapshot {
  session: RuntimeSessionRow;
  receipt: RuntimeReceiptRecord | null;
  provider: RuntimeProviderConnectionSnapshot | null;
  pendingRequests: PendingRuntimeRequestRecord[];
  recentActivities: RuntimeActivityRecord[];
}

export interface RuntimeOverviewSnapshot {
  sessions: RuntimeSessionSnapshot[];
  receipts: RuntimeReceiptRecord[];
  providers: RuntimeProviderConnectionSnapshot[];
  projectionStates: Array<{
    projector: string;
    lastEventId: string | null;
    lastAppliedAt: string;
    failure: string | null;
  }>;
  openRequests: PendingRuntimeRequestRecord[];
}

export type RuntimeReloadMode = 'graceful' | 'force';

export interface RuntimeControlStatus {
  acceptingNewWork: boolean;
  reloadInProgress?: boolean;
  providerRunning?: boolean;
}

export interface RuntimeControlResult {
  accepted: boolean;
  detail?: string;
}

export interface ProviderControlResult {
  ok: boolean;
  action: 'start' | 'stop';
  scope: 'all' | 'thread';
  threadId: string | null;
  requestedCount: number;
  affectedCount: number;
  skippedCount: number;
  failures: Array<{ threadId: string; error: string }>;
  message: string;
  remediation?: string;
}

export type SessionInventoryScope = 'active' | 'archived' | 'all' | string;
export type SidecarScopeKind = 'global' | 'session' | 'ephemeral';
export type SidecarReadinessProbe =
  | { kind: 'none' }
  | {
      kind: 'stdio';
      pattern: string;
      stream?: 'stdout' | 'stderr' | 'both';
      timeoutMs?: number;
    };

export type ManagedSidecarScope =
  | { kind: 'global' }
  | { kind: 'session'; key: string }
  | { kind: 'ephemeral'; key: string };

export interface ManagedSidecarLaunchSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  restart?: {
    policy?: 'never' | 'on-failure';
    maxRestarts?: number;
  };
  readiness?: SidecarReadinessProbe;
}

export interface ManagedSidecarDefinition {
  name: string;
  scope: ManagedSidecarScope;
  launch: ManagedSidecarLaunchSpec;
}

export interface ManagedSidecarRecord {
  id?: string;
  sidecarId?: string;
  instanceId?: string;
  pluginId?: string;
  name: string;
  scopeKind: SidecarScopeKind;
  scopeKey: string;
  status: string;
}

export type AgentSurface = 'coordination' | 'session';

export interface BeforeAgentPromptInput {
  surface: AgentSurface;
  transportResourceId: string;
  actorId: string;
  actorLabel: string;
  text: string;
  attachments?: RuntimeAttachmentPayload[];
  session: RuntimeSessionRow | null;
}

export interface AfterAgentResponseInput extends BeforeAgentPromptInput {
  replyMessage: string;
}

export interface CreatedSessionResult {
  session: RuntimeSessionRow;
  transportResourceId: string;
}

export type ArchivedTransportResourceTarget = { kind: 'session'; session: RuntimeSessionRow };

export type SessionOwnerKind = string;

export interface SessionOwnerLink {
  kind: SessionOwnerKind;
  id: string;
  label?: string;
}

export interface RuntimePackageStateRecord<T = unknown> {
  packageId: string;
  key: string;
  value: T | null;
  updatedAt: string;
}

export interface RuntimePackageJobRecord {
  packageId: string;
  jobId: string;
  actionId: string;
  schedule: string;
  scheduleAnchorAt: string;
  nextRunAt: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SessionQueryFilter {
  scope?: SessionInventoryScope;
  lifecycleStatuses?: RuntimeSessionRow['lifecycleStatus'][];
  runtimeModes?: RuntimeModeName[];
  ownerKind?: SessionOwnerKind;
  ownerId?: string;
  tag?: string;
  objectiveText?: string;
  waitStates?: Array<'idle' | 'running' | 'waiting_for_approval' | 'waiting_for_input' | 'completed' | 'failed' | 'interrupted' | 'cancelled'>;
  includeArchived?: boolean;
  limit?: number;
}

export interface RetrievedMemorySnippet {
  id: string;
  content: string;
  sourceRefs: string[];
  strategy: 'symbolic' | 'semantic' | 'metadata';
}

export interface RuntimePluginAdminConfig {
  accessGroupIds: string[];
  userIds: string[];
  allowTransportAdmin?: boolean;
  managedAdminAccessGroup: {
    enabled: boolean;
    name: string;
  };
  managedMemberAccessGroup: {
    enabled: boolean;
    name: string;
  };
}

export type RuntimePluginConfig = object;
export type RuntimePluginSurfaceState = RuntimeSurfaceState;

export interface RuntimeToolContext {
  readonly actorId: string;
  readonly config: RuntimePluginConfig;
  getCurrentTransportResourceId(): string;
  getCurrentThreadId(): string;
  getCurrentWorkspacePath(): string;
  getCoordinationWorkspacePath(): string;
  getRuntimeRootPath(): string;
  listSkills(): SkillCatalogEntry[];
  loadSkill(name: string): Promise<LoadedSkill | null>;
  writeSkill(input: {
    name: string;
    description?: string;
    tags?: string[];
    body: string;
    directoryName?: string;
    resourceFiles?: Array<{ path: string; content: string }>;
  }): Promise<WrittenSkillResult>;
  listSessions(): RuntimeSessionRow[];
  getSessionByTransportResourceId(transportResourceId: string): RuntimeSessionRow | null;
  getSessionById(sessionId: string): RuntimeSessionRow | null;
  getPackageState<T = unknown>(key: string): T | null;
  putPackageState<T = unknown>(key: string, value: T): Promise<void>;
  deletePackageState(key: string): Promise<void>;
  listPackageState<T = unknown>(prefix?: string): RuntimePackageStateRecord<T>[];
  schedulePackageJob(input: {
    jobId: string;
    actionId: string;
    schedule: string;
    startTime?: string;
    payload?: Record<string, unknown>;
  }): Promise<RuntimePackageJobRecord>;
  cancelPackageJob(jobId: string): Promise<RuntimePackageJobRecord | null>;
  listPackageJobs(): RuntimePackageJobRecord[];
  enqueueWorkItem(input: {
    queue: string;
    workItemId?: string;
    idempotencyKey?: string;
    externalResource?: RuntimeExternalResourceRef;
    payload?: Record<string, unknown>;
    priority?: number;
    runAfter?: string | null;
    maxAttempts?: number;
  }): Promise<RuntimeWorkItemRecord>;
  claimWorkItem(input: {
    queue: string;
    leaseSeconds?: number;
    leaseOwner?: string;
  }): Promise<RuntimeWorkItemRecord | null>;
  completeWorkItem(input: { workItemId: string; phase?: string }): Promise<RuntimeWorkItemRecord>;
  failWorkItem(input: {
    workItemId: string;
    error: string;
    retryAfter?: string | null;
    phase?: string;
  }): Promise<RuntimeWorkItemRecord>;
  deadLetterWorkItem(input: { workItemId: string; reason: string; phase?: string }): Promise<RuntimeWorkItemRecord>;
  updateWorkItem(input: {
    workItemId: string;
    payload?: Record<string, unknown>;
    phase?: string;
    externalResource?: RuntimeExternalResourceRef;
    sessionId?: string;
  }): Promise<RuntimeWorkItemRecord>;
  getWorkItem(workItemId: string): RuntimeWorkItemRecord | null;
  listWorkItems(filter?: {
    queue?: string;
    status?: RuntimeWorkItemStatus;
    externalResource?: RuntimeExternalResourceRef;
    limit?: number;
  }): RuntimeWorkItemRecord[];
  upsertExternalResource(input: RuntimeExternalResourceRef & { state?: string }): Promise<RuntimeExternalResourceRecord>;
  listExternalResources(filter?: { provider?: string; kind?: string; limit?: number }): RuntimeExternalResourceRecord[];
  bindSessionToExternalResource(input: {
    sessionId: string;
    externalResource: RuntimeExternalResourceRef;
    relationship?: string;
  }): Promise<void>;
  listSessionsForExternalResource(resource: RuntimeExternalResourceRef): RuntimeSessionSnapshot[];
  runGate(input: {
    gateId: string;
    command: string;
    args?: string[];
    cwd?: string;
    required?: boolean;
    workItemId?: string;
    sessionId?: string;
  }): Promise<RuntimeGateRunRecord>;
  runHeadless(input: {
    requestedName: string;
    runtimeMode: RuntimeModeName;
    prompt: string;
    objective?: string;
    owner?: SessionOwnerLink;
    tags?: string[];
    externalResource?: RuntimeExternalResourceRef;
    workItemId?: string;
    outputSchema?: JsonSchemaLike;
    requireStructuredOutput?: boolean;
  }): Promise<RuntimeHeadlessRunResult>;
  querySessions(filter?: SessionQueryFilter): RuntimeSessionSnapshot[];
  createSession(input: {
    requestedName: string;
    runtimeMode: RuntimeModeName;
    initialInstruction?: string;
    objective?: string;
    owner?: SessionOwnerLink;
    tags?: string[];
    externalResource?: RuntimeExternalResourceRef;
    workItemId?: string;
  }): Promise<CreatedSessionResult>;
  directSession(input: {
    sessionId?: string;
    transportResourceId?: string;
    instruction: string;
    reason?: string;
  }): Promise<{
    session: RuntimeSessionRow;
    reply: RuntimeMessagePayload;
  }>;
  archiveSession(input: { transportResourceId: string; sessionId?: string }): Promise<RuntimeSessionRow | null>;
  deleteArchivedSession(input: { transportResourceId: string; sessionId?: string }): Promise<RuntimeSessionRow | null>;
  sendMessage(transportResourceId: string, payload: RuntimeMessagePayload): Promise<void>;
  sendStatusUpdate(payload: RuntimeMessagePayload): Promise<void>;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  nowIso(): string;
}

export interface RuntimePluginAdminCapability {
  getAdminConfig(): RuntimePluginAdminConfig;
  isAdminActor(input: RuntimeActorIdentity): boolean;
  getSurfaceState(): RuntimePluginSurfaceState;
}

export interface RuntimePluginObservabilityCapability {
  listPendingRequests(transportResourceId: string): PendingRuntimeRequestRecord[];
  listRuntimeReceipts(): RuntimeReceiptRecord[];
  listProviderConnections(): RuntimeProviderConnectionSnapshot[];
  listRuntimeActivities(threadId?: string): RuntimeActivityRecord[];
  getSessionSnapshotByTransportResourceId(transportResourceId: string): RuntimeSessionSnapshot | null;
  getSessionSnapshotById(sessionId: string): RuntimeSessionSnapshot | null;
  getRuntimeOverview(): RuntimeOverviewSnapshot;
  listProjectionStates(): Array<{
    projector: string;
    lastEventId: string | null;
    lastAppliedAt: string;
    failure: string | null;
  }>;
  getProviderDiagnostics(): {
    accountLabel: string | null;
    availableModels: string[];
    connectedSessions: number;
    statusCounts: Record<string, number>;
    capabilityMetadata: Record<string, unknown>;
  };
  getDefaultModel(): string;
  setDefaultModel(model: string): Promise<void>;
  getRuntimeStatus(): {
    uptimeSeconds: number;
    openSessions: number;
    coolSessions: number;
    archivedSessions: number;
    waitingSessions: number;
    runningSessions: number;
  };
  listRuntimeEvents(threadId: string): ProviderRuntimeEvent[];
  listDomainEvents(threadId: string): RuntimeDomainEvent[];
  updateSessionSummary(transportResourceId: string, summary: string, nowIso: string): Promise<void>;
}

export interface RuntimePluginMemoryCapability {
  retrieveMemory(input: {
    query: string;
    scopeId: string;
    transportResourceId?: string;
    threadId?: string | null;
    maxResults?: number;
    enableRerank?: boolean;
  }): Promise<RetrievedMemorySnippet[]>;
  writeSessionMemory(input: {
    scopeId: string;
    transportResourceId: string;
    threadId?: string | null;
    kind: 'log' | 'summary' | 'facts' | 'tasks';
    content: string;
    sourceRefs: string[];
  }): Promise<void>;
  writeServerMemory(input: {
    scopeId: string;
    kind: 'facts' | 'tasks';
    content: string;
    sourceRefs: string[];
  }): Promise<void>;
  writeProjectMemory(input: {
    projectKey?: string;
    kind: 'facts' | 'tasks';
    content: string;
    sourceRefs: string[];
  }): Promise<void>;
}

export interface RuntimePluginWorkManagementCapability {
  archiveTransportResourceTarget(input: { transportResourceId: string }): Promise<ArchivedTransportResourceTarget | null>;
  deleteArchivedTransportResourceTarget(input: { transportResourceId: string }): Promise<ArchivedTransportResourceTarget | null>;
  respondToRuntimeRequest(input: {
    threadId: string;
    requestId: string;
    decision: 'accept' | 'decline' | 'cancel';
    requesterActor?: RuntimeActorIdentity;
  }): Promise<void>;
  respondToRuntimeUserInput(input: {
    threadId: string;
    requestId: string;
    answers: Record<string, string | string[]>;
    requesterActor?: RuntimeActorIdentity;
  }): Promise<void>;
  cancelRuntimeRequest(input: {
    threadId: string;
    requestId: string;
    requestType: PendingRuntimeRequestRecord['requestType'];
    requesterActor?: RuntimeActorIdentity;
  }): Promise<void>;
  interruptTurn(input: { threadId: string }): Promise<void>;
}

export interface RuntimePluginRuntimeControlCapability {
  getRuntimeControlStatus(): RuntimeControlStatus;
  requestRuntimeReload(input: { mode: RuntimeReloadMode; reason: string; requestedBy: RuntimeActorIdentity }): Promise<RuntimeControlResult>;
  setRuntimeAcceptingNewWork(input: {
    accepting: boolean;
    reason: string;
    requestedBy: RuntimeActorIdentity;
  }): Promise<void>;
  testProvider(input: { sendTurn?: boolean; prompt?: string; reason: string; requestedBy: RuntimeActorIdentity }): Promise<RuntimeProviderTestResult>;
  stopProvider(input: { threadId?: string; reason: string; requestedBy: RuntimeActorIdentity }): Promise<ProviderControlResult>;
  startProvider(input: { threadId?: string; reason: string; requestedBy: RuntimeActorIdentity }): Promise<ProviderControlResult>;
}

export interface RuntimePluginSidecarCapability {
  ensureSidecar(input: Omit<ManagedSidecarDefinition, 'pluginId'>): Promise<ManagedSidecarRecord>;
  stopSidecar(input: { name: string; scopeKind: SidecarScopeKind; scopeKey: string }): Promise<ManagedSidecarRecord | null>;
  listSidecars(filter?: {
    pluginId?: string;
    scopeKind?: SidecarScopeKind;
    scopeKey?: string;
    status?: ManagedSidecarRecord['status'];
  }): ManagedSidecarRecord[];
}

export interface RuntimePluginAgentCapability {
  runAgent(input: {
    surface: AgentSurface;
    transportResourceId: string;
    actorId: string;
    actorLabel: string;
    text: string;
    attachments?: RuntimeAttachmentPayload[];
    session: RuntimeSessionRow | null;
    cwd: string;
    runtimeMode: RuntimeModeName;
    basePromptSections: string[];
    promptSource?: string;
  }): Promise<RuntimeMessagePayload>;
  drainRuntimeWork(): Promise<void>;
}

export type RuntimePluginContext = RuntimeToolContext &
  RuntimePluginAdminCapability &
  RuntimePluginObservabilityCapability &
  RuntimePluginMemoryCapability &
  RuntimePluginWorkManagementCapability &
  RuntimePluginRuntimeControlCapability &
  RuntimePluginSidecarCapability &
  RuntimePluginAgentCapability;

export interface RuntimeToolDefinition {
  pluginId?: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  requiredCapability?: Capability;
  execute(input: Record<string, unknown>, context: RuntimeToolContext): Promise<RuntimeToolResult> | RuntimeToolResult;
}

export interface RuntimePlugin {
  readonly id: string;
  readonly manifest: PluginManifest;
  actions?(context: RuntimePluginContext): RuntimeActionDefinition[];
  managementContributions?(context: RuntimePluginContext): RuntimeManagementContribution[];
  tools?(context: RuntimeToolContext): RuntimeToolDefinition[];
  onRuntimeStarted?(context: RuntimePluginContext): Promise<void> | void;
  onTransportEvent?(
    event: RuntimeTransportEvent,
    context: RuntimePluginContext
  ): Promise<RuntimeActionDispatchResult | boolean | void> | RuntimeActionDispatchResult | boolean | void;
  onExternalEvent?(
    event: Extract<RuntimeTransportEvent, { type: 'external.event.received' }>,
    context: RuntimePluginContext
  ): Promise<RuntimeActionDispatchResult | boolean | void> | RuntimeActionDispatchResult | boolean | void;
  onAction?(
    event: Extract<RuntimeTransportEvent, { type: 'action.invoked' }>,
    context: RuntimePluginContext
  ): Promise<RuntimeActionDispatchResult | boolean | void> | RuntimeActionDispatchResult | boolean | void;
  onRuntimeEvent?(event: ProviderRuntimeEvent, context: RuntimePluginContext): Promise<void> | void;
  beforeAgentPrompt?(input: BeforeAgentPromptInput, context: RuntimePluginContext): Promise<string[]> | string[];
  afterAgentResponse?(input: AfterAgentResponseInput, context: RuntimePluginContext): Promise<void> | void;
  onDomainEvent?(event: RuntimeDomainEvent, context: RuntimePluginContext): Promise<void> | void;
  onRuntimeReceipt?(receipt: RuntimeReceiptRecord, context: RuntimePluginContext): Promise<void> | void;
  onRuntimeActivity?(activity: RuntimeActivityRecord, context: RuntimePluginContext): Promise<void> | void;
}

export type RuntimeActionPlugin = RuntimePlugin;
export type RuntimeToolPlugin = RuntimePlugin;
