import type { AppliedMoorlineConfig } from '../../../types/config.js';
import type { RuntimePluginContext, RuntimeWorkflowDefinitionWithPackage, RuntimeWorkflowRunOrigin } from '../../../types/plugin.js';
import type { RuntimeExternalResourceRef } from '../../../types/external.js';
import type { RuntimeActionDefinition, RuntimeMessagePayload, RuntimeTransportIntent } from '../../../types/transport.js';
import type { PluginHost } from '../../extension/plugins/pluginHost.js';
import type { RuntimeSnapshotQuery } from '../../system/projection/runtimeSnapshotQuery.js';
import type { SessionLifecycleService } from '../../domain/sessions/sessionLifecycleService.js';
import type { SessionRegistry } from '../../domain/sessions/sessionState.js';
import { PendingRequestActionError } from './runtimePendingRequestService.js';

type RuntimeMessageReceivedIntent = Extract<RuntimeTransportIntent, { type: 'transport.message.received' }>;
type RuntimeActionInvokedIntent = Extract<RuntimeTransportIntent, { type: 'transport.action.invoked' }>;

const DRAINING_ACTION_DENIED_MESSAGE =
  'Moorline is currently draining work. Only status, control, and pending-request commands are allowed.';
const BUILT_IN_ACTION_POLICIES: Record<string, NonNullable<RuntimeActionDefinition['policy']>> = {
  'runtime.pending_request.respond': {
    allowedWhileDraining: true,
    bypassQueue: true
  }
};

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

function hasNativeReply(
  payload: unknown
): payload is {
  reply(input: { content: string; ephemeral?: boolean }): Promise<void>;
} {
  return !!payload && typeof payload === 'object' && typeof (payload as { reply?: unknown }).reply === 'function';
}

interface RuntimeInteractionServiceDeps {
  config: AppliedMoorlineConfig;
  sessionRegistry: SessionRegistry;
  sessionLifecycle: SessionLifecycleService;
  snapshots: RuntimeSnapshotQuery;
  getPluginHost(): PluginHost;
  queue<T>(key: string, work: () => Promise<T>): Promise<T>;
  now(): string;
  getSurfaceReady(): boolean;
  getAcceptingNewWork(): boolean;
  postTransportMessage(actor: string, transportResourceId: string, payload: RuntimeMessagePayload): Promise<void>;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  upsertExternalResource(resource: RuntimeExternalResourceRef): void;
  createPluginContext(actorId: string): RuntimePluginContext;
  isAdminActor(input: RuntimeMessageReceivedIntent['actor']): boolean;
  respondToProviderRequest(
    actorId: string,
    threadId: string,
    requestId: string,
    decision: 'accept' | 'decline' | 'cancel',
    deniedTitle: string,
    metadata?: Record<string, unknown>
  ): Promise<void>;
  resolvePendingRequest(input: {
    actorId: string;
    requestId: string;
    decision: 'accept' | 'decline' | 'cancel';
    deniedTitle: string;
    metadata?: Record<string, unknown>;
    requestActor: RuntimeActionInvokedIntent['actor'];
  }): Promise<void>;
  resolveRuntimeToolApproval(input: {
    requestId: string;
    decision: 'accept' | 'decline' | 'cancel';
    actor: RuntimeActionInvokedIntent['actor'];
  }): Promise<string | null>;
}

export class RuntimeInteractionService {
  constructor(private readonly deps: RuntimeInteractionServiceDeps) {}

  async handleTransportIntent(intent: RuntimeTransportIntent): Promise<void> {
    if (intent.scopeId !== this.deps.config.transport.scopeId || !this.deps.getSurfaceReady()) {
      return;
    }
    if (intent.type === 'transport.message.received') {
      await this.handleMessage(intent);
      return;
    }
    if (intent.type === 'transport.action.invoked') {
      if (this.shouldBypassActionQueue(intent)) {
        await this.handleAction(intent);
        return;
      }
      const queueKey = intent.transportResourceId ?? `actor:${intent.actor.actorId}`;
      await this.deps.queue(queueKey, async () => {
        await this.handleAction(intent);
      });
      return;
    }
    if (intent.type === 'transport.external.received' && intent.resource) {
      this.deps.upsertExternalResource(intent.resource);
    }
    await this.deps.getPluginHost().handleTransportIntent(intent, (pluginId) =>
      this.deps.createPluginContext(`plugin:${pluginId}`)
    );
  }

  private shouldBypassActionQueue(event: RuntimeActionInvokedIntent): boolean {
    return this.actionPolicy(event.actionId)?.bypassQueue === true;
  }

  private async handleMessage(event: RuntimeMessageReceivedIntent): Promise<void> {
    await this.deps.queue(event.transportResourceId, async () => {
      if (!this.deps.getAcceptingNewWork()) {
        await this.deps.postTransportMessage('runtime:status', event.transportResourceId, {
          text: 'Moorline is currently draining work and is not accepting new messages.'
        });
        return;
      }

      const session = this.deps.sessionRegistry.getByTransportResourceId(event.transportResourceId);
      if (session) {
        this.deps.sessionLifecycle.recordActivity(session.threadId, this.deps.now());
      }

      const result = await this.deps.getPluginHost().handleTransportIntent(event, (pluginId) =>
        this.deps.createPluginContext(`plugin:${pluginId}`)
      );
      if (result.reply) {
        await this.deps.postTransportMessage('runtime:plugin/action', event.transportResourceId, result.reply);
      }
      if (result.audit) {
        this.deps.appendAuditEvent(result.audit.event, result.audit.payload ?? {});
      }
    });
  }

  private async handleAction(event: RuntimeActionInvokedIntent): Promise<void> {
    if (!this.deps.getAcceptingNewWork() && !this.isAllowedWhileDraining(event.actionId)) {
      await this.replyToAction(event, DRAINING_ACTION_DENIED_MESSAGE);
      return;
    }
    if (event.actionId === 'runtime.pending_request.respond') {
      if (await this.handlePendingRequestAction(event)) {
        return;
      }
    }
    if (await this.handleWorkflowAction(event)) {
      return;
    }
    const result = await this.deps.getPluginHost().handleTransportIntent(event, (pluginId) =>
      this.deps.createPluginContext(`plugin:${pluginId}`)
    );
    if (result.reply && event.transportResourceId) {
      await this.deps.postTransportMessage('runtime:plugin/action', event.transportResourceId, result.reply);
    }
    if (result.audit) {
      this.deps.appendAuditEvent(result.audit.event, result.audit.payload ?? {});
    }
  }

  private async handleWorkflowAction(event: RuntimeActionInvokedIntent): Promise<boolean> {
    const workflow = this.workflowForAction(event.actionId);
    if (!workflow) {
      return false;
    }
    if (workflow.trigger?.sessionOnly && !event.transportResourceId) {
      await this.replyToAction(event, `${workflow.title} must be started from a session transport resource.`);
      return true;
    }

    const origin: RuntimeWorkflowRunOrigin = { sourceEventId: event.intentId };
    if (event.transportResourceId) {
      origin.transportResourceId = event.transportResourceId;
      const session = this.deps.sessionRegistry.getByTransportResourceId(event.transportResourceId);
      if (session) {
        origin.sessionId = session.sessionId;
        origin.threadId = session.threadId;
      }
    }

    try {
      if (workflow.setup?.enabled) {
        const setup = this.deps.createPluginContext('runtime:workflow-action').startWorkflowSetup({
          packageId: workflow.packageId,
          workflowId: workflow.id,
          actor: event.actor,
          origin
        });
        await this.replyToAction(
          event,
          [`Started workflow setup: ${workflow.title} (${setup.setupId}).`, setup.currentQuestion].filter(Boolean).join('\n\n')
        );
        return true;
      }
      const started = await this.deps.createPluginContext('runtime:workflow-action').startWorkflow({
        packageId: workflow.packageId,
        workflowId: workflow.id,
        input: event.input,
        actor: event.actor,
        origin
      });
      await this.replyToAction(event, `Started workflow: ${workflow.title} (${started.runId}).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.replyToAction(event, `Workflow start failed: ${message}`);
    }
    return true;
  }

  private workflowForAction(actionId: string): RuntimeWorkflowDefinitionWithPackage | null {
    const action = this.deps.getPluginHost().listActions((pluginId) =>
      this.deps.createPluginContext(`plugin:${pluginId}`)
    ).find((entry) => entry.id === actionId);
    const workflowMetadata = action?.metadata?.workflow;
    if (!workflowMetadata || typeof workflowMetadata !== 'object' || Array.isArray(workflowMetadata)) {
      return null;
    }
    const workflowRecord = workflowMetadata as { id?: unknown; packageId?: unknown };
    if (typeof workflowRecord.id !== 'string' || typeof workflowRecord.packageId !== 'string') {
      return null;
    }
    return (
      this.deps
        .createPluginContext('runtime:workflow-action')
        .listWorkflows()
        .find((workflow) => workflow.id === workflowRecord.id && workflow.packageId === workflowRecord.packageId) ?? null
    );
  }

  private isAllowedWhileDraining(actionId: string): boolean {
    return this.actionPolicy(actionId)?.allowedWhileDraining === true;
  }

  private actionPolicy(actionId: string): RuntimeActionDefinition['policy'] | null {
    const builtIn = BUILT_IN_ACTION_POLICIES[actionId];
    if (builtIn) {
      return builtIn;
    }
    const action = this.deps.getPluginHost().listActions((pluginId) =>
      this.deps.createPluginContext(`plugin:${pluginId}`)
    ).find((entry) => entry.id === actionId);
    return action?.policy ?? null;
  }

  private async replyToAction(event: RuntimeActionInvokedIntent, message: string): Promise<void> {
    if (hasNativeReply(event.native?.payload)) {
      await event.native.payload.reply({
        content: message,
        ephemeral: true
      });
      return;
    }
    if (event.transportResourceId) {
      await this.deps.postTransportMessage('runtime:status', event.transportResourceId, {
        text: message
      });
    }
  }

  private async handlePendingRequestAction(event: RuntimeActionInvokedIntent): Promise<boolean> {
    const requestId = stringInput(event.input, 'requestId');
    const decision = stringInput(event.input, 'decision');
    if (!requestId || (decision !== 'accept' && decision !== 'decline' && decision !== 'cancel')) {
      return false;
    }
    const runtimeToolApproval = await this.deps.resolveRuntimeToolApproval({
      requestId,
      decision,
      actor: event.actor
    });
    if (runtimeToolApproval !== null) {
      await this.replyToAction(event, runtimeToolApproval);
      return true;
    }
    try {
      await this.deps.resolvePendingRequest({
        actorId: 'runtime:pending-request-action',
        requestId,
        decision,
        deniedTitle: 'Provider approval response blocked',
        metadata: { source: 'action', actionId: event.actionId },
        requestActor: event.actor
      });
    } catch (error) {
      if (error instanceof PendingRequestActionError) {
        await this.replyToAction(event, error.message);
        return true;
      }
      throw error;
    }
    const responseText =
      decision === 'accept' ? `Approved request ${requestId}.` : decision === 'decline' ? `Declined request ${requestId}.` : `Cancelled request ${requestId}.`;
    await this.replyToAction(event, responseText);
    return true;
  }
}
