import type {
  CanonicalItemType,
  CanonicalRequestType,
  PendingRuntimeRequestRecord,
  ProviderRuntimeEvent,
  ProviderSessionRecord,
  RuntimeModeName
} from '../../../types/runtime.js';

export type RuntimeReceiptState =
  | 'idle'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_input'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export type RuntimeWaitReason = 'approval' | 'user_input' | null;

export interface RuntimeReceiptRecord {
  threadId: string;
  sessionId: string | null;
  spaceId: string | null;
  activeTurnId: string | null;
  state: RuntimeReceiptState;
  waitReason: RuntimeWaitReason;
  pendingRequestId: string | null;
  lastAssistantText: string | null;
  updatedAt: string;
}

export interface ProviderBindingRecord {
  threadId: string;
  provider: ProviderSessionRecord['providerPackageId'];
  runtimeMode: RuntimeModeName;
  cwd: string;
  providerThreadId: string | null;
  status: ProviderSessionRecord['status'];
  model: string | null;
  accountLabel: string | null;
  availableModelsJson: string | null;
  updatedAt: string;
  lastError: string | null;
  runtimePayloadJson: string | null;
  capabilityMetadataJson: string | null;
}

interface RuntimeDomainEventBase {
  eventId: string;
  threadId: string;
  spaceId: string | null;
  sessionId: string | null;
  sourceProviderEventId?: string | null;
  createdAt: string;
}

export type RuntimeDomainEvent = RuntimeDomainEventBase &
  (
    | {
      type: 'session.created' | 'session.resumed';
      payload: {
        runtimeMode: RuntimeModeName;
        workspacePath: string;
      };
    }
  | {
      eventId: string;
      threadId: string;
      spaceId: string | null;
      sessionId: string | null;
      createdAt: string;
      type:
        | 'turn.started'
        | 'turn.completed'
        | 'turn.failed'
        | 'turn.interrupted'
        | 'turn.cancelled'
        | 'turn.waiting_for_approval'
        | 'turn.waiting_for_input';
      payload: {
        turnId: string | null;
        requestId?: string;
        requestType?: CanonicalRequestType;
        detail?: string | null;
      };
    }
  | {
      eventId: string;
      threadId: string;
      spaceId: string | null;
      sessionId: string | null;
      createdAt: string;
      type: 'request.opened' | 'request.resolved';
      payload: PendingRuntimeRequestRecord;
    }
  | {
      eventId: string;
      threadId: string;
      spaceId: string | null;
      sessionId: string | null;
      createdAt: string;
      type: 'item.observed';
      payload: {
        turnId: string | null;
        itemId: string | null;
        itemType: CanonicalItemType;
        stage: 'started' | 'completed';
        title?: string;
        detail?: string | null;
        status?: string;
      };
    }
  | {
      eventId: string;
      threadId: string;
      spaceId: string | null;
      sessionId: string | null;
      createdAt: string;
      type: 'thread.token_usage.updated' | 'thread.compacted';
      payload: {
        totalTokens?: number;
        lastTurnTokens?: number | null;
        modelContextWindow?: number | null;
        detail?: string | null;
      };
    }
  | {
      eventId: string;
      threadId: string;
      spaceId: string | null;
      sessionId: string | null;
      createdAt: string;
      type:
        | 'runtime.idle'
        | 'runtime.busy'
        | 'runtime.waiting'
        | 'runtime.error'
        | 'provider.closed'
        | 'provider.metadata.updated';
      payload: {
        message?: string;
        state?: RuntimeReceiptState;
        accountLabel?: string | null;
        availableModels?: string[];
      };
    }
  );

function buildDomainEventId(sourceEventId: string, ordinal: number, type: RuntimeDomainEvent['type']): string {
  return `${sourceEventId}:domain:${ordinal}:${type}`;
}

function withProviderEventIdentity(sourceEventId: string, events: RuntimeDomainEvent[]): RuntimeDomainEvent[] {
  return events.map((event, index) => ({
    ...event,
    eventId: buildDomainEventId(sourceEventId, index + 1, event.type),
    sourceProviderEventId: sourceEventId
  }));
}

export function domainEventsFromProviderEvent(input: {
  event: ProviderRuntimeEvent;
  sessionId: string | null;
  spaceId: string | null;
  runtimeMode: RuntimeModeName | null;
  workspacePath: string | null;
  request: PendingRuntimeRequestRecord | null;
}): RuntimeDomainEvent[] {
  const { event, sessionId, spaceId, runtimeMode, workspacePath, request } = input;
  const base = {
    eventId: event.eventId,
    threadId: event.threadId,
    spaceId,
    sessionId,
    createdAt: event.createdAt
  };

  const domainEvents: RuntimeDomainEvent[] = (() => {
  switch (event.type) {
    case 'thread.started':
      if (!runtimeMode || !workspacePath) {
        return [];
      }
      return [
        {
          ...base,
          type: 'session.resumed',
          payload: {
            runtimeMode,
            workspacePath
          }
        }
      ];
    case 'turn.started':
      return [
        {
          ...base,
          type: 'turn.started',
          payload: {
            turnId: event.turnId ?? null
          }
        },
        {
          ...base,
          type: 'runtime.busy',
          payload: {
            state: 'running'
          }
        }
      ];
    case 'request.opened':
      if (!request) {
        return [];
      }
      return [
        {
          ...base,
          type: 'request.opened',
          payload: request
        },
        {
          ...base,
          type: request.requestType === 'tool_user_input' ? 'turn.waiting_for_input' : 'turn.waiting_for_approval',
          payload: {
            turnId: request.turnId,
            requestId: request.requestId,
            requestType: request.requestType,
            detail: request.detail
          }
        },
        {
          ...base,
          type: 'runtime.waiting',
          payload: {
            state: request.requestType === 'tool_user_input' ? 'waiting_for_input' : 'waiting_for_approval'
          }
        }
      ];
    case 'user-input.requested':
      if (!request) {
        return [];
      }
      return [
        {
          ...base,
          type: 'request.opened',
          payload: request
        },
        {
          ...base,
          type: 'turn.waiting_for_input',
          payload: {
            turnId: request.turnId,
            requestId: request.requestId,
            requestType: request.requestType
          }
        },
        {
          ...base,
          type: 'runtime.waiting',
          payload: {
            state: 'waiting_for_input'
          }
        }
      ];
    case 'request.resolved':
    case 'user-input.resolved':
      if (!request) {
        return [];
      }
      return [
        {
          ...base,
          type: 'request.resolved',
          payload: request
        },
        {
          ...base,
          type: 'runtime.busy',
          payload: {
            state: 'running'
          }
        }
      ];
    case 'item.started':
    case 'item.completed':
      return [
        {
          ...base,
          type: 'item.observed',
          payload: {
            turnId: event.turnId ?? null,
            itemId: event.itemId ?? null,
            itemType: event.payload.itemType,
            stage: event.type === 'item.started' ? 'started' : 'completed',
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {})
          }
        }
      ];
    case 'thread.token-usage.updated':
      return [
        {
          ...base,
          type: 'thread.token_usage.updated',
          payload: {
            totalTokens: event.payload.totalTokens,
            lastTurnTokens: event.payload.lastTurnTokens,
            modelContextWindow: event.payload.modelContextWindow
          }
        }
      ];
    case 'turn.completed': {
      const type =
        event.payload.state === 'failed'
          ? 'turn.failed'
          : event.payload.state === 'interrupted'
            ? 'turn.interrupted'
            : event.payload.state === 'cancelled'
              ? 'turn.cancelled'
              : 'turn.completed';
      return [
        {
          ...base,
          type,
          payload: {
            turnId: event.turnId ?? null,
            detail: event.payload.errorMessage ?? event.payload.stopReason ?? null
          }
        },
        {
          ...base,
          type: event.payload.state === 'failed' ? 'runtime.error' : 'runtime.idle',
          payload: {
            ...(event.payload.state === 'failed' ? { message: event.payload.errorMessage ?? 'Turn failed' } : {}),
            state:
              event.payload.state === 'failed'
                ? 'failed'
                : event.payload.state === 'interrupted'
                  ? 'interrupted'
                  : event.payload.state === 'cancelled'
                    ? 'cancelled'
                    : 'completed'
          }
        }
      ];
    }
    case 'turn.aborted':
      return [
        {
          ...base,
          type: 'turn.interrupted',
          payload: {
            turnId: event.turnId ?? null,
            detail: event.payload.reason
          }
        },
        {
          ...base,
          type: 'runtime.error',
          payload: {
            message: event.payload.reason,
            state: 'interrupted'
          }
        }
      ];
    case 'runtime.error':
      return [
        {
          ...base,
          type: 'runtime.error',
          payload: {
            message: event.payload.message,
            state: 'failed'
          }
        }
      ];
    case 'thread.state.changed':
      if (event.payload.state === 'compacted') {
        return [
          {
            ...base,
            type: 'thread.compacted',
            payload: {
              detail: 'Provider thread compacted'
            }
          }
        ];
      }
      return [];
    case 'session.state.changed':
      if (event.payload.state === 'closed' || event.payload.state === 'error') {
        return [
          {
            ...base,
            type: 'provider.closed',
            payload: {
              message: event.payload.reason ?? event.payload.state
            }
          }
        ];
      }
      return [];
    case 'provider.metadata.updated':
      return [
        {
          ...base,
          type: 'provider.metadata.updated',
          payload: {
            accountLabel: event.payload.accountLabel ?? null,
            availableModels: event.payload.availableModels ?? []
          }
        }
      ];
    default:
      return [];
  }
  })();
  return withProviderEventIdentity(event.eventId, domainEvents);
}
