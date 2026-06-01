import type { ProviderRuntimeEvent } from '../../../../types/runtime.js';
import type { RuntimePluginContext } from '../../../../types/plugin.js';
import type { RuntimeSessionRow } from '../../../system/state/sqliteSessionStore.js';
import type { RuntimeIngestion } from '../runtimeIngestion.js';
import type { CanonicalEventLogStore } from '../../../system/state/canonicalEventLogStore.js';
import type { RuntimeReceiptBus } from '../runtimeReceiptBus.js';
import type { PluginHost } from '../../../extension/plugins/pluginHost.js';
import { domainEventsFromProviderEvent } from '../runtimeDomain.js';
import type { ProviderAttachmentResolver } from './providerAttachmentResolver.js';
import type { ProviderCompactionPolicy } from './providerCompactionPolicy.js';
import type { ProviderRequestProjector } from './providerRequestProjector.js';
import type { ProviderTurnBroker } from './providerTurnBroker.js';
import type { ProviderProjectionPort } from './ports.js';

interface ProviderEventPipelineDeps extends ProviderProjectionPort {
  canonicalEvents: CanonicalEventLogStore;
  ingestion: RuntimeIngestion;
  receiptBus: RuntimeReceiptBus;
  compaction: ProviderCompactionPolicy;
  requests: ProviderRequestProjector;
  turns: ProviderTurnBroker;
  attachments: ProviderAttachmentResolver;
  getPluginHost(): PluginHost;
  createPluginContext(actorId: string): RuntimePluginContext;
  getSessionByThreadId(threadId: string): RuntimeSessionRow | null;
}

export class ProviderEventPipeline {
  constructor(private readonly deps: ProviderEventPipelineDeps) {}

  async handleProviderEvent(event: ProviderRuntimeEvent): Promise<void> {
    const session = this.deps.getSessionByThreadId(event.threadId);
    const spaceId = session?.spaceId ?? (event.threadId.startsWith('chat:') ? event.threadId.slice(5) : null);

    const canonicalPersistence = this.deps.canonicalEvents.append(event, spaceId);
    if (!canonicalPersistence.inserted && this.deps.canonicalEvents.isProviderEventProcessed(event.eventId)) {
      return;
    }

    this.deps.ingestion.ingestProviderEvent(event);
    await this.deps.compaction.handleEvent(event);
    await this.deps.getPluginHost().onRuntimeEvent(event, (pluginId) => this.deps.createPluginContext(`plugin:${pluginId}`));

    if (event.type === 'session.state.changed' && (event.payload.state === 'closed' || event.payload.state === 'error')) {
      this.deps.compaction.clearLatch(event.threadId);
      this.deps.turns.onProviderFailure(
        event.threadId,
        event.payload.reason ?? `Provider session ${event.payload.state} before the active turn completed.`
      );
    }

    if (event.type === 'runtime.error') {
      this.deps.compaction.clearLatch(event.threadId);
      this.deps.turns.onProviderFailure(event.threadId, event.payload.message);
    }

    const latestRequest = await this.deps.requests.project(event, {
      spaceId,
      waiterAuthorId: null
    });

    if (event.type === 'content.delta') {
      this.deps.turns.onContentDelta(event);
      const currentReceipt = this.deps.receiptBus.current(event.threadId);
      if (currentReceipt) {
        this.deps.receiptBus.publish({
          ...currentReceipt,
          lastAssistantText: `${currentReceipt.lastAssistantText ?? ''}${event.payload.delta}`,
          updatedAt: event.createdAt
        });
      }
    }

    if (event.type === 'item.completed' && event.payload.localPath) {
      const attachment = this.deps.attachments.resolve(event.threadId, event.payload.localPath, event.eventId);
      this.deps.turns.onItemCompleted(event as ProviderRuntimeEvent & { type: 'item.completed' }, attachment);
    }

    if (event.type === 'turn.completed') {
      this.deps.turns.onTurnCompleted(event);
    }

    if (event.type === 'turn.aborted') {
      this.deps.turns.onTurnAborted(event);
    }

    const latestSession = this.deps.getSessionByThreadId(event.threadId);
    const domainEvents = domainEventsFromProviderEvent({
      event,
      sessionId: latestSession?.sessionId ?? null,
      spaceId,
      runtimeMode: latestSession?.runtimeMode ?? null,
      workspacePath: latestSession?.workspacePath ?? null,
      request: latestRequest
    });
    for (const domainEvent of domainEvents) {
      await this.deps.handleDomainEvent(domainEvent);
    }
    this.deps.canonicalEvents.markProviderEventProcessed(event.eventId, event.createdAt);
  }
}
