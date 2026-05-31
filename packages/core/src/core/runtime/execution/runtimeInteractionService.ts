import type { AppliedMoorlineConfig } from '../../../types/config.js';
import type { RuntimePluginContext } from '../../../types/plugin.js';
import type { RuntimeActionDefinition, RuntimeMessagePayload, RuntimeTransportEvent } from '../../../types/transport.js';
import type { PluginHost } from '../../extension/plugins/pluginHost.js';
import type { RuntimeSnapshotQuery } from '../../system/projection/runtimeSnapshotQuery.js';
import type { SessionLifecycleService } from '../../domain/sessions/sessionLifecycleService.js';
import type { SessionRegistry } from '../../domain/sessions/sessionState.js';
import { PendingRequestActionError } from './runtimePendingRequestService.js';

type RuntimeMessageReceivedEvent = Extract<RuntimeTransportEvent, { type: 'message.received' }>;
type RuntimeActionInvokedEvent = Extract<RuntimeTransportEvent, { type: 'action.invoked' }>;

const ARCHIVED_SESSION_MESSAGE =
  'This session is archived. Create a new session if you want Moorline to continue work.';
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
  getNamespaceReady(): boolean;
  getAcceptingNewWork(): boolean;
  postTransportMessage(actor: string, spaceId: string, payload: RuntimeMessagePayload): Promise<void>;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  createPluginContext(actorId: string): RuntimePluginContext;
  isAdminActor(input: RuntimeMessageReceivedEvent['actor']): boolean;
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
    requestActor: RuntimeActionInvokedEvent['actor'];
  }): Promise<void>;
}

export class RuntimeInteractionService {
  constructor(private readonly deps: RuntimeInteractionServiceDeps) {}

  async handleTransportEvent(event: RuntimeTransportEvent): Promise<void> {
    if (event.scopeId !== this.deps.config.transport.scopeId || !this.deps.getNamespaceReady()) {
      return;
    }
    if (event.type === 'message.received') {
      await this.handleMessage(event);
      return;
    }
    if (event.type === 'action.invoked') {
      if (this.shouldBypassActionQueue(event)) {
        await this.handleAction(event);
        return;
      }
      const queueKey = event.spaceId ?? `actor:${event.actor.actorId}`;
      await this.deps.queue(queueKey, async () => {
        await this.handleAction(event);
      });
      return;
    }
    await this.deps.getPluginHost().handleTransportEvent(event, (pluginId) =>
      this.deps.createPluginContext(`plugin:${pluginId}`)
    );
  }

  private shouldBypassActionQueue(event: RuntimeActionInvokedEvent): boolean {
    return this.actionPolicy(event.actionId)?.bypassQueue === true;
  }

  private async handleMessage(event: RuntimeMessageReceivedEvent): Promise<void> {
    await this.deps.queue(event.spaceId, async () => {
      if (!this.deps.getAcceptingNewWork()) {
        await this.deps.postTransportMessage('runtime:status', event.spaceId, {
          text: 'Moorline is currently draining work and is not accepting new messages.'
        });
        return;
      }

      const session = this.deps.sessionRegistry.getBySpaceId(event.spaceId);
      if (session) {
        if (session.lifecycleStatus === 'archived') {
          await this.deps.postTransportMessage('runtime:archived-session', event.spaceId, {
            text: ARCHIVED_SESSION_MESSAGE
          });
          this.deps.appendAuditEvent('session.archived.message_ignored', {
            sessionId: session.sessionId,
            spaceId: session.spaceId,
            actorId: event.actor.actorId
          });
          return;
        }
        this.deps.sessionLifecycle.recordActivity(session.threadId, this.deps.now());
      }

      const result = await this.deps.getPluginHost().handleTransportEvent(event, (pluginId) =>
        this.deps.createPluginContext(`plugin:${pluginId}`)
      );
      if (result.reply) {
        await this.deps.postTransportMessage('runtime:plugin/action', event.spaceId, result.reply);
      }
      if (result.audit) {
        this.deps.appendAuditEvent(result.audit.event, result.audit.payload ?? {});
      }
    });
  }

  private async handleAction(event: RuntimeActionInvokedEvent): Promise<void> {
    if (!this.deps.getAcceptingNewWork() && !this.isAllowedWhileDraining(event.actionId)) {
      await this.replyToAction(event, DRAINING_ACTION_DENIED_MESSAGE);
      return;
    }
    if (event.actionId === 'runtime.pending_request.respond') {
      if (await this.handlePendingRequestAction(event)) {
        return;
      }
    }
    const result = await this.deps.getPluginHost().handleTransportEvent(event, (pluginId) =>
      this.deps.createPluginContext(`plugin:${pluginId}`)
    );
    if (result.reply && event.spaceId) {
      await this.deps.postTransportMessage('runtime:plugin/action', event.spaceId, result.reply);
    }
    if (result.audit) {
      this.deps.appendAuditEvent(result.audit.event, result.audit.payload ?? {});
    }
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

  private async replyToAction(event: RuntimeActionInvokedEvent, message: string): Promise<void> {
    if (hasNativeReply(event.native?.payload)) {
      await event.native.payload.reply({
        content: message,
        ephemeral: true
      });
      return;
    }
    if (event.spaceId) {
      await this.deps.postTransportMessage('runtime:status', event.spaceId, {
        text: message
      });
    }
  }

  private async handlePendingRequestAction(event: RuntimeActionInvokedEvent): Promise<boolean> {
    const requestId = stringInput(event.input, 'requestId');
    const decision = stringInput(event.input, 'decision');
    if (!requestId || (decision !== 'accept' && decision !== 'decline' && decision !== 'cancel')) {
      return false;
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
