import type { PendingRuntimeRequestRecord, ProviderRuntimeEvent, ProviderSessionRecord, RuntimeModeName } from '../../../../types/runtime.js';
import type { SessionOwnerKind } from '../../../../types/plugin.js';
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
  spaceId: string;
  threadId: string;
  spaceName: string;
  workspacePath: string;
  runtimeMode: RuntimeModeName;
  lifecycleStatus: SessionLifecycleStatus;
  summary: string | null;
  provider: ProviderSessionRecord['providerPackageId'];
  providerThreadId: string | null;
  resumeThreadId: string | null;
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
  requestedBySpaceId: string;
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

export interface RuntimeEventRow {
  eventId: string;
  provider: string;
  threadId: string;
  spaceId: string | null;
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
  spaceId: string | null;
  sessionId: string | null;
  sourceProviderEventId: string | null;
  type: string;
  payloadJson: string;
  createdAt: string;
}

export interface RuntimeSessionDbRow extends Omit<RuntimeSessionRow, 'providerAutoStartEnabled' | 'tags'> {
  providerAutoStartEnabled: number;
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
    providerAutoStartEnabled: row.providerAutoStartEnabled !== 0,
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

export const RUNTIME_SESSION_SELECT = `
  SELECT
    session_id as sessionId,
    scope_id as scopeId,
    space_id as spaceId,
    thread_id as threadId,
    space_name as spaceName,
    workspace_path as workspacePath,
    runtime_mode as runtimeMode,
    lifecycle_status as lifecycleStatus,
    summary,
    provider,
    provider_thread_id as providerThreadId,
    resume_thread_id as resumeThreadId,
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
