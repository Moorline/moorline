import { randomUUID } from 'node:crypto';
import type { RuntimeDomainEvent } from './runtimeDomain.js';
import { RuntimeActivityStore, type RuntimeActivityRecord } from '../../system/projection/runtimeActivityStore.js';
import { PendingRequestProjectionStore } from '../../system/projection/pendingRequestProjectionStore.js';
import type { PendingRuntimeRequestRecord } from '../../../types/runtime.js';

interface OrchestrationDecision {
  activities: RuntimeActivityRecord[];
  requestOpened?: PendingRuntimeRequestRecord;
  requestResolved?: PendingRuntimeRequestRecord;
}

function makeActivity(input: {
  sourceEventId: string;
  threadId: string;
  sessionId: string | null;
  transportResourceId: string | null;
  kind: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail?: string | null;
  createdAt: string;
}): RuntimeActivityRecord {
  return {
    activityId: randomUUID(),
    threadId: input.threadId,
    sessionId: input.sessionId,
    transportResourceId: input.transportResourceId,
    sourceEventId: input.sourceEventId,
    kind: input.kind,
    severity: input.severity,
    title: input.title,
    detail: input.detail ?? null,
    createdAt: input.createdAt
  };
}

export class OrchestrationEngine {
  constructor(
    private readonly activities: RuntimeActivityStore,
    private readonly requests: PendingRequestProjectionStore
  ) {}

  process(event: RuntimeDomainEvent): OrchestrationDecision {
    const activities: RuntimeActivityRecord[] = [];

    switch (event.type) {
      case 'session.created':
      case 'session.resumed':
        activities.push(
          makeActivity({
            sourceEventId: event.eventId,
            threadId: event.threadId,
            sessionId: event.sessionId,
            transportResourceId: event.transportResourceId,
            kind: event.type,
            severity: 'info',
            title: event.type === 'session.created' ? 'Session created' : 'Session resumed',
            detail: `${event.payload.runtimeMode} @ ${event.payload.workspacePath}`,
            createdAt: event.createdAt
          })
        );
        break;
      case 'turn.started':
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted':
      case 'turn.cancelled':
      case 'turn.waiting_for_approval':
      case 'turn.waiting_for_input':
        activities.push(
          makeActivity({
            sourceEventId: event.eventId,
            threadId: event.threadId,
            sessionId: event.sessionId,
            transportResourceId: event.transportResourceId,
            kind: event.type,
            severity:
              event.type === 'turn.failed' || event.type === 'turn.interrupted' ? 'error' : event.type.includes('waiting') ? 'warning' : 'info',
            title: event.type.replace(/^turn\./, '').replace(/_/g, ' '),
            detail: event.payload.detail ?? null,
            createdAt: event.createdAt
          })
        );
        break;
      case 'request.opened':
        activities.push(
          makeActivity({
            sourceEventId: event.eventId,
            threadId: event.threadId,
            sessionId: event.sessionId,
            transportResourceId: event.transportResourceId,
            kind: event.type,
            severity: 'warning',
            title: `Request opened: ${event.payload.requestType}`,
            detail: event.payload.detail ?? null,
            createdAt: event.createdAt
          })
        );
        this.requests.upsert(event.payload);
        break;
      case 'item.observed':
        activities.push(
          makeActivity({
            sourceEventId: event.eventId,
            threadId: event.threadId,
            sessionId: event.sessionId,
            transportResourceId: event.transportResourceId,
            kind: `item.${event.payload.itemType}.${event.payload.stage}`,
            severity: event.payload.itemType === 'error' ? 'error' : event.payload.itemType === 'reasoning' ? 'warning' : 'info',
            title: `${event.payload.itemType.replace(/_/g, ' ')} ${event.payload.stage}`,
            detail: [event.payload.title, event.payload.detail, event.payload.status].filter(Boolean).join(' | ') || null,
            createdAt: event.createdAt
          })
        );
        break;
      case 'thread.token_usage.updated': {
        const ratio =
          typeof event.payload.totalTokens === 'number' &&
          typeof event.payload.modelContextWindow === 'number' &&
          event.payload.modelContextWindow > 0
            ? `${Math.round((event.payload.totalTokens / event.payload.modelContextWindow) * 100)}%`
            : null;
        activities.push(
          makeActivity({
            sourceEventId: event.eventId,
            threadId: event.threadId,
            sessionId: event.sessionId,
            transportResourceId: event.transportResourceId,
            kind: event.type,
            severity: 'info',
            title: 'Thread token usage updated',
            detail: [
              typeof event.payload.totalTokens === 'number' ? `total=${event.payload.totalTokens}` : null,
              typeof event.payload.lastTurnTokens === 'number' ? `last=${event.payload.lastTurnTokens}` : null,
              typeof event.payload.modelContextWindow === 'number' ? `window=${event.payload.modelContextWindow}` : null,
              ratio ? `usage=${ratio}` : null
            ]
              .filter(Boolean)
              .join(' | '),
            createdAt: event.createdAt
          })
        );
        break;
      }
      case 'thread.compacted':
        activities.push(
          makeActivity({
            sourceEventId: event.eventId,
            threadId: event.threadId,
            sessionId: event.sessionId,
            transportResourceId: event.transportResourceId,
            kind: event.type,
            severity: 'warning',
            title: 'Thread compacted',
            detail: event.payload.detail ?? null,
            createdAt: event.createdAt
          })
        );
        break;
      case 'request.resolved':
        activities.push(
          makeActivity({
            sourceEventId: event.eventId,
            threadId: event.threadId,
            sessionId: event.sessionId,
            transportResourceId: event.transportResourceId,
            kind: event.type,
            severity: 'info',
            title: `Request resolved: ${event.payload.requestType}`,
            detail: event.payload.decision ?? null,
            createdAt: event.createdAt
          })
        );
        this.requests.upsert(event.payload);
        break;
      case 'runtime.error':
      case 'provider.closed':
        activities.push(
          makeActivity({
            sourceEventId: event.eventId,
            threadId: event.threadId,
            sessionId: event.sessionId,
            transportResourceId: event.transportResourceId,
            kind: event.type,
            severity: 'error',
            title: event.type === 'runtime.error' ? 'Runtime error' : 'Provider closed',
            detail: event.payload.message ?? null,
            createdAt: event.createdAt
          })
        );
        break;
      case 'provider.metadata.updated':
        activities.push(
          makeActivity({
            sourceEventId: event.eventId,
            threadId: event.threadId,
            sessionId: event.sessionId,
            transportResourceId: event.transportResourceId,
            kind: event.type,
            severity: 'info',
            title: 'Provider metadata updated',
            detail: `${event.payload.accountLabel ?? 'unknown'} | ${(event.payload.availableModels ?? []).join(', ')}`,
            createdAt: event.createdAt
          })
        );
        break;
      case 'runtime.busy':
      case 'runtime.idle':
      case 'runtime.waiting':
        break;
    }

    for (const activity of activities) {
      this.activities.append(activity);
    }

    return {
      activities,
      ...(event.type === 'request.opened' ? { requestOpened: event.payload } : {}),
      ...(event.type === 'request.resolved' ? { requestResolved: event.payload } : {})
    };
  }
}
