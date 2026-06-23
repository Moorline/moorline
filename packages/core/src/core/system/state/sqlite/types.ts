import type { PendingRuntimeRequestRecord, ProviderResumeCursor, ProviderRuntimeEvent, ProviderSessionRecord, RuntimeAgentKind, RuntimeModeName } from '../../../../types/runtime.js';
import type { RuntimeWorkflowRunRecord, SessionOwnerKind } from '../../../../types/plugin.js';
import type {
  RuntimeExternalResourceRecord,
  RuntimeExternalResourceRef,
  RuntimeGateRunRecord,
  RuntimeWorkItemRecord
} from '../../../../types/external.js';
import type { ProviderBindingRecord, RuntimeDomainEvent, RuntimeReceiptRecord } from '../../../runtime/execution/runtimeDomain.js';
import type {
  ManagedSidecarRecord,
  ManagedSidecarStatus,
  SidecarReadinessProbe,
  SidecarRestartPolicy
} from '../../../runtime/supervision/managedSidecar.js';
import { isStringArray, safeReadJson, safeReadJsonValue } from '../safeJson.js';

export type SessionLifecycleStatus = 'hot' | 'cool' | 'archived';

export interface RuntimeSessionRow {
  sessionId: string;
  scopeId: string;
  transportResourceId: string;
  threadId: string;
  transportResourceName: string;
  agentKind?: RuntimeAgentKind;
  workspacePath: string | null;
  providerCwd?: string | null;
  runtimeMode: RuntimeModeName;
  lifecycleStatus: SessionLifecycleStatus;
  summary: string | null;
  provider: ProviderSessionRecord['providerPackageId'];
  providerThreadId: string | null;
  resumeCursor?: ProviderResumeCursor | null;
  toolGrantIds?: string[];
  providerStatus: ProviderSessionRecord['status'];
  providerAutoStartEnabled?: boolean;
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  archivedAt: string | null;
  lastError: string | null;
  ownerKind?: SessionOwnerKind | null;
  ownerId?: string | null;
  ownerLabel?: string | null;
  objective?: string | null;
  tags?: string[];
  createdBy?: string | null;
  lastDirectedAt?: string | null;
  lastDirectedBy?: string | null;
}

export type RuntimeOrchestrationRequestType =
  | 'create_session'
  | 'direct_session'
  | 'archive_session'
  | 'delete_session'
  | 'post_message'
  | 'runtime_set_accepting'
  | 'runtime_reload'
  | 'provider_test'
  | 'provider_stop'
  | 'provider_start'
  | 'resolve_pending_request'
  | 'answer_pending_request';

export type RuntimeOrchestrationRequestStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface RuntimeOrchestrationRequestRow {
  requestId: string;
  actorId: string;
  requestedByThreadId: string;
  requestedByTransportResourceId: string;
  dedupeKey: string | null;
  type: RuntimeOrchestrationRequestType;
  targetSessionId: string | null;
  payloadJson: string;
  status: RuntimeOrchestrationRequestStatus;
  resultJson: string | null;
  error: string | null;
  executionOwner: string | null;
  executionAttempt: number;
  executionStartedAt: string | null;
  completionToken: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimePackageStateRow {
  packageId: string;
  key: string;
  valueJson: string;
  updatedAt: string;
}

export interface RuntimePackageJobRow {
  packageId: string;
  jobId: string;
  actionId: string;
  schedule: string;
  scheduleAnchorAt: string;
  cadenceMinutes: number;
  scheduleMetaJson: string;
  payloadJson: string;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeExternalResourceRow {
  provider: string;
  kind: string;
  externalId: string;
  url: string | null;
  title: string | null;
  state: string | null;
  metadataJson: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface RuntimeWorkItemRow {
  workItemId: string;
  packageId: string;
  queue: string;
  status: RuntimeWorkItemRecord['status'];
  priority: number;
  idempotencyKey: string | null;
  externalProvider: string | null;
  externalKind: string | null;
  externalId: string | null;
  externalUrl: string | null;
  externalTitle: string | null;
  externalMetadataJson: string | null;
  sessionId: string | null;
  payloadJson: string;
  phase: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RuntimeWorkflowRunRow {
  runId: string;
  packageId: string;
  workflowId: string;
  status: RuntimeWorkflowRunRecord['status'];
  inputJson: string;
  actorJson: string;
  originJson: string | null;
  resultJson: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RuntimeSessionExternalResourceRow {
  sessionId: string;
  provider: string;
  kind: string;
  externalId: string;
  relationship: string;
  createdAt: string;
}

export interface RuntimeGateRunRow {
  gateRunId: string;
  gateId: string;
  packageId: string;
  workItemId: string | null;
  sessionId: string | null;
  command: string;
  argsJson: string;
  cwd: string | null;
  required: number;
  status: RuntimeGateRunRecord['status'];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string | null;
}

export interface RuntimeEventRow {
  eventId: string;
  provider: string;
  threadId: string;
  transportResourceId: string | null;
  turnId: string | null;
  itemId: string | null;
  requestId: string | null;
  type: string;
  payloadJson: string;
  createdAt: string;
}

export interface DomainEventRow {
  eventId: string;
  threadId: string;
  transportResourceId: string | null;
  sessionId: string | null;
  sourceProviderEventId: string | null;
  type: string;
  payloadJson: string;
  createdAt: string;
}

export interface RuntimeSessionDbRow extends Omit<RuntimeSessionRow, 'providerAutoStartEnabled' | 'tags' | 'resumeCursor' | 'toolGrantIds'> {
  providerAutoStartEnabled: number;
  resumeCursorJson: string | null;
  toolGrantIdsJson: string | null;
  tagsJson: string | null;
}

export interface ManagedSidecarDbRow extends Omit<ManagedSidecarRecord, 'args' | 'env' | 'readiness'> {
  argsJson: string;
  envJson: string;
  readinessJson: string;
}

export type { PendingRuntimeRequestRecord, ProviderBindingRecord, ProviderRuntimeEvent, RuntimeDomainEvent, RuntimeReceiptRecord };

export function hydrateSession(row: RuntimeSessionDbRow | undefined): RuntimeSessionRow | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    agentKind: row.agentKind ?? 'workspace',
    providerAutoStartEnabled: row.providerAutoStartEnabled !== 0,
    resumeCursor: safeReadJsonValue<ProviderResumeCursor>(row.resumeCursorJson).value ?? null,
    toolGrantIds: safeReadJson(row.toolGrantIdsJson, isStringArray).value ?? [],
    tags: safeReadJson(row.tagsJson, isStringArray).value ?? []
  };
}

export function hydrateManagedSidecar(row: ManagedSidecarDbRow | undefined): ManagedSidecarRecord | null {
  if (!row) {
    return null;
  }
  return {
    ...row,
    status: row.status as ManagedSidecarStatus,
    args: safeReadJson(row.argsJson, isStringArray).value ?? [],
    env: safeReadJsonValue<Record<string, string>>(row.envJson).value ?? {},
    restartPolicy: row.restartPolicy as SidecarRestartPolicy,
    readiness: safeReadJsonValue<SidecarReadinessProbe>(row.readinessJson).value ?? { kind: 'none' }
  };
}

export function hydrateExternalResource(row: RuntimeExternalResourceRow | undefined): RuntimeExternalResourceRecord | null {
  if (!row) {
    return null;
  }
  const metadata = safeReadJsonValue<Record<string, unknown>>(row.metadataJson).value ?? {};
  return {
    provider: row.provider,
    kind: row.kind,
    id: row.externalId,
    ...(row.url ? { url: row.url } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.state ? { state: row.state } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt
  };
}

export function hydrateWorkItem(row: RuntimeWorkItemRow | undefined): RuntimeWorkItemRecord | null {
  if (!row) {
    return null;
  }
  const payload = safeReadJsonValue<Record<string, unknown>>(row.payloadJson).value ?? {};
  const externalMetadata = safeReadJsonValue<Record<string, unknown>>(row.externalMetadataJson).value ?? {};
  const externalResource: RuntimeExternalResourceRef | undefined =
    row.externalProvider && row.externalKind && row.externalId
      ? {
          provider: row.externalProvider,
          kind: row.externalKind,
          id: row.externalId,
          ...(row.externalUrl ? { url: row.externalUrl } : {}),
          ...(row.externalTitle ? { title: row.externalTitle } : {}),
          ...(Object.keys(externalMetadata).length > 0 ? { metadata: externalMetadata } : {})
        }
      : undefined;
  return {
    workItemId: row.workItemId,
    packageId: row.packageId,
    queue: row.queue,
    status: row.status,
    priority: row.priority,
    ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    ...(externalResource ? { externalResource } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    payload,
    ...(row.phase ? { phase: row.phase } : {}),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAfter: row.runAfter,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt
  };
}

export function hydrateGateRun(row: RuntimeGateRunRow | undefined): RuntimeGateRunRecord | null {
  if (!row) {
    return null;
  }
  return {
    gateRunId: row.gateRunId,
    gateId: row.gateId,
    packageId: row.packageId,
    ...(row.workItemId ? { workItemId: row.workItemId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    command: row.command,
    args: safeReadJson(row.argsJson, isStringArray).value ?? [],
    ...(row.cwd ? { cwd: row.cwd } : {}),
    required: row.required !== 0,
    status: row.status,
    exitCode: row.exitCode,
    stdout: row.stdout,
    stderr: row.stderr,
    startedAt: row.startedAt,
    completedAt: row.completedAt
  };
}

export const RUNTIME_SESSION_SELECT = `
  SELECT
    session_id as sessionId,
    scope_id as scopeId,
    transport_resource_id as transportResourceId,
    thread_id as threadId,
    transport_resource_name as transportResourceName,
    COALESCE(agent_kind, 'workspace') as agentKind,
    workspace_path as workspacePath,
    provider_cwd as providerCwd,
    runtime_mode as runtimeMode,
    lifecycle_status as lifecycleStatus,
    summary,
    provider,
    provider_thread_id as providerThreadId,
    resume_cursor_json as resumeCursorJson,
    tool_grant_ids_json as toolGrantIdsJson,
    provider_status as providerStatus,
    provider_auto_start_enabled as providerAutoStartEnabled,
    active_turn_id as activeTurnId,
    created_at as createdAt,
    updated_at as updatedAt,
    last_activity_at as lastActivityAt,
    archived_at as archivedAt,
    last_error as lastError,
    owner_kind as ownerKind,
    owner_id as ownerId,
    owner_label as ownerLabel,
    objective,
    tags_json as tagsJson,
    created_by as createdBy,
    last_directed_at as lastDirectedAt,
    last_directed_by as lastDirectedBy
  FROM runtime_sessions
`;

export const MANAGED_SIDECAR_SELECT = `
  SELECT
    sidecar_id as sidecarId,
    instance_id as instanceId,
    plugin_id as pluginId,
    sidecar_name as name,
    scope_kind as scopeKind,
    scope_key as scopeKey,
    status,
    command,
    args_json as argsJson,
    cwd,
    env_json as envJson,
    restart_policy as restartPolicy,
    max_restarts as maxRestarts,
    readiness_json as readinessJson,
    artifact_dir as artifactDir,
    pid,
    restart_count as restartCount,
    started_at as startedAt,
    ready_at as readyAt,
    stopped_at as stoppedAt,
    last_exit_code as lastExitCode,
    last_exit_signal as lastExitSignal,
    last_error as lastError,
    updated_at as updatedAt
  FROM managed_sidecars
`;
