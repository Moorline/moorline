import type { RuntimeDomainEvent, RuntimeReceiptRecord } from './runtimeDomain.js';
import type { PendingRuntimeRequestRecord, ProviderRuntimeEvent } from '../../../types/runtime.js';
import type { RuntimeSessionRow, SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';

interface IngestionSideEffects {
  domainEventInserted: boolean;
  requestOpened?: PendingRuntimeRequestRecord;
  requestResolved?: PendingRuntimeRequestRecord;
  receipt?: RuntimeReceiptRecord;
  updatedSession?: RuntimeSessionRow | null;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class RuntimeIngestion {
  constructor(private readonly store: SqliteSessionStore) {}

  ingestProviderEvent(event: ProviderRuntimeEvent): RuntimeSessionRow | null {
    const session = this.store.getSessionByThreadId(event.threadId);
    if (!session) {
      return null;
    }

    const terminalTurnEvent = event.type === 'turn.completed' || event.type === 'turn.aborted';
    const updated: RuntimeSessionRow = {
      ...session,
      providerStatus:
        event.type === 'session.state.changed'
          ? event.payload.state
          : event.type === 'turn.started'
            ? 'running'
            : event.type === 'turn.completed'
              ? event.payload.state === 'failed'
                ? 'error'
                : 'ready'
              : event.type === 'turn.aborted'
                ? 'error'
              : session.providerStatus,
      providerThreadId: event.type === 'thread.started' ? event.payload.providerThreadId : session.providerThreadId,
      resumeThreadId: event.type === 'thread.started' ? event.payload.providerThreadId : session.resumeThreadId,
      activeTurnId:
        event.type === 'turn.started' ? event.turnId ?? session.activeTurnId : terminalTurnEvent ? null : session.activeTurnId,
      updatedAt: event.createdAt,
      lastError:
        event.type === 'runtime.error'
          ? event.payload.message
          : event.type === 'turn.aborted'
            ? event.payload.reason
          : event.type === 'turn.completed' && event.payload.errorMessage
            ? event.payload.errorMessage
            : event.type === 'turn.completed' && event.payload.state !== 'failed'
              ? null
              : event.type === 'session.state.changed' && (event.payload.state === 'ready' || event.payload.state === 'running')
                ? null
                : session.lastError
    };
    this.store.upsertSession(updated);

    const existingBinding = this.store.getProviderBinding(updated.threadId);
    const model =
      event.type === 'turn.started'
        ? event.payload.model ?? existingBinding?.model ?? null
        : existingBinding?.model ?? null;
    const runtimePayload = {
      ...parseJsonRecord(existingBinding?.runtimePayloadJson ?? null),
      cwd: updated.workspacePath,
      model,
      resumeThreadId: updated.resumeThreadId,
      ...(event.type === 'thread.token-usage.updated'
        ? {
            tokenUsage: {
              totalTokens: event.payload.totalTokens,
              lastTurnTokens: event.payload.lastTurnTokens,
              modelContextWindow: event.payload.modelContextWindow
            }
          }
        : {})
    };

    this.store.upsertProviderBinding({
      threadId: updated.threadId,
      provider: updated.provider,
      runtimeMode: updated.runtimeMode,
      cwd: updated.workspacePath,
      providerThreadId: updated.providerThreadId,
      status: updated.providerStatus,
      model,
      accountLabel: existingBinding?.accountLabel ?? null,
      availableModelsJson: existingBinding?.availableModelsJson ?? null,
      updatedAt: updated.updatedAt,
      lastError: updated.lastError,
      runtimePayloadJson: JSON.stringify(runtimePayload),
      capabilityMetadataJson: existingBinding?.capabilityMetadataJson ?? null
    });
    return updated;
  }

  ingestDomainEvent(event: RuntimeDomainEvent): IngestionSideEffects {
    const persistence = this.store.appendDomainEvent(event);
    if (!persistence.inserted) {
      return {
        domainEventInserted: false
      };
    }
    const receipt = this.store.getRuntimeReceipt(event.threadId) ?? {
      threadId: event.threadId,
      sessionId: event.sessionId,
      transportResourceId: event.transportResourceId,
      activeTurnId: null,
      state: 'idle' as const,
      waitReason: null,
      pendingRequestId: null,
      lastAssistantText: null,
      updatedAt: event.createdAt
    };

    let nextReceipt = receipt;
    switch (event.type) {
      case 'turn.started':
        nextReceipt = {
          ...receipt,
          activeTurnId: event.payload.turnId ?? null,
          state: 'running',
          waitReason: null,
          pendingRequestId: null,
          updatedAt: event.createdAt
        };
        break;
      case 'turn.waiting_for_approval':
        nextReceipt = {
          ...receipt,
          activeTurnId: event.payload.turnId ?? receipt.activeTurnId,
          state: 'waiting_for_approval',
          waitReason: 'approval',
          pendingRequestId: event.payload.requestId ?? null,
          updatedAt: event.createdAt
        };
        break;
      case 'turn.waiting_for_input':
        nextReceipt = {
          ...receipt,
          activeTurnId: event.payload.turnId ?? receipt.activeTurnId,
          state: 'waiting_for_input',
          waitReason: 'user_input',
          pendingRequestId: event.payload.requestId ?? null,
          updatedAt: event.createdAt
        };
        break;
      case 'turn.completed':
        nextReceipt = {
          ...receipt,
          state: 'completed',
          waitReason: null,
          pendingRequestId: null,
          activeTurnId: null,
          updatedAt: event.createdAt
        };
        break;
      case 'turn.failed':
        nextReceipt = {
          ...receipt,
          state: 'failed',
          waitReason: null,
          pendingRequestId: null,
          activeTurnId: null,
          updatedAt: event.createdAt
        };
        break;
      case 'turn.interrupted':
        nextReceipt = {
          ...receipt,
          state: 'interrupted',
          waitReason: null,
          pendingRequestId: null,
          activeTurnId: null,
          updatedAt: event.createdAt
        };
        break;
      case 'turn.cancelled':
        nextReceipt = {
          ...receipt,
          state: 'cancelled',
          waitReason: null,
          pendingRequestId: null,
          activeTurnId: null,
          updatedAt: event.createdAt
        };
        break;
      case 'runtime.idle':
        nextReceipt = {
          ...receipt,
          state: 'idle',
          waitReason: null,
          pendingRequestId: null,
          activeTurnId: null,
          updatedAt: event.createdAt
        };
        break;
      case 'runtime.busy':
        {
          const nextState = event.payload.state ?? 'running';
          const waitingReason =
            nextState === 'waiting_for_approval'
              ? 'approval'
              : nextState === 'waiting_for_input'
                ? 'user_input'
                : null;
          const terminal = nextState === 'completed' || nextState === 'failed' || nextState === 'interrupted' || nextState === 'cancelled' || nextState === 'idle';
          nextReceipt = {
            ...receipt,
            state: nextState,
            waitReason: waitingReason,
            pendingRequestId: waitingReason ? receipt.pendingRequestId : null,
            activeTurnId: terminal ? null : receipt.activeTurnId,
            updatedAt: event.createdAt
          };
        }
        break;
      case 'runtime.waiting':
        nextReceipt = {
          ...receipt,
          state: event.payload.state ?? receipt.state,
          waitReason:
            event.payload.state === 'waiting_for_approval'
              ? 'approval'
              : event.payload.state === 'waiting_for_input'
                ? 'user_input'
                : null,
          updatedAt: event.createdAt
        };
        break;
      case 'runtime.error':
        nextReceipt = {
          ...receipt,
          state: 'failed',
          waitReason: null,
          pendingRequestId: null,
          activeTurnId: null,
          updatedAt: event.createdAt
        };
        break;
      case 'provider.closed':
        if (receipt.activeTurnId || receipt.state === 'running' || receipt.state === 'waiting_for_approval' || receipt.state === 'waiting_for_input') {
          nextReceipt = {
            ...receipt,
            state: 'interrupted',
            waitReason: null,
            pendingRequestId: null,
            activeTurnId: null,
            updatedAt: event.createdAt
          };
        }
        break;
      default:
        break;
    }

    this.store.upsertRuntimeReceipt(nextReceipt);
    return {
      domainEventInserted: true,
      receipt: nextReceipt
    };
  }
}
