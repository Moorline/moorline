import type { RuntimeProviderDiagnostics } from './provider.js';
import type { RuntimeModeName } from './runtime.js';
import type { RuntimeSurfaceState } from './config.js';
import type { HistoryEntry, HistoryStatus } from './history.js';
import type { JsonSchemaLike, PackageApplyPlan, PackageKind, PackageSurface } from './package.js';
import type { RuntimeManagementContribution } from './plugin.js';
import type { MoorlineReleaseManifest, MoorlineRuntimeMode, RuntimePackageLoadFailure } from './release.js';

export interface RuntimeControlStatus {
  acceptingNewWork: boolean;
  supervised: boolean;
}

export type SidecarScopeKind = 'global' | 'session' | 'ephemeral';
export type SidecarRestartPolicy = 'never' | 'on-failure';

export type ManagedObjectKind =
  | 'session'
  | 'mission'
  | 'plugin'
  | 'skill'
  | 'service'
  | 'pending_request'
  | 'provider_thread'
  | 'sidecar';

export type ManagedObjectTrustLevel = 'official' | 'local' | 'operator';

export interface ManagedObjectMutability {
  editable: boolean;
  installable: boolean;
  removable: boolean;
}

export interface ManagedObjectTrust {
  level: ManagedObjectTrustLevel;
  source: string;
}

export interface ManagedObjectSourceOfTruth {
  kind: 'sqlite' | 'filesystem' | 'runtime' | 'provider' | 'transport';
  label: string;
  path?: string;
}

export interface ManagedObjectRuntimeState {
  status: string;
  updatedAt: string | null;
  details?: Record<string, unknown>;
}

export interface ManagedObjectBase {
  id: string;
  kind: ManagedObjectKind;
  name: string;
  summary: string | null;
  controls: string[];
  mutability: ManagedObjectMutability;
  trust: ManagedObjectTrust;
  sourceOfTruth: ManagedObjectSourceOfTruth;
  runtimeState: ManagedObjectRuntimeState;
}

export interface ManagementSessionOwner {
  kind: string;
  id: string;
  label: string | null;
}

export interface ManagedSessionRecord extends ManagedObjectBase {
  spaceId: string;
  threadId: string;
  lifecycleStatus: 'hot' | 'cool' | 'archived';
  runtimeMode: RuntimeModeName;
  objective: string | null;
  tags: string[];
  owner: ManagementSessionOwner | null;
  waitState:
    | 'idle'
    | 'running'
    | 'waiting_for_approval'
    | 'waiting_for_input'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'cancelled';
  providerStatus: string | null;
  pendingRequestCount: number;
  recentActivityCount: number;
}

export interface ManagedMissionRecord extends ManagedObjectBase {
  spaceId: string;
  threadId: string;
  lifecycleStatus: string;
  runtimeMode: RuntimeModeName;
  goal: string;
  scheduleText: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  pausedAt: string | null;
  archivedAt: string | null;
}

export interface ManagedPluginRecord extends ManagedObjectBase {
  pluginId: string;
  version: string;
  pluginType: string;
  capabilities: string[];
  hooks: string[];
  commands: string[];
  packageGroup: 'official' | 'local';
}

export interface ManagedSkillRecord extends ManagedObjectBase {
  skillName: string;
  tags: string[];
  metadata: Record<string, string | string[]>;
}

export interface ManagedServiceRecord extends ManagedObjectBase {
  serviceType: 'runtime' | 'transport' | 'provider' | 'management' | 'storage' | 'audit';
}

export interface ManagedPendingRequestRecord extends ManagedObjectBase {
  threadId: string;
  spaceId: string;
  requestType: string;
  requesterUserId: string | null;
  createdAt: string;
  detail: string | null;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{
      label: string;
      description: string;
    }>;
  }>;
}

export interface ManagedProviderThreadRecord extends ManagedObjectBase {
  threadId: string;
  spaceId: string | null;
  providerThreadId: string | null;
  runtimeMode: RuntimeModeName;
  model: string | null;
}

export interface ManagedSidecarSummary extends ManagedObjectBase {
  pluginId: string;
  scopeKind: SidecarScopeKind;
  scopeKey: string;
  command: string;
  args: string[];
  restartPolicy: SidecarRestartPolicy;
  restartCount: number;
  pid: number | null;
  startedAt: string | null;
  readyAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
}

export interface ManagementSettingsContract {
  defaults: {
    runtimeMode: 'full-access' | 'approval-required';
    model: string;
  };
  transport: {
    kind: string;
    packageId?: string;
    scopeId: string;
    config: Record<string, unknown>;
  };
  provider: {
    kind: string;
    packageId?: string;
    config: Record<string, unknown>;
  };
  admin: {
    explicitAccessGroupCount: number;
    explicitUserCount: number;
    allowTransportAdmin: boolean;
    managedRole: {
      enabled: boolean;
      name: string;
    };
    managedUserRole: {
      enabled: boolean;
      name: string;
    };
  };
}

export interface ManagementApiTrustContract {
  authMode: 'bearer-token';
  loopbackOnly: boolean;
  tokenSource: 'local-connection-record' | 'operator-provided';
  restartBehavior: 'adapter-restart-required';
}

export interface ManagementApiDeliveryTrack {
  id: 'install' | 'onboarding' | 'lifecycle' | 'trust' | 'updates' | 'app_shell';
  title: string;
  summary: string;
  status: 'implemented' | 'defined';
}

export interface ManagementApiRecoveryAction {
  need: string;
  localAction: string;
  fallback: string;
}

export interface ManagementApiContract {
  readableResources: string[];
  writableActions: string[];
  trust: ManagementApiTrustContract;
  navigation: string[];
  deliveryTracks: ManagementApiDeliveryTrack[];
  recoveryActions: ManagementApiRecoveryAction[];
}

export interface ManagementInstallContract {
  packageTargets: Array<{
    platform: 'macos' | 'windows' | 'linux';
    format: string;
    launcher: string;
    autoOpenLocalUi: boolean;
  }>;
  installedComponents: string[];
  uninstallBehavior: string;
}

export interface ManagementOnboardingContract {
  steps: string[];
  requiredInputs: string[];
  prerequisiteChecks: string[];
  completionState: string;
}

export interface ManagementLifecycleContract {
  clientDisconnectBehavior: string;
  runtimeStopBehavior: string;
  startAtLogin: 'planned' | 'manual';
  backgroundMode: string;
  failureRecovery: string;
}

export interface ManagementUpdateContract {
  appUpdates: string;
  officialPackageUpdates: string;
  localPackageHandling: string;
  operatorTrigger: string;
}

export interface ManagementProviderAlignment {
  status: 'aligned' | 'partial';
  supportedCapabilities: string[];
  supportedMethods: string[];
  surfacedManagementAreas: string[];
  intentionalLimits: string[];
}

export interface ManagementOrchestrationHealthRecord {
  openRequests: number;
  runningRequests: number;
  pendingRequests: number;
  staleRunningRequests: number;
  oldestOpenAgeMs: number;
  oldestRunningAgeMs: number;
  inFlightRequests: number;
  staleRunningThresholdMs: number;
}

export interface ManagementActiveTurnHealthRecord {
  activeTurns: number;
  staleActiveTurns: number;
  oldestActiveTurnAgeMs: number;
  staleActiveTurnThresholdMs: number;
}

export interface ManagementRuntimeWorkerQueueHealthRecord {
  name: string;
  pendingTotal: number;
  keysWithPending: number;
  maxPendingPerKey: number;
  maxPendingTotal: number;
  oldestPendingAgeMs: number;
}

export interface ManagementRuntimeRetentionHealthRecord {
  lastPrunedAt: string;
  policy: {
    runtimeEventTtlMs: number;
    domainEventTtlMs: number;
    resolvedRequestTtlMs: number;
    orchestrationTtlMs: number;
    imageTtlMs: number;
  };
  stats: {
    runtimeEventsDeleted: number;
    domainEventsDeleted: number;
    resolvedRequestsDeleted: number;
    closedOrchestrationRequestsDeleted: number;
    removedInputImageFiles: number;
    removedInputImageDirectories: number;
  };
}

export interface ManagementReadModelPresentation {
  productDirection: string;
  setupReadyNextAction: string;
  setupIncompleteNextAction: string;
  contract: ManagementApiContract;
  delivery: {
    install: ManagementInstallContract;
    onboarding: ManagementOnboardingContract;
    lifecycle: ManagementLifecycleContract;
    updates: ManagementUpdateContract;
  };
}

export interface ManagementInstalledPackageRecord {
  kind: PackageKind;
  surface: PackageKind;
  packageId: string;
  name: string;
  version: string;
  description: string | null;
  installedAt: string;
  installPath: string;
  sourceLabel: string;
  dependencies: string[];
  members?: string[];
  installedByPackageIds?: string[];
  selected: boolean;
  enabled: boolean;
  activationState: 'activated' | 'deactivated';
  activationUniqueKey: string | null;
}

export interface ManagementPackageConfigField {
  key: string;
  title: string;
  description: string | null;
  type: 'string' | 'boolean' | 'number';
  required: boolean;
  secret: boolean;
  defaultValue: string | boolean | number | null;
  enumValues: Array<string | boolean | number>;
  value: string | boolean | number | null;
  configured: boolean;
}

export interface ManagementPackageConfigRecord {
  surface: PackageSurface;
  packageId: string;
  selected: boolean;
  enabled: boolean;
  active: boolean;
  activationState: 'activated' | 'deactivated';
  activationUniqueKey: string | null;
  schema: JsonSchemaLike | null;
  fields: ManagementPackageConfigField[];
}

export interface ManagementReadModel {
  generatedAt: string;
  product: {
    runtimeName: 'Moorline';
    managementName: 'Moorline';
    direction: string;
  };
  contract: ManagementApiContract;
  delivery: {
    install: ManagementInstallContract;
    onboarding: ManagementOnboardingContract;
    lifecycle: ManagementLifecycleContract;
    updates: ManagementUpdateContract;
  };
  setup: {
    runtimeRoot: string;
    installationStatePath: string;
    namespaceBootstrapped: boolean;
    providerConnected: boolean;
    readyForSessions: boolean;
    nextAction: string;
    completed: boolean;
  };
  settings: ManagementSettingsContract;
  namespace: RuntimeSurfaceState | null;
  runtime: {
    status: ReturnType<ManagementRuntimeStatusProvider>;
    control: RuntimeControlStatus;
    release: {
      mode: MoorlineRuntimeMode;
      assetRoot: string;
      manifest: MoorlineReleaseManifest;
    };
    managementSurface: {
      enabled: boolean;
      host: string;
      port: number;
      url: string | null;
      authMode: 'bearer-token';
    };
  };
  provider: {
    diagnostics: RuntimeProviderDiagnostics;
    alignment: ManagementProviderAlignment;
  };
  packages: {
    installed: ManagementInstalledPackageRecord[];
    config: ManagementPackageConfigRecord[];
    applyPlan: PackageApplyPlan;
  };
  diagnostics: {
    auditLogPath: string;
    exportFormats: string[];
    runtimeHealth: {
      orchestration: ManagementOrchestrationHealthRecord;
      activeTurns: ManagementActiveTurnHealthRecord;
      pruning?: ManagementRuntimeRetentionHealthRecord;
      workerQueues?: ManagementRuntimeWorkerQueueHealthRecord[];
    };
    packageLoadFailures: RuntimePackageLoadFailure[];
    configMigrationWarning: {
      type: 'secret_history_reset';
      createdAt: string;
      backupGitDir: string | null;
      detail: string;
    } | null;
    recentAuditEvents: Array<{
      eventType: string;
      actor: string;
      action: string;
      status: string;
      target: string | null;
      reason: string | null;
      recordedAt: string | null;
    }>;
    recentRuntimeActivities: Array<{
      kind: string;
      severity: 'info' | 'warning' | 'error';
      title: string;
      detail: string | null;
      threadId: string;
      spaceId: string | null;
      createdAt: string;
    }>;
  };
  history: {
    status: HistoryStatus;
    entries: HistoryEntry[];
    capabilities: {
      snapshot: boolean;
      restore: boolean;
      discard: boolean;
    };
  };
  overview: {
    sessions: number;
    missions: number;
    pendingRequests: number;
    plugins: number;
    skills: number;
    services: number;
    providerThreads: number;
    sidecars: number;
  };
  objects: {
    sessions: ManagedSessionRecord[];
    missions: ManagedMissionRecord[];
    plugins: ManagedPluginRecord[];
    skills: ManagedSkillRecord[];
    services: ManagedServiceRecord[];
    managementContributions: RuntimeManagementContribution[];
    pendingRequests: ManagedPendingRequestRecord[];
    providerThreads: ManagedProviderThreadRecord[];
    sidecars: ManagedSidecarSummary[];
  };
}

export type ManagementRuntimeStatusProvider = () => {
  uptimeSeconds: number;
  openSessions: number;
  coolSessions: number;
  archivedSessions: number;
  waitingSessions: number;
  runningSessions: number;
};
