import { randomUUID } from 'node:crypto';
import {
  type AdminConfig,
  usesProviderDefaultModel,
  type AppliedMoorlineConfig,
  type RuntimeSurfaceState
} from '../../../types/config.js';
import { saveMoorlineConfig } from '../../system/config/configStore.js';
import type { RuntimeControlStatus } from '../supervision/runtimeControl.js';
import type { RuntimeDomainEvent } from './runtimeDomain.js';
import type { RuntimeActivityRecord, RuntimeActivityStore } from '../../system/projection/runtimeActivityStore.js';
import type { ProjectionStateStore } from '../../system/projection/projectionStateStore.js';
import type { RuntimeSnapshotQuery } from '../../system/projection/runtimeSnapshotQuery.js';
import type { RuntimeProvider } from '../../../types/provider.js';
import type { CanonicalEventLogStore } from '../../system/state/canonicalEventLogStore.js';
import type { RuntimePluginAdminConfig, RuntimePluginContext } from '../../../types/plugin.js';
import type { PluginHost } from '../../extension/plugins/pluginHost.js';
import type { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type { SidecarManager } from '../supervision/sidecarManager.js';
import type { SkillRegistry } from '../../extension/skills/skillRegistry.js';
import type { RuntimeSessionRow, SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import type {
  RuntimeAttachmentPayload,
  RuntimeActorIdentity,
  RuntimeMessagePayload
} from '../../../types/transport.js';
import { parseRuntimeModeName } from '../../../types/runtime.js';
import type { RuntimeCommandRunner } from '../../../types/runtime.js';
import type {
  RuntimeGateRunRecord,
  RuntimeWorkItemRecord
} from '../../../types/external.js';
import { refreshMemoryIndex, retrieveFromMemoryWithSQLite } from '../../domain/memory/retrieval.js';
import { MemoryStore } from '../../domain/memory/store.js';
import type { RuntimeControlService } from '../supervision/runtimeControlService.js';
import type { ProviderOrchestrator } from './providerOrchestration/providerOrchestrator.js';
import type { RuntimeWorkManagementService } from '../../domain/sessions/runtimeWorkManagementService.js';
import type { SessionRegistry } from '../../domain/sessions/sessionState.js';
import { recordHistoryCheckpoint } from '../../system/vcs/gitCheckpointService.js';
import { createPluginContextCapabilities } from './pluginContext/pluginContextFactory.js';
import { describeTransportAuthor } from './pluginContext/transportAuthor.js';
import { toPluginPackageId } from '../../extension/plugins/pluginId.js';
import { normalizeAndValidateDefaultModel } from './defaultModelSelection.js';
import {
  computePackageJobRunAtOrAfterWithMeta,
  packageScheduleMetaToJson,
  parsePackageSchedule,
  parsePackageScheduleStartTime
} from '../../shared/scheduling/packageSchedule.js';

export { defaultSessionOwner } from './pluginContext/defaultSessionOwner.js';

interface RuntimePluginContextServiceDeps {
  config: AppliedMoorlineConfig;
  configPath?: string;
  runtimeRoot: string;
  homeRoot: string;
  sqlitePath: string;
  chatWorkspacePath: string;
  commandRunner?: RuntimeCommandRunner;
  store: SqliteSessionStore;
  sessionRegistry: SessionRegistry;
  skillRegistry: SkillRegistry;
  memoryStore: MemoryStore;
  activities: RuntimeActivityStore;
  projectionState: ProjectionStateStore;
  snapshots: RuntimeSnapshotQuery;
  providerService: RuntimeProvider;
  canonicalEvents: CanonicalEventLogStore;
  workManagement: RuntimeWorkManagementService;
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
  recordRuntimeActivity(input: Omit<RuntimeActivityRecord, 'activityId'>): void;
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

  private contextPackageId(actorId: string): string {
    return actorId.startsWith('plugin:') ? actorId.slice('plugin:'.length) : actorId;
  }

  private packageState<T>(valueJson: string): T | null {
    try {
      return JSON.parse(valueJson) as T;
    } catch {
      return null;
    }
  }

  private validateStructuredOutput(value: unknown, schema: unknown): void {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return;
    }
    const record = schema as { type?: unknown; required?: unknown; properties?: unknown };
    if (record.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error('Headless run output must be a JSON object.');
    }
    const objectValue = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    if (Array.isArray(record.required)) {
      for (const key of record.required) {
        if (typeof key === 'string' && objectValue[key] === undefined) {
          throw new Error(`Headless run output is missing required field: ${key}.`);
        }
      }
    }
    const properties =
      record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
        ? (record.properties as Record<string, { type?: unknown }>)
        : {};
    for (const [key, property] of Object.entries(properties)) {
      const expected = property.type;
      const actual = objectValue[key];
      if (actual === undefined || typeof expected !== 'string') {
        continue;
      }
      const ok =
        expected === 'array'
          ? Array.isArray(actual)
          : expected === 'object'
            ? actual !== null && typeof actual === 'object' && !Array.isArray(actual)
            : typeof actual === expected;
      if (!ok) {
        throw new Error(`Headless run output field ${key} must be ${expected}.`);
      }
    }
  }

  private transitionWorkItem(
    actorId: string,
    workItemId: string,
    update: (current: RuntimeWorkItemRecord, nowIso: string) => RuntimeWorkItemRecord
  ): RuntimeWorkItemRecord {
    const current = this.requireOwnedWorkItem(actorId, workItemId);
    const nowIso = this.deps.now();
    const updated = this.deps.store.updateWorkItem(update(current, nowIso));
    this.deps.appendAuditEvent('work_item.updated', {
      actorId,
      packageId: updated.packageId,
      workItemId: updated.workItemId,
      queue: updated.queue,
      status: updated.status
    });
    this.deps.recordRuntimeActivity({
      ...this.activityTargetForSession(updated.sessionId, 'runtime:work'),
      sourceEventId: randomUUID(),
      kind: `work_item.${updated.status}`,
      severity: updated.status === 'failed' || updated.status === 'dead_lettered' ? 'error' : 'info',
      title: `Work item ${updated.status}`,
      detail: `${updated.packageId}/${updated.queue}/${updated.workItemId}`,
      createdAt: nowIso
    });
    return updated;
  }

  private requireOwnedWorkItem(actorId: string, workItemId: string): RuntimeWorkItemRecord {
    const record = this.deps.store.getWorkItem(workItemId);
    if (!record) {
      throw new Error(`Unknown work item: ${workItemId}`);
    }
    const packageId = this.contextPackageId(actorId);
    if (record.packageId !== packageId) {
      throw new Error(`Work item ${workItemId} is owned by ${record.packageId}, not ${packageId}.`);
    }
    return record;
  }

  private requireSession(sessionId: string): RuntimeSessionRow {
    const session = this.deps.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  private activityTargetForSession(sessionId: string | null | undefined, fallbackThreadId: string): {
    threadId: string;
    sessionId: string | null;
    spaceId: string | null;
  } {
    if (!sessionId) {
      return { threadId: fallbackThreadId, sessionId: null, spaceId: null };
    }
    const session = this.deps.store.getSession(sessionId);
    return {
      threadId: session?.threadId ?? fallbackThreadId,
      sessionId,
      spaceId: session?.spaceId ?? null
    };
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
      getPackageState: (key) => {
        const row = this.deps.store.getPackageState(this.contextPackageId(actorId), key);
        return row ? this.packageState(row.valueJson) : null;
      },
      putPackageState: async (key, value) =>
        await this.deps.runGuardedAction({
          action: 'package.state.write',
          actor: actorId,
          target: `${this.contextPackageId(actorId)}:${key}`,
          title: 'Package state write blocked',
          execute: async () => {
            this.deps.store.putPackageState({
              packageId: this.contextPackageId(actorId),
              key,
              valueJson: JSON.stringify(value),
              updatedAt: this.deps.now()
            });
          }
        }),
      deletePackageState: async (key) =>
        await this.deps.runGuardedAction({
          action: 'package.state.write',
          actor: actorId,
          target: `${this.contextPackageId(actorId)}:${key}`,
          title: 'Package state delete blocked',
          execute: async () => {
            this.deps.store.deletePackageState(this.contextPackageId(actorId), key);
          }
        }),
      listPackageState: (prefix) =>
        this.deps.store.listPackageState(this.contextPackageId(actorId), prefix).map((row) => ({
          packageId: row.packageId,
          key: row.key,
          value: this.packageState(row.valueJson),
          updatedAt: row.updatedAt
        })),
      schedulePackageJob: async ({ jobId, actionId, schedule, startTime, payload }) =>
        await this.deps.runGuardedAction({
          action: 'package.job.manage',
          actor: actorId,
          target: `${this.contextPackageId(actorId)}:${jobId}`,
          payload: { actionId, schedule },
          title: 'Package job schedule blocked',
          execute: async () => {
            const nowIso = this.deps.now();
            const parsed = parsePackageSchedule(schedule);
            const anchor = parsePackageScheduleStartTime(startTime, nowIso);
            const nextRunAt = computePackageJobRunAtOrAfterWithMeta(
              anchor,
              parsed.cadenceMinutes,
              nowIso,
              parsed.meta
            );
            const row = {
              packageId: this.contextPackageId(actorId),
              jobId,
              actionId,
              schedule: parsed.normalized,
              scheduleAnchorAt: anchor,
              cadenceMinutes: parsed.cadenceMinutes,
              scheduleMetaJson: packageScheduleMetaToJson(parsed.meta),
              payloadJson: JSON.stringify(payload ?? {}),
              nextRunAt,
              createdAt: this.deps.store.getPackageJob(this.contextPackageId(actorId), jobId)?.createdAt ?? nowIso,
              updatedAt: nowIso
            };
            this.deps.store.upsertPackageJob(row);
            return {
              packageId: row.packageId,
              jobId: row.jobId,
              actionId: row.actionId,
              schedule: row.schedule,
              scheduleAnchorAt: row.scheduleAnchorAt,
              nextRunAt: row.nextRunAt,
              payload: payload ?? {},
              createdAt: row.createdAt,
              updatedAt: row.updatedAt
            };
          }
        }),
      cancelPackageJob: async (jobId) =>
        await this.deps.runGuardedAction({
          action: 'package.job.manage',
          actor: actorId,
          target: `${this.contextPackageId(actorId)}:${jobId}`,
          title: 'Package job cancel blocked',
          execute: async () => {
            const row = this.deps.store.deletePackageJob(this.contextPackageId(actorId), jobId);
            return row
              ? {
                  packageId: row.packageId,
                  jobId: row.jobId,
                  actionId: row.actionId,
                  schedule: row.schedule,
                  scheduleAnchorAt: row.scheduleAnchorAt,
                  nextRunAt: row.nextRunAt,
                  payload: this.packageState<Record<string, unknown>>(row.payloadJson) ?? {},
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt
                }
              : null;
          }
        }),
      listPackageJobs: () =>
        this.deps.store.listPackageJobs(this.contextPackageId(actorId)).map((row) => ({
          packageId: row.packageId,
          jobId: row.jobId,
          actionId: row.actionId,
          schedule: row.schedule,
          scheduleAnchorAt: row.scheduleAnchorAt,
          nextRunAt: row.nextRunAt,
          payload: this.packageState<Record<string, unknown>>(row.payloadJson) ?? {},
          createdAt: row.createdAt,
          updatedAt: row.updatedAt
        })),
      enqueueWorkItem: async ({ queue, workItemId, idempotencyKey, externalResource, payload, priority, runAfter, maxAttempts }) =>
        await this.deps.runGuardedAction({
          action: 'package.work.manage',
          actor: actorId,
          target: `${this.contextPackageId(actorId)}:${queue}`,
          payload: { idempotencyKey, externalResource },
          title: 'Package work enqueue blocked',
          execute: async () => {
            const packageId = this.contextPackageId(actorId);
            const normalizedQueue = queue.trim();
            if (!normalizedQueue) {
              throw new Error('Work item queue is required.');
            }
            const nowIso = this.deps.now();
            if (externalResource) {
              this.deps.store.upsertExternalResource({ ...externalResource, nowIso });
            }
            const record = this.deps.store.enqueueWorkItem({
              workItemId: workItemId?.trim() || randomUUID(),
              packageId,
              queue: normalizedQueue,
              status: 'queued',
              priority: Number.isFinite(priority) ? Math.trunc(priority ?? 0) : 0,
              ...(idempotencyKey ? { idempotencyKey } : {}),
              ...(externalResource ? { externalResource } : {}),
              payload: payload ?? {},
              attempts: 0,
              maxAttempts: Math.max(1, Math.trunc(maxAttempts ?? 3)),
              runAfter: runAfter ?? null,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: null,
              createdAt: nowIso,
              updatedAt: nowIso,
              completedAt: null
            });
            this.deps.appendAuditEvent('work_item.enqueued', {
              actorId,
              packageId,
              workItemId: record.workItemId,
              queue: record.queue,
              idempotencyKey: record.idempotencyKey
            });
            this.deps.recordRuntimeActivity({
              threadId: 'runtime:work',
              sessionId: null,
              spaceId: null,
              sourceEventId: randomUUID(),
              kind: 'work_item.queued',
              severity: 'info',
              title: 'Work item queued',
              detail: `${record.packageId}/${record.queue}/${record.workItemId}`,
              createdAt: nowIso
            });
            return record;
          }
        }),
      claimWorkItem: async ({ queue, leaseSeconds, leaseOwner }) =>
        await this.deps.runGuardedAction({
          action: 'package.work.manage',
          actor: actorId,
          target: `${this.contextPackageId(actorId)}:${queue}`,
          title: 'Package work claim blocked',
          execute: async () => {
            const now = new Date(this.deps.now());
            const leaseMs = Math.max(1, leaseSeconds ?? 300) * 1000;
            const claimed = this.deps.store.claimWorkItem({
              packageId: this.contextPackageId(actorId),
              queue,
              leaseOwner: leaseOwner?.trim() || actorId,
              leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
              nowIso: now.toISOString()
            });
            if (claimed) {
              this.deps.appendAuditEvent('work_item.claimed', {
                actorId,
                packageId: claimed.packageId,
                workItemId: claimed.workItemId,
                queue: claimed.queue,
                attempts: claimed.attempts
              });
              this.deps.recordRuntimeActivity({
                ...this.activityTargetForSession(claimed.sessionId, 'runtime:work'),
                sourceEventId: randomUUID(),
                kind: 'work_item.claimed',
                severity: 'info',
                title: 'Work item claimed',
                detail: `${claimed.packageId}/${claimed.queue}/${claimed.workItemId}`,
                createdAt: now.toISOString()
              });
            }
            return claimed;
          }
        }),
      completeWorkItem: async ({ workItemId, phase }) =>
        await this.deps.runGuardedAction({
          action: 'package.work.manage',
          actor: actorId,
          target: workItemId,
          title: 'Package work complete blocked',
          execute: async () =>
            this.transitionWorkItem(actorId, workItemId, (current, nowIso) => ({
              ...current,
              status: 'completed',
              ...(phase ? { phase } : {}),
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: null,
              updatedAt: nowIso,
              completedAt: nowIso
            }))
        }),
      failWorkItem: async ({ workItemId, error, retryAfter, phase }) =>
        await this.deps.runGuardedAction({
          action: 'package.work.manage',
          actor: actorId,
          target: workItemId,
          title: 'Package work fail blocked',
          execute: async () =>
            this.transitionWorkItem(actorId, workItemId, (current, nowIso) => {
              const shouldRetry = retryAfter !== undefined && current.attempts < current.maxAttempts;
              return {
                ...current,
                status: shouldRetry ? 'queued' : 'failed',
                ...(phase ? { phase } : {}),
                runAfter: shouldRetry ? retryAfter : current.runAfter,
                leaseOwner: null,
                leaseExpiresAt: null,
                lastError: error,
                updatedAt: nowIso,
                completedAt: shouldRetry ? null : nowIso
              };
            })
        }),
      deadLetterWorkItem: async ({ workItemId, reason, phase }) =>
        await this.deps.runGuardedAction({
          action: 'package.work.manage',
          actor: actorId,
          target: workItemId,
          title: 'Package work dead-letter blocked',
          execute: async () =>
            this.transitionWorkItem(actorId, workItemId, (current, nowIso) => ({
              ...current,
              status: 'dead_lettered',
              ...(phase ? { phase } : {}),
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: reason,
              updatedAt: nowIso,
              completedAt: nowIso
            }))
        }),
      updateWorkItem: async ({ workItemId, payload, phase, externalResource, sessionId }) =>
        await this.deps.runGuardedAction({
          action: 'package.work.manage',
          actor: actorId,
          target: workItemId,
          title: 'Package work update blocked',
          execute: async () => {
            if (sessionId) {
              this.requireSession(sessionId);
            }
            return this.transitionWorkItem(actorId, workItemId, (current, nowIso) => ({
              ...current,
              ...(payload ? { payload } : {}),
              ...(phase ? { phase } : {}),
              ...(externalResource ? { externalResource } : {}),
              ...(sessionId ? { sessionId } : {}),
              updatedAt: nowIso
            }));
          }
        }),
      getWorkItem: (workItemId) => {
        const record = this.deps.store.getWorkItem(workItemId);
        return record?.packageId === this.contextPackageId(actorId) ? record : null;
      },
      listWorkItems: (filter) =>
        this.deps.store.listWorkItems({
          packageId: this.contextPackageId(actorId),
          queue: filter?.queue,
          status: filter?.status,
          externalResource: filter?.externalResource,
          limit: filter?.limit
        }),
      upsertExternalResource: async (input) =>
        await this.deps.runGuardedAction({
          action: 'package.work.manage',
          actor: actorId,
          target: `${input.provider}:${input.kind}:${input.id}`,
          title: 'External resource update blocked',
          execute: async () => this.deps.store.upsertExternalResource({ ...input, nowIso: this.deps.now() })
        }),
      listExternalResources: (filter) => this.deps.store.listExternalResources(filter),
      bindSessionToExternalResource: async ({ sessionId, externalResource, relationship }) =>
        await this.deps.runGuardedAction({
          action: 'package.work.manage',
          actor: actorId,
          target: `${sessionId}:${externalResource.provider}:${externalResource.kind}:${externalResource.id}`,
          title: 'Session resource binding blocked',
          execute: async () => {
            this.requireSession(sessionId);
            this.deps.store.upsertExternalResource({ ...externalResource, nowIso: this.deps.now() });
            this.deps.store.bindSessionToExternalResource({
              sessionId,
              resource: externalResource,
              relationship: relationship?.trim() || 'source',
              nowIso: this.deps.now()
            });
          }
        }),
      listSessionsForExternalResource: (resource) => {
        const ids = new Set(this.deps.store.listSessionIdsForExternalResource(resource));
        return this.deps.snapshots.listSessions().filter((snapshot) => ids.has(snapshot.session.sessionId));
      },
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
      createSession: async ({ requestedName, runtimeMode, initialInstruction, objective, owner, tags, externalResource, workItemId }) => {
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
        if (externalResource) {
          this.deps.store.upsertExternalResource({ ...externalResource, nowIso: this.deps.now() });
          this.deps.store.bindSessionToExternalResource({
            sessionId: created.session.sessionId,
            resource: externalResource,
            relationship: 'source',
            nowIso: this.deps.now()
          });
        }
        if (workItemId) {
          this.transitionWorkItem(actorId, workItemId, (current, nowIso) => ({
            ...current,
            sessionId: created.session.sessionId,
            ...(externalResource ? { externalResource } : {}),
            updatedAt: nowIso
          }));
        }
        return { session: created.session, spaceId: created.spaceId };
      },
      runGate: async ({ gateId, command, args, cwd, required, workItemId, sessionId }) =>
        await this.deps.runGuardedAction({
          action: 'command.exec',
          actor: actorId,
          target: `${gateId}:${command}`,
          payload: { args, cwd, required, workItemId, sessionId },
          threadId: sessionId ? this.deps.store.getSession(sessionId)?.threadId : undefined,
          title: 'Runtime gate blocked',
          execute: async () => {
            if (!this.deps.commandRunner) {
              throw new Error('Runtime gates require a command runner.');
            }
            if (sessionId) {
              this.requireSession(sessionId);
            }
            if (workItemId) {
              this.requireOwnedWorkItem(actorId, workItemId);
            }
            const packageId = this.contextPackageId(actorId);
            const startedAt = this.deps.now();
            let gate: RuntimeGateRunRecord = this.deps.store.upsertGateRun({
              gateRunId: randomUUID(),
              gateId,
              packageId,
              ...(workItemId ? { workItemId } : {}),
              ...(sessionId ? { sessionId } : {}),
              command,
              args: args ?? [],
              ...(cwd ? { cwd } : {}),
              required: required === true,
              status: 'running',
              exitCode: null,
              stdout: '',
              stderr: '',
              startedAt,
              completedAt: null
            });
            try {
              const result = await this.deps.commandRunner.run(command, args ?? [], cwd);
              gate = this.deps.store.upsertGateRun({
                ...gate,
                status: result.exitCode === 0 ? 'passed' : 'failed',
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                completedAt: this.deps.now()
              });
              this.deps.appendAuditEvent(result.exitCode === 0 ? 'runtime.gate.passed' : 'runtime.gate.failed', {
                actorId,
                packageId,
                gateRunId: gate.gateRunId,
                gateId,
                workItemId,
                sessionId,
                exitCode: result.exitCode
              });
              this.deps.recordRuntimeActivity({
                ...this.activityTargetForSession(sessionId, 'runtime:gates'),
                sourceEventId: gate.gateRunId,
                kind: result.exitCode === 0 ? 'runtime.gate.passed' : 'runtime.gate.failed',
                severity: result.exitCode === 0 ? 'info' : 'error',
                title: result.exitCode === 0 ? 'Runtime gate passed' : 'Runtime gate failed',
                detail: `${gate.gateId}: ${gate.command} ${(gate.args ?? []).join(' ')}`.trim(),
                createdAt: gate.completedAt ?? this.deps.now()
              });
              return gate;
            } catch (error) {
              this.deps.store.upsertGateRun({
                ...gate,
                status: 'error',
                exitCode: null,
                stderr: error instanceof Error ? error.message : String(error),
                completedAt: this.deps.now()
              });
              this.deps.recordRuntimeActivity({
                ...this.activityTargetForSession(sessionId, 'runtime:gates'),
                sourceEventId: gate.gateRunId,
                kind: 'runtime.gate.error',
                severity: 'error',
                title: 'Runtime gate errored',
                detail: error instanceof Error ? error.message : String(error),
                createdAt: this.deps.now()
              });
              throw error;
            }
          }
        }),
      runHeadless: async ({ requestedName, runtimeMode, prompt, objective, owner, tags, externalResource, workItemId, outputSchema, requireStructuredOutput }) =>
        await this.deps.runGuardedAction({
          action: 'provider.headless.run',
          actor: actorId,
          target: `${this.contextPackageId(actorId)}:${requestedName}`,
          payload: { requestedName, runtimeMode, objective, owner, tags, externalResource, workItemId },
          title: 'Headless provider run blocked',
          execute: async () => {
            const context = this.createContext(actorId);
            // First-pass headless runs are session-backed, so provider execution uses the managed session workspace.
            const created = await context.createSession({
              requestedName,
              runtimeMode,
              objective,
              owner,
              tags,
              externalResource,
              workItemId
            });
            const reply = await context.runAgent({
              surface: 'session',
              spaceId: created.spaceId,
              actorId,
              actorLabel: this.contextPackageId(actorId),
              text: prompt,
              session: created.session,
              cwd: created.session.workspacePath,
              runtimeMode,
              basePromptSections: await this.loadSessionPromptSections(created.session),
              promptSource: 'headless'
            });
            const text = reply.text ?? '';
            let parsedOutput: unknown;
            if (outputSchema || requireStructuredOutput) {
              try {
                parsedOutput = JSON.parse(text) as unknown;
                this.validateStructuredOutput(parsedOutput, outputSchema);
              } catch (error) {
                if (requireStructuredOutput) {
                  throw error;
                }
              }
            }
            return {
              session: created.session,
              reply,
              ...(parsedOutput !== undefined ? { parsedOutput } : {})
            };
          }
        }),
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
