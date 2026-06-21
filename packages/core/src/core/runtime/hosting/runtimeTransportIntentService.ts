import type { AppliedMoorlineConfig } from '../../../types/config.js';
import type { RuntimeTransportIntent } from '../../../types/transport.js';
import type { SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import type { RuntimeWorkManagementService } from '../../domain/sessions/runtimeWorkManagementService.js';
import type { RuntimeInteractionService } from '../execution/runtimeInteractionService.js';

interface RuntimeTransportIntentServiceDeps {
  config: AppliedMoorlineConfig;
  store: SqliteSessionStore;
  workManagement: RuntimeWorkManagementService;
  interactions: RuntimeInteractionService;
  now(): string;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
}

function transportActorId(intent: RuntimeTransportIntent): string {
  if ('actor' in intent && intent.actor?.actorId) {
    return intent.actor.actorId;
  }
  return `transport:${intent.transportPackageId ?? 'unknown'}`;
}

function intentQueueKey(intent: RuntimeTransportIntent): string {
  if ('transportResourceId' in intent && typeof intent.transportResourceId === 'string') {
    return intent.transportResourceId;
  }
  if (intent.type === 'transport.resource.observed') {
    return intent.resource.id;
  }
  return `transport:${intent.scopeId}:${intent.type}`;
}

export class RuntimeTransportIntentService {
  constructor(private readonly deps: RuntimeTransportIntentServiceDeps) {}

  async handleIntent(intent: RuntimeTransportIntent): Promise<void> {
    if (intent.scopeId !== this.deps.config.transport.scopeId) {
      return;
    }
    const inserted = this.deps.store.appendTransportIntent(intent).inserted;
    if (!inserted) {
      return;
    }
    await this.processRecordedIntent(intent);
  }

  async drainPendingIntents(limit = 100): Promise<number> {
    let drained = 0;
    while (true) {
      const pending = this.deps.store.listPendingTransportIntents(limit).filter((intent) => intent.scopeId === this.deps.config.transport.scopeId);
      if (pending.length === 0) {
        return drained;
      }
      drained += pending.length;
      for (const intent of pending) {
        try {
          await this.processRecordedIntent(intent);
        } catch {
          // Failed pending intents are marked by processRecordedIntent and should not block later intents.
        }
      }
    }
  }

  private async processRecordedIntent(intent: RuntimeTransportIntent): Promise<void> {
    try {
      await this.processIntent(intent);
      this.deps.store.markTransportIntentProcessed(intent.intentId, this.deps.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.markTransportIntentFailed(intent.intentId, this.deps.now(), message);
      this.deps.appendAuditEvent('transport.intent.failed', {
        intentId: intent.intentId,
        type: intent.type,
        key: intentQueueKey(intent),
        error: message
      });
      throw error;
    }
  }

  private async processIntent(intent: RuntimeTransportIntent): Promise<void> {
    switch (intent.type) {
      case 'transport.message.received':
        await this.resumeSessionForMessageIfNeeded(intent);
        await this.deps.interactions.handleTransportIntent(intent);
        return;
      case 'transport.action.invoked':
        await this.deps.interactions.handleTransportIntent(intent);
        return;
      case 'transport.session.ensure': {
        const session = await this.deps.workManagement.bindManagedSessionToTransportResource({
          actorId: transportActorId(intent),
          transportResourceId: intent.transportResourceId,
          transportResourceName: intent.requestedName,
          requestedName: intent.requestedName,
          runtimeMode: intent.runtimeMode ?? this.deps.config.defaults.runtimeMode,
          owner: intent.owner
        });
        if (intent.initialMessage && intent.actor) {
          await this.deps.interactions.handleTransportIntent({
            ...intent,
            intentId: `${intent.intentId}:initial-message`,
            occurredAt: this.deps.now(),
            type: 'transport.message.received',
            transportResourceId: session.transportResourceId,
            actor: intent.actor,
            message: intent.initialMessage
          });
        }
        return;
      }
      case 'transport.session.delete':
        await this.deps.workManagement.deleteManagedSessionNow({
          actorId: transportActorId(intent),
          transportResourceId: intent.transportResourceId,
          deleteWorkspace: intent.deleteWorkspace,
          reason: intent.reason
        });
        return;
      case 'transport.session.archive':
        await this.deps.workManagement.archiveManagedSession({
          actorId: transportActorId(intent),
          transportResourceId: intent.transportResourceId
        });
        return;
      case 'transport.session.resume':
        await this.deps.workManagement.resumeManagedSession({
          actorId: transportActorId(intent),
          transportResourceId: intent.transportResourceId,
          reason: intent.reason
        });
        return;
      case 'transport.resource.observed':
        this.deps.appendAuditEvent('transport.resource.observed', {
          scopeId: intent.scopeId,
          resourceId: intent.resource.id,
          resourceName: intent.resource.name,
          action: intent.action,
          parentId: intent.resource.parentId ?? null
        });
        return;
      case 'transport.external.received':
        await this.deps.interactions.handleTransportIntent(intent);
        return;
    }
  }

  private async resumeSessionForMessageIfNeeded(
    intent: Extract<RuntimeTransportIntent, { type: 'transport.message.received' }>
  ): Promise<void> {
    const session = this.deps.store.getSessionByTransportResourceId(intent.transportResourceId);
    if (!session || session.lifecycleStatus !== 'archived') {
      return;
    }
    await this.deps.workManagement.resumeManagedSession({
      actorId: intent.actor.actorId,
      transportResourceId: intent.transportResourceId,
      reason: 'Transport message received for archived session'
    });
  }
}
