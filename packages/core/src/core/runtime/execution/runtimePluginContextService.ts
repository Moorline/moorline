import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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
import type {
  ProviderResourceBundle,
  ProviderToolDefinition,
  ProviderToolExecutor,
  ProviderToolPolicyConfig,
  RuntimeProvider
} from '../../../types/provider.js';
import type { CanonicalEventLogStore } from '../../system/state/canonicalEventLogStore.js';
import type {
  RuntimePluginAdminConfig,
  RuntimePluginContext,
  RuntimeToolDefinition,
  RuntimeWorkflowDefinitionWithPackage,
  RuntimeWorkflowRunOrigin,
  RuntimeWorkflowRunRecord
} from '../../../types/plugin.js';
import type { PluginHost } from '../../extension/plugins/pluginHost.js';
import type { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type { SidecarManager } from '../supervision/sidecarManager.js';
import type { SkillRegistry } from '../../extension/skills/skillRegistry.js';
import { writeSkill } from '../../extension/skills/skillWriter.js';
import type { RuntimeSessionRow, SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import type {
  RuntimeAttachmentPayload,
  RuntimeActorIdentity,
  RuntimeMessagePayload
} from '../../../types/transport.js';
import { parseRuntimeModeName, type RuntimeAgentKind } from '../../../types/runtime.js';
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
  providerToolPolicy: ProviderToolPolicyConfig;
  configPath?: string;
  runtimeRoot: string;
  homeRoot: string;
  sqlitePath: string;
  coordinationWorkspacePath: string;
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
  requireSurfaceState(): RuntimeSurfaceState;
  getSurfaceState(): RuntimeSurfaceState | null;
  getRuntimeStatus(): RuntimePluginContext['getRuntimeStatus'] extends () => infer T ? T : never;
  getRuntimeControlStatus(): RuntimeControlStatus;
  ensureCoordinationSession(transportResourceId: string, cwd: string): Promise<RuntimeSessionRow>;
  prepareProviderImages(threadId: string, attachments: RuntimeAttachmentPayload[] | undefined): Promise<Array<{ localPath: string } | { url: string }> | undefined>;
  normalizeReply(text: string): string;
  postTransportMessage(actor: string, transportResourceId: string, payload: RuntimeMessagePayload): Promise<void>;
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

  private safeRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private listRuntimeWorkflows(): RuntimeWorkflowDefinitionWithPackage[] {
    return this.deps.getPluginHost().listWorkflows((pluginId) => this.createContext(`plugin:${pluginId}`));
  }

  private resolveWorkflow(packageId: string | undefined, workflowId: string): RuntimeWorkflowDefinitionWithPackage {
    const workflows = this.listRuntimeWorkflows().filter((workflow) => workflow.id === workflowId);
    const matches = packageId ? workflows.filter((workflow) => workflow.packageId === packageId) : workflows;
    if (matches.length === 0) {
      throw new Error(packageId ? `Unknown workflow: ${packageId}:${workflowId}` : `Unknown workflow: ${workflowId}`);
    }
    if (matches.length > 1) {
      throw new Error(`Workflow id ${workflowId} is ambiguous. Provide package_id.`);
    }
    return matches[0]!;
  }

  private validateWorkflowInput(workflow: RuntimeWorkflowDefinitionWithPackage, input: Record<string, unknown>): void {
    const schema = workflow.inputSchema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return;
    }
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
    for (const key of required) {
      if (input[key] === undefined) {
        throw new Error(`Workflow ${workflow.packageId}:${workflow.id} input is missing required field: ${key}`);
      }
    }
  }

  private upsertWorkflowRun(record: RuntimeWorkflowRunRecord): RuntimeWorkflowRunRecord {
    return this.deps.store.upsertWorkflowRun(record);
  }

  private async startWorkflowRun(input: {
    packageId?: string;
    workflowId: string;
    input?: Record<string, unknown>;
    actor: RuntimeWorkflowRunRecord['actor'];
    origin?: RuntimeWorkflowRunOrigin;
  }): Promise<{ runId: string; status: RuntimeWorkflowRunRecord['status'] }> {
    const workflow = this.resolveWorkflow(input.packageId, input.workflowId);
    const workflowInput = this.safeRecord(input.input);
    this.validateWorkflowInput(workflow, workflowInput);
    const runId = randomUUID();
    const nowIso = this.deps.now();
    const baseRun: RuntimeWorkflowRunRecord = {
      runId,
      packageId: workflow.packageId,
      workflowId: workflow.id,
      status: 'queued',
      input: workflowInput,
      actor: input.actor,
      ...(input.origin ? { origin: input.origin } : {}),
      result: null,
      error: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null
    };
    this.upsertWorkflowRun(baseRun);
    this.deps.appendAuditEvent('workflow.run.queued', {
      runId,
      packageId: workflow.packageId,
      workflowId: workflow.id,
      actor: input.actor.actorId
    });

    const running = this.upsertWorkflowRun({
      ...baseRun,
      status: 'running',
      updatedAt: this.deps.now()
    });
    try {
      const result = await this.deps.getPluginHost().executeWorkflow(
        workflow.packageId,
        workflow.id,
        {
          type: 'transport.action.invoked',
          intentId: `runtime.workflow.${runId}`,
          occurredAt: this.deps.now(),
          scopeId: this.deps.config.transport.scopeId,
          ...(input.origin?.transportResourceId ? { transportResourceId: input.origin.transportResourceId } : {}),
          actor: input.actor,
          input: {
            ...workflowInput,
            __workflowRunId: runId
          }
        },
        (pluginId) => this.createContext(`plugin:${pluginId}`)
      );
      this.upsertWorkflowRun({
        ...running,
        status: 'completed',
        result: {
          handled: result.handled,
          ...(result.reply ? { reply: result.reply } : {})
        },
        updatedAt: this.deps.now(),
        completedAt: this.deps.now()
      });
      this.deps.appendAuditEvent('workflow.run.completed', {
        runId,
        packageId: workflow.packageId,
        workflowId: workflow.id
      });
      return { runId, status: 'completed' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.upsertWorkflowRun({
        ...running,
        status: 'failed',
        error: detail,
        updatedAt: this.deps.now(),
        completedAt: this.deps.now()
      });
      this.deps.appendAuditEvent('workflow.run.failed', {
        runId,
        packageId: workflow.packageId,
        workflowId: workflow.id,
        error: detail
      });
      throw error;
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
    transportResourceId: string | null;
  } {
    if (!sessionId) {
      return { threadId: fallbackThreadId, sessionId: null, transportResourceId: null };
    }
    const session = this.deps.store.getSession(sessionId);
    return {
      threadId: session?.threadId ?? fallbackThreadId,
      sessionId,
      transportResourceId: session?.transportResourceId ?? null
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
      getSurfaceState: () => this.deps.requireSurfaceState(),
      getCurrentTransportResourceId: () => this.deps.getSurfaceState()?.coordinationResourceId ?? this.deps.config.transport.scopeId,
      getCurrentThreadId: () => `coordination:${this.deps.getSurfaceState()?.coordinationResourceId ?? this.deps.config.transport.scopeId}`,
      getCurrentWorkspacePath: () => this.deps.coordinationWorkspacePath,
      getCoordinationWorkspacePath: () => this.deps.coordinationWorkspacePath,
      getRuntimeRootPath: () => this.deps.runtimeRoot,
      listSkills: () => capabilities.memory.listSkills(),
      loadSkill: async (name) => await capabilities.memory.loadSkill(name),
      writeSkill: async (input) => await capabilities.memory.writeSkill(input),
      listSessions: () => this.deps.snapshots.listSessions().map((entry) => entry.session),
      getSessionByTransportResourceId: (transportResourceId) => this.deps.snapshots.getSessionByTransportResourceId(transportResourceId)?.session ?? null,
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
              transportResourceId: null,
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
      listPendingRequests: (transportResourceId) =>
        this.deps.store.listPendingRequestsByTransportResource(transportResourceId).filter((request) => request.status === 'open'),
      listRuntimeReceipts: () => this.deps.snapshots.overview().receipts,
      listProviderConnections: () => this.deps.snapshots.overview().providers,
      listRuntimeActivities: (threadId) =>
        threadId ? this.deps.snapshots.getSessionByThreadId(threadId)?.recentActivities ?? [] : this.deps.activities.listRecent(25),
      getSessionSnapshotByTransportResourceId: (transportResourceId) => this.deps.snapshots.getSessionByTransportResourceId(transportResourceId),
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
          transportResourceId: row.transportResourceId,
          sessionId: row.sessionId,
          sourceProviderEventId: row.sourceProviderEventId,
          createdAt: row.createdAt,
          type: row.type as RuntimeDomainEvent['type'],
          payload: JSON.parse(row.payloadJson) as RuntimeDomainEvent['payload']
        })) as RuntimeDomainEvent[],
      updateSessionSummary: async (transportResourceId, summary, nowIso) => {
        this.deps.sessionRegistry.updateSummary(transportResourceId, summary, nowIso);
      },
      retrieveMemory: async ({ query, scopeId, transportResourceId, threadId, maxResults, enableRerank }) =>
        this.deps.runGuardedAction({
          action: 'memory.read',
          actor: actorId,
          target: transportResourceId ? `${scopeId}:${transportResourceId}:${threadId ?? 'root'}` : scopeId,
          payload: { query, maxResults, enableRerank },
          title: 'Memory read blocked',
          execute: async () =>
            await retrieveFromMemoryWithSQLite(
              query,
              this.deps.runtimeRoot,
              { scopeId: scopeId, transportResourceId: transportResourceId, threadId: threadId ?? null, projectKey: 'default' },
              this.deps.sqlitePath,
              { maxResults, enableRerank }
            )
        }),
      writeSessionMemory: async ({ scopeId, transportResourceId, threadId, kind, content, sourceRefs }) => {
        await this.deps.runGuardedAction({
          action: kind === 'summary' ? 'memory.write' : 'fs.write',
          actor: actorId,
          target: `${scopeId}:${transportResourceId}:${threadId ?? 'root'}:${kind}`,
          payload: { sourceRefs },
          title: 'Session memory write blocked',
          execute: async () =>
            this.deps.memoryStore.writeSessionRecord({
              scopeId: scopeId,
              transportResourceId: transportResourceId,
              threadId: threadId ?? null,
              kind,
              content,
              sourceRefs
            }).then(() => {
              void refreshMemoryIndex(
                this.deps.runtimeRoot,
                { scopeId: scopeId, transportResourceId: transportResourceId, threadId: threadId ?? null, projectKey: 'default' },
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
        return { session: created.session, transportResourceId: created.transportResourceId };
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
              transportResourceId: created.transportResourceId,
              actorId,
              actorLabel: this.contextPackageId(actorId),
              message: prompt,
              session: created.session,
              cwd: created.session.workspacePath,
              runtimeMode,
              context: {
                systemPromptSections: await this.loadSessionPromptSections(this.toInternalSessionRow(created.session))
              },
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
      listWorkflows: () => this.listRuntimeWorkflows(),
      startWorkflow: async (input) => await this.startWorkflowRun(input),
      inspectWorkflowRun: (runId) => this.deps.store.getWorkflowRun(runId),
      directSession: async ({ sessionId, transportResourceId, instruction, reason }) =>
        await this.deps.workManagement.directManagedSession({
          actorId,
          sessionId,
          transportResourceId: transportResourceId,
          instruction,
          reason
        }),
      resumeSession: async ({ transportResourceId, sessionId, reason }) =>
        await this.deps.workManagement.resumeManagedSession({
          actorId,
          transportResourceId,
          sessionId,
          reason
        }),
      archiveSession: async ({ transportResourceId, sessionId }) =>
        await this.deps.workManagement.archiveManagedSession({
          actorId,
          transportResourceId: transportResourceId,
          sessionId
        }),
      deleteArchivedSession: async ({ transportResourceId, sessionId }) =>
        await this.deps.workManagement.deleteManagedSession({
          actorId,
          transportResourceId: transportResourceId,
          sessionId
        }),
      archiveTransportResourceTarget: async ({ transportResourceId }) =>
        await this.deps.workManagement.archiveResourceTarget({
          actorId,
          transportResourceId: transportResourceId
        }),
      deleteArchivedTransportResourceTarget: async ({ transportResourceId }) =>
        await this.deps.workManagement.deleteArchivedResourceTarget({
          actorId,
          transportResourceId: transportResourceId
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
      sendMessage: async (transportResourceId, payload) => {
        await this.deps.postTransportMessage(actorId, transportResourceId, payload);
      },
      sendStatusUpdate: async (payload) => {
        const surfaceState = this.deps.getSurfaceState();
        if (surfaceState) {
          await this.deps.postTransportMessage(actorId, surfaceState.statusResourceId ?? this.deps.config.transport.scopeId, payload);
        }
      },
      appendAuditEvent: (event, payload) => {
        this.deps.appendAuditEvent(event, payload);
      },
      nowIso: () => this.deps.now(),
      runAgent: async ({
        surface,
        transportResourceId,
        actorId: promptActorId,
        actorLabel,
        message,
        attachments,
        session,
        cwd,
        runtimeMode,
        toolGrantIds,
        context: agentContext,
        agentKind,
        promptSource
      }) => {
        const activeSession =
          session
            ? this.toInternalSessionRow(session)
            : await this.deps.ensureCoordinationSession(transportResourceId, cwd ?? this.deps.coordinationWorkspacePath);
        const effectiveAgentKind: RuntimeAgentKind = agentKind ?? activeSession.agentKind ?? (session ? 'workspace' : 'ephemeral');
        const contributions = await this.deps.getPluginHost().contributeAgentContext(
            {
              surface,
              transportResourceId,
              actorId: promptActorId,
              actorLabel,
              text: message,
              attachments,
              session
            },
            (pluginId) => this.createContext(`plugin:${pluginId}`)
          );
        const contributionSystemSections = contributions.flatMap((entry) => entry.systemPromptSections ?? []);
        const contributionContext = contributions.flatMap((entry) => entry.perTurnContext ?? []);
        const contributionGrantIds = contributions.flatMap((entry) => entry.toolGrantIds ?? []);
        const policyGrants = this.deps.providerToolPolicy[effectiveAgentKind].grants ?? [];
        const resources = this.buildProviderResourceBundle([
          ...(agentContext?.systemPromptSections ?? []),
          ...contributionSystemSections
        ]);
        const providerContext = [
          {
            title: promptSource === 'orchestration' ? 'Orchestration instruction source' : 'Transport message source',
            content:
              promptSource === 'orchestration'
                ? `${actorLabel} (${promptActorId})`
                : describeTransportAuthor({
                    authorId: promptActorId,
                    authorUsername: actorLabel,
                    authorGlobalName: null,
                    authorDisplayName: actorLabel,
                    authorLabel: actorLabel
                  }),
            source: 'moorline/runtime'
          },
          ...((attachments ?? []).length > 0
            ? [{
                title: 'Attachment summary',
                content: `Attached image count: ${(attachments ?? []).length}`,
                source: 'moorline/runtime'
              }]
            : []),
          ...(agentContext?.perTurnContext ?? []),
          ...contributionContext
        ];
        const resolvedGrantIds = [
          ...(activeSession.toolGrantIds ?? []),
          ...policyGrants,
          ...(toolGrantIds ?? []),
          ...contributionGrantIds,
          ...(effectiveAgentKind === 'ephemeral' ? ['core.moorline_session'] : [])
        ];
        const providerTools = this.resolveProviderTools(effectiveAgentKind, resolvedGrantIds);
        const providerImages = await this.deps.prepareProviderImages(activeSession.threadId, attachments);
        const result = await this.deps.providerOrchestrator.runTurn({
          actorId,
          session: activeSession,
          transportResourceId: transportResourceId,
          surface,
          promptContent: message,
          promptSource,
          authorId: promptActorId,
          authorLabel: actorLabel,
          providerInput: {
            text: message,
            ...(providerImages && providerImages.length > 0 ? { images: providerImages } : {}),
            ...(providerContext.length > 0 ? { context: providerContext } : {})
          },
          providerResources: resources,
          providerTools,
          providerToolExecutor: this.createProviderToolExecutor(providerTools)
        });
        const formattedResult = this.deps.normalizeReply(
          result.text || (result.attachments?.length ? '' : 'I could not finish that cleanly.')
        );

        await this.deps.getPluginHost().afterAgentResponse(
          {
            surface,
            transportResourceId,
            actorId: promptActorId,
            actorLabel,
            text: message,
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

  private toInternalSessionRow(session: RuntimeSessionRow): RuntimeSessionRow {
    return session;
  }

  private buildProviderResourceBundle(systemPromptSections: string[]): ProviderResourceBundle {
    const skills = this.deps.skillRegistry.list().map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.path,
      baseDir: skill.path.replace(/[\\/]SKILL\.md$/, ''),
      metadata: skill.metadata as Record<string, unknown>
    }));
    return {
      systemPromptSections: systemPromptSections.map((section) => section.trim()).filter(Boolean),
      contextFiles: [],
      skills,
      promptTemplates: []
    };
  }

  private coreSessionTool(): RuntimeToolDefinition {
    return {
      name: 'moorline_session',
      description: 'Inspect, query, create, direct, archive, or delete Moorline managed sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['query', 'inspect', 'create', 'direct', 'archive', 'delete_archived']
          },
          session_id: { type: 'string' },
          transport_resource_id: { type: 'string' },
          requested_name: { type: 'string' },
          runtime_mode: { type: 'string' },
          instruction: { type: 'string' },
          objective: { type: 'string' },
          reason: { type: 'string' },
          include_archived: { type: 'boolean' },
          limit: { type: 'number' }
        },
        required: ['action'],
        additionalProperties: false
      },
      execute: async (input, context) => {
        const action = typeof input.action === 'string' ? input.action : '';
        const sessionId = typeof input.session_id === 'string' ? input.session_id.trim() : '';
        const transportResourceId = typeof input.transport_resource_id === 'string' ? input.transport_resource_id.trim() : '';
        switch (action) {
          case 'query': {
            return await this.deps.runGuardedAction({
              action: 'session.inspect',
              actor: context.actorId,
              target: 'sessions',
              title: 'Session query blocked',
              execute: async () => {
                const sessions = this.deps.snapshots.querySessions({
                  includeArchived: input.include_archived === true,
                  limit: typeof input.limit === 'number' ? input.limit : undefined
                });
                return {
                  content:
                    sessions.length === 0
                      ? 'No sessions matched.'
                      : [
                          'Sessions:',
                          ...sessions.map(({ session }) =>
                            [
                              `- ${session.sessionId}`,
                              `kind=${session.agentKind ?? 'workspace'}`,
                              `lifecycle=${session.lifecycleStatus}`,
                              `mode=${session.runtimeMode}`,
                              `provider=${session.providerStatus}`,
                              session.objective ? `objective=${session.objective}` : null
                            ].filter(Boolean).join(' | ')
                          )
                        ].join('\n')
                };
              }
            });
          }
          case 'inspect': {
            return await this.deps.runGuardedAction({
              action: 'session.inspect',
              actor: context.actorId,
              target: sessionId || transportResourceId || 'session',
              title: 'Session inspect blocked',
              execute: async () => {
                const snapshot = sessionId
                  ? this.deps.snapshots.getSessionById(sessionId)
                  : transportResourceId
                    ? this.deps.snapshots.getSessionByTransportResourceId(transportResourceId)
                    : null;
                return { content: snapshot ? JSON.stringify(snapshot, null, 2) : 'No matching session found.' };
              }
            });
          }
          case 'create': {
            const requestedName = typeof input.requested_name === 'string' ? input.requested_name.trim() : '';
            if (!requestedName) return { content: 'create error: requested_name is required.' };
            const runtimeMode = parseRuntimeModeName(input.runtime_mode, 'runtime_mode');
            return await this.deps.runGuardedAction({
              action: 'session.create',
              actor: context.actorId,
              target: requestedName,
              title: 'Session create blocked',
              execute: async () => {
                const created = await this.deps.workManagement.createManagedSession({
                  actorId: 'runtime:provider/tool',
                  requestedName,
                  runtimeMode,
                  objective: typeof input.objective === 'string' ? input.objective : undefined
                });
                return { content: `Created session ${created.session.sessionId} (${created.transportResourceId}).` };
              }
            });
          }
          case 'direct': {
            const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
            if (!instruction) return { content: 'direct error: instruction is required.' };
            return await this.deps.runGuardedAction({
              action: 'session.direct',
              actor: context.actorId,
              target: sessionId || transportResourceId || 'session',
              title: 'Session direct blocked',
              execute: async () => {
                const result = await this.deps.workManagement.directManagedSession({
                  actorId: 'runtime:provider/tool',
                  sessionId: sessionId || undefined,
                  transportResourceId: transportResourceId || undefined,
                  instruction,
                  reason: typeof input.reason === 'string' ? input.reason : undefined
                });
                return { content: `Directed session ${result.session.sessionId}.\n${result.reply.text ?? ''}`.trim() };
              }
            });
          }
          case 'archive': {
            return await this.deps.runGuardedAction({
              action: 'session.archive',
              actor: context.actorId,
              target: sessionId || transportResourceId || 'session',
              title: 'Session archive blocked',
              execute: async () => {
                const archived = await this.deps.workManagement.archiveManagedSession({
                  actorId: 'runtime:provider/tool',
                  sessionId: sessionId || undefined,
                  transportResourceId: transportResourceId || undefined
                });
                return { content: archived ? `Archived session ${archived.sessionId}.` : 'No matching session found.' };
              }
            });
          }
          case 'delete_archived': {
            return await this.deps.runGuardedAction({
              action: 'session.delete',
              actor: context.actorId,
              target: sessionId || transportResourceId || 'session',
              title: 'Session delete blocked',
              execute: async () => {
                const deleted = await this.deps.workManagement.deleteManagedSession({
                  actorId: 'runtime:provider/tool',
                  sessionId: sessionId || undefined,
                  transportResourceId: transportResourceId || undefined
                });
                return { content: deleted ? `Deleted archived session ${deleted.sessionId}.` : 'No matching archived session found.' };
              }
            });
          }
          default:
            return { content: 'moorline_session error: unknown action.' };
        }
      }
    };
  }

  private coreSkillLoadTool(): RuntimeToolDefinition {
    return {
      name: 'moorline_skill.load',
      description: 'Load a Moorline-managed skill by name.',
      requiredCapability: 'fs.read',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }
        },
        required: ['name'],
        additionalProperties: false
      },
      execute: async (input) => {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name) {
          return { content: 'moorline_skill.load error: name is required.' };
        }
        const skill = await this.deps.skillRegistry.load(name);
        return {
          content: skill ? JSON.stringify(skill, null, 2) : `No matching skill found: ${name}`
        };
      }
    };
  }

  private coreWorkflowTool(): RuntimeToolDefinition {
    return {
      name: 'workflow',
      description: 'List, start, or inspect Moorline workflows.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'start', 'inspect']
          },
          package_id: { type: 'string' },
          workflow_id: { type: 'string' },
          run_id: { type: 'string' },
          input: { type: 'object' },
          transport_resource_id: { type: 'string' },
          session_id: { type: 'string' },
          thread_id: { type: 'string' },
          source_event_id: { type: 'string' }
        },
        required: ['action'],
        additionalProperties: false
      },
      execute: async (input, context) => {
        const action = typeof input.action === 'string' ? input.action : '';
        switch (action) {
          case 'list': {
            return {
              content: JSON.stringify(
                this.listRuntimeWorkflows().map((workflow) => ({
                  packageId: workflow.packageId,
                  workflowId: workflow.id,
                  title: workflow.title,
                  description: workflow.description ?? null,
                  requiredCapability: workflow.requiredCapability ?? null,
                  trigger: workflow.trigger ?? null
                })),
                null,
                2
              )
            };
          }
          case 'inspect': {
            const runId = typeof input.run_id === 'string' ? input.run_id.trim() : '';
            if (!runId) {
              return { content: 'workflow inspect error: run_id is required.' };
            }
            const run = this.deps.store.getWorkflowRun(runId);
            return { content: run ? JSON.stringify(run, null, 2) : `No workflow run found: ${runId}` };
          }
          case 'start': {
            const workflowId = typeof input.workflow_id === 'string' ? input.workflow_id.trim() : '';
            if (!workflowId) {
              return { content: 'workflow start error: workflow_id is required.' };
            }
            const origin: RuntimeWorkflowRunOrigin = {};
            if (typeof input.transport_resource_id === 'string' && input.transport_resource_id.trim()) {
              origin.transportResourceId = input.transport_resource_id.trim();
            }
            if (typeof input.session_id === 'string' && input.session_id.trim()) {
              origin.sessionId = input.session_id.trim();
            }
            if (typeof input.thread_id === 'string' && input.thread_id.trim()) {
              origin.threadId = input.thread_id.trim();
            }
            if (typeof input.source_event_id === 'string' && input.source_event_id.trim()) {
              origin.sourceEventId = input.source_event_id.trim();
            }
            const started = await this.startWorkflowRun({
              packageId: typeof input.package_id === 'string' && input.package_id.trim() ? input.package_id.trim() : undefined,
              workflowId,
              input: this.safeRecord(input.input),
              actor: { actorId: context.actorId },
              ...(Object.keys(origin).length > 0 ? { origin } : {})
            });
            return { content: JSON.stringify(started, null, 2) };
          }
          default:
            return { content: 'workflow error: unknown action.' };
        }
      }
    };
  }

  private coreSkillSaveTool(): RuntimeToolDefinition {
    return {
      name: 'moorline_skill.save',
      description: 'Create or update a Moorline-managed runtime skill.',
      requiredCapability: 'fs.write',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          body: { type: 'string' },
          directory_name: { type: 'string' },
          resource_files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' }
              },
              required: ['path', 'content'],
              additionalProperties: false
            }
          }
        },
        required: ['name', 'body'],
        additionalProperties: false
      },
      execute: async (input, context) => {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        const body = typeof input.body === 'string' ? input.body : '';
        if (!name) {
          return { content: 'moorline_skill.save error: name is required.' };
        }
        if (!body.trim()) {
          return { content: 'moorline_skill.save error: body is required.' };
        }
        const resourceFiles = Array.isArray(input.resource_files)
          ? input.resource_files
              .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
              .map((entry) => ({
                path: typeof entry.path === 'string' ? entry.path : '',
                content: typeof entry.content === 'string' ? entry.content : ''
              }))
          : [];
        const written = writeSkill({
          rootDir: join(this.deps.runtimeRoot, 'packages', 'skills'),
          name,
          description: typeof input.description === 'string' ? input.description : undefined,
          tags: Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
          body,
          directoryName: typeof input.directory_name === 'string' ? input.directory_name : undefined,
          resourceFiles
        });
        this.deps.skillRegistry.invalidateCache();
        recordHistoryCheckpoint({
          homeRoot: this.deps.homeRoot,
          actor: context.actorId,
          reason: `Updated skill ${name}.`,
          operation: `provider tool write skill ${typeof input.directory_name === 'string' ? input.directory_name : name}`,
          absoluteTargets: [written.skillDir]
        });
        return { content: JSON.stringify(written, null, 2) };
      }
    };
  }

  private allProviderRuntimeTools(): RuntimeToolDefinition[] {
    return [
      { ...this.coreSessionTool(), pluginId: 'core' },
      { ...this.coreWorkflowTool(), pluginId: 'core' },
      { ...this.coreSkillLoadTool(), pluginId: 'core' },
      { ...this.coreSkillSaveTool(), pluginId: 'core' },
      ...this.deps.getPluginHost().listTools((pluginId) => this.createContext(`plugin:${pluginId}`))
    ];
  }

  private toolId(tool: RuntimeToolDefinition): string {
    return tool.pluginId === 'core' ? `core.${tool.name}` : `plugin:${tool.pluginId ?? 'unknown'}.${tool.name}`;
  }

  private resolveProviderTools(agentKind: RuntimeAgentKind, grantIds: string[]): ProviderToolDefinition[] {
    const grants = new Set(grantIds);
    if (agentKind === 'ephemeral') {
      grants.add('core.moorline_session');
    }
    return this.allProviderRuntimeTools()
      .filter((tool) => grants.has(this.toolId(tool)))
      .map((tool) => ({
        id: this.toolId(tool),
        name: tool.name,
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
        ...(tool.requiredCapability ? { requiredCapability: tool.requiredCapability } : {}),
        source: tool.pluginId === 'core' ? 'core' : 'plugin',
        ...(tool.pluginId && tool.pluginId !== 'core' ? { ownerPackageId: tool.pluginId } : {})
      }));
  }

  private createProviderToolExecutor(tools: ProviderToolDefinition[]): ProviderToolExecutor {
    const allowed = new Set(tools.map((tool) => tool.id));
    return {
      executeProviderTool: async ({ toolId, arguments: args, actor }) => {
        if (!allowed.has(toolId)) {
          throw new Error(`Provider tool is not granted for this session: ${toolId}`);
        }
        const runtimeTool = this.allProviderRuntimeTools().find((tool) => this.toolId(tool) === toolId);
        if (!runtimeTool) {
          throw new Error(`Unknown provider tool: ${toolId}`);
        }
        const context = this.createContext(runtimeTool.pluginId && runtimeTool.pluginId !== 'core' ? `plugin:${runtimeTool.pluginId}` : actor);
        const run = async () => await runtimeTool.execute(args, context);
        try {
          const result = runtimeTool.requiredCapability
            ? await this.deps.runGuardedAction({
                action: runtimeTool.requiredCapability,
                actor,
                target: toolId,
                title: 'Provider tool blocked',
                execute: run
              })
            : await run();
          this.deps.appendAuditEvent('provider.tool.executed', {
            actor,
            toolId,
            ownerPackageId: runtimeTool.pluginId ?? 'core',
            ok: true
          });
          return { content: result.content };
        } catch (error) {
          this.deps.appendAuditEvent('provider.tool.executed', {
            actor,
            toolId,
            ownerPackageId: runtimeTool.pluginId ?? 'core',
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      }
    };
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
      sessions.find((entry) => entry.transportResourceId === normalized) ??
      sessions.find((entry) => entry.threadId === normalized) ??
      null;
    if (!session) {
      throw new Error(`Session-scoped sidecars require a known session identity. No session matches ${candidate}.`);
    }
    return session.sessionId;
  }
}
