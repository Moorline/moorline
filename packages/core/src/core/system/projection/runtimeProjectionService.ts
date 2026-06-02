import { randomUUID } from 'node:crypto';
import type { RuntimeDomainEvent } from '../../runtime/execution/runtimeDomain.js';
import type { RuntimeIngestion } from '../../runtime/execution/runtimeIngestion.js';
import type { RuntimeReceiptBus } from '../../runtime/execution/runtimeReceiptBus.js';
import type { OrchestrationEngine } from '../../runtime/execution/orchestrationEngine.js';
import type { PluginHost } from '../../extension/plugins/pluginHost.js';
import type { RuntimePluginContext } from '../../../types/plugin.js';
import type { ProjectionStateStore } from '../projection/projectionStateStore.js';
import type { RuntimeActivityRecord } from '../projection/runtimeActivityStore.js';
import type { RuntimeSnapshotQuery } from '../projection/runtimeSnapshotQuery.js';
import type { PendingRequestProjectionStore } from '../projection/pendingRequestProjectionStore.js';
import type { PendingRuntimeRequestRecord } from '../../../types/runtime.js';
import type { RuntimeMessagePayload } from '../../../types/transport.js';
import type { SqliteSessionStore } from '../state/sqliteSessionStore.js';
import type { RuntimeReconciler } from '../projection/runtimeReconciler.js';

interface RuntimeProjectionServiceDeps {
  store: SqliteSessionStore;
  snapshots: RuntimeSnapshotQuery;
  ingestion: RuntimeIngestion;
  receiptBus: RuntimeReceiptBus;
  pendingRequests: PendingRequestProjectionStore;
  projectionState: ProjectionStateStore;
  orchestration: OrchestrationEngine;
  reconciler: RuntimeReconciler;
  queue<T>(key: string, work: () => Promise<T>): Promise<T>;
  now(): string;
  getPluginHost(): PluginHost;
  createPluginContext(actorId: string): RuntimePluginContext;
  sendStatusUpdate(payload: RuntimeMessagePayload): Promise<void>;
  postRuntimeRequestMessage(transportResourceId: string, request: PendingRuntimeRequestRecord): Promise<void>;
  recordRuntimeActivity(input: Omit<RuntimeActivityRecord, 'activityId'>): void;
}

export class RuntimeProjectionService {
  constructor(private readonly deps: RuntimeProjectionServiceDeps) {}

  async handleDomainEvent(event: RuntimeDomainEvent): Promise<void> {
    const ingestion = this.deps.ingestion.ingestDomainEvent(event);
    if (ingestion.domainEventInserted === false) {
      return;
    }
    if (ingestion.receipt) {
      let receiptPublished = false;
      try {
        this.deps.receiptBus.publish(ingestion.receipt);
        receiptPublished = true;
      } catch (error) {
        this.deps.projectionState.upsert({
          projector: 'runtime.receipts',
          lastEventId: event.eventId,
          lastAppliedAt: event.createdAt,
          failure: error instanceof Error ? error.message : String(error)
        });
        await this.sendProjectionFailureSafely('runtime.receipts.apply', error);
      }
      if (receiptPublished) {
        try {
          await this.deps.getPluginHost().onRuntimeReceipt(ingestion.receipt, (pluginId) =>
            this.deps.createPluginContext(`plugin:${pluginId}`)
          );
          this.deps.projectionState.upsert({
            projector: 'runtime.receipts',
            lastEventId: event.eventId,
            lastAppliedAt: event.createdAt,
            failure: null
          });
        } catch (error) {
          this.deps.projectionState.upsert({
            projector: 'runtime.receipts',
            lastEventId: event.eventId,
            lastAppliedAt: event.createdAt,
            failure: `receipt-hook failure: ${error instanceof Error ? error.message : String(error)}`
          });
          await this.sendProjectionFailureSafely('runtime.receipts.hooks', error);
        }
      }
    }
    if (event.type === 'request.opened' || event.type === 'request.resolved') {
      try {
        this.deps.projectionState.upsert({
          projector: 'runtime.requests',
          lastEventId: event.eventId,
          lastAppliedAt: event.createdAt,
          failure: null
        });
      } catch (error) {
        this.deps.projectionState.upsert({
          projector: 'runtime.requests',
          lastEventId: event.eventId,
          lastAppliedAt: event.createdAt,
          failure: error instanceof Error ? error.message : String(error)
        });
        await this.sendProjectionFailureSafely('runtime.requests', error);
      }
    }
    if (event.type === 'turn.interrupted' || event.type === 'turn.cancelled' || event.type === 'turn.failed') {
      for (const request of this.deps.pendingRequests.listOpen().filter((entry) => entry.threadId === event.threadId)) {
        this.deps.store.upsertPendingRequest({
          ...request,
          status: 'resolved',
          decision: 'cancel',
          resolvedAt: event.createdAt
        });
      }
    }
    await this.deps.queue(event.threadId, async () => {
      try {
        const decision = this.deps.orchestration.process(event);
        for (const activity of decision.activities) {
          await this.deps.getPluginHost().onRuntimeActivity(activity, (pluginId) =>
            this.deps.createPluginContext(`plugin:${pluginId}`)
          );
        }
        this.deps.projectionState.upsert({
          projector: 'runtime.activities',
          lastEventId: event.eventId,
          lastAppliedAt: event.createdAt,
          failure: null
        });
      } catch (error) {
        this.deps.projectionState.upsert({
          projector: 'runtime.activities',
          lastEventId: event.eventId,
          lastAppliedAt: event.createdAt,
          failure: error instanceof Error ? error.message : String(error)
        });
        await this.sendProjectionFailureSafely('runtime.activities', error);
      }
    });
    await this.deps.getPluginHost().onDomainEvent(event, (pluginId) => this.deps.createPluginContext(`plugin:${pluginId}`));
  }

  async recoverOpenRequests(): Promise<void> {
    for (const request of this.deps.snapshots.overview().openRequests) {
      const session = this.deps.snapshots.getSessionByTransportResourceId(request.transportResourceId)?.session;
      if (session?.lifecycleStatus === 'archived') {
        this.deps.store.upsertPendingRequest({
          ...request,
          status: 'resolved',
          decision: 'cancel',
          resolvedAt: this.deps.now()
        });
        continue;
      }
      await this.deps.postRuntimeRequestMessage(request.transportResourceId, {
        ...request,
        messageId: null
      });
    }
  }

  reconcileRecoveredState(): void {
    const reconciliationStartedAt = this.deps.now();
    try {
      const issues = this.deps.reconciler.reconcile(reconciliationStartedAt);
      for (const issue of issues) {
        if (issue.correction?.type === 'upsert_receipt') {
          this.deps.store.upsertRuntimeReceipt(issue.correction.receipt);
        }
        if (issue.correction?.type === 'resolve_request') {
          this.deps.store.upsertPendingRequest({
            ...issue.correction.request,
            status: 'resolved',
            decision: 'cancel',
            resolvedAt: issue.correction.nowIso
          });
        }
        if (issue.kind === 'missing-provider-binding') {
          const snapshot = this.deps.snapshots.getSessionByThreadId(issue.threadId);
          if (snapshot?.session) {
            this.deps.store.upsertSession({
              ...snapshot.session,
              providerStatus: 'error',
              lastError: issue.detail,
              updatedAt: this.deps.now()
            });
          }
        }
        this.deps.recordRuntimeActivity({
          threadId: issue.threadId,
          sessionId: issue.sessionId,
          transportResourceId: this.deps.snapshots.getSessionByThreadId(issue.threadId)?.session.transportResourceId ?? null,
          sourceEventId: randomUUID(),
          kind: `reconcile.${issue.kind}`,
          severity: issue.kind === 'missing-provider-binding' ? 'error' : 'warning',
          title: 'Runtime reconciliation',
          detail: issue.detail,
          createdAt: this.deps.now()
        });
      }
      this.deps.projectionState.upsert({
        projector: 'runtime.reconcile',
        lastEventId: null,
        lastAppliedAt: this.deps.now(),
        failure: null
      });
      this.deps.store.putMetadata(
        'runtime.reconcile.last_run',
        {
          at: this.deps.now(),
          issueCount: issues.length,
          issueKinds: issues.map((issue) => issue.kind)
        },
        this.deps.now()
      );
    } catch (error) {
      this.deps.projectionState.upsert({
        projector: 'runtime.reconcile',
        lastEventId: null,
        lastAppliedAt: this.deps.now(),
        failure: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async sendProjectionFailure(projector: string, error: unknown): Promise<void> {
    await this.deps.sendStatusUpdate({
      text: 'Projection failure detected.',
      blocks: [
        {
          kind: 'fields',
          title: 'Projection Failure',
          tone: 'danger',
          fields: [
            { label: 'Projector', value: projector, inline: true },
            {
              label: 'Detail',
              value: (error instanceof Error ? error.message : String(error)).slice(0, 1024)
            }
          ]
        }
      ]
    });
  }

  private async sendProjectionFailureSafely(projector: string, error: unknown): Promise<void> {
    try {
      await this.sendProjectionFailure(projector, error);
    } catch {
      // Avoid failing projection processing when status delivery is unavailable.
    }
  }
}
