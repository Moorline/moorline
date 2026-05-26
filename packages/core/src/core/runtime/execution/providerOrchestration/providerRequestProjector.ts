import type { PendingRuntimeRequestRecord, ProviderRuntimeEvent } from '../../../../types/runtime.js';
import { ProviderRequestAttributionService } from '../providerCoordination/providerRequestAttributionService.js';
import type { PendingRequestPort, ProviderRequestMessagePort } from './ports.js';

export interface ProviderRequestProjectorDeps extends ProviderRequestMessagePort {
  pending: PendingRequestPort;
  attribution: ProviderRequestAttributionService;
}

export class ProviderRequestProjector {
  constructor(private readonly deps: ProviderRequestProjectorDeps) {}

  async project(event: ProviderRuntimeEvent, input: {
    spaceId: string | null;
    waiterAuthorId: string | null;
  }): Promise<PendingRuntimeRequestRecord | null> {
    if (event.type === 'request.opened' && input.spaceId) {
      const requestId = event.requestId ?? event.eventId;
      const existing = this.deps.pending.getPendingRequest(requestId);
      if (existing && existing.status !== 'open') {
        return null;
      }
      if (existing?.messageId) {
        return existing;
      }
      const request = {
        requestId,
        threadId: event.threadId,
        turnId: event.turnId ?? null,
        spaceId: input.spaceId,
        requesterUserId:
          input.waiterAuthorId ?? this.deps.attribution.getThreadRequester(event.threadId) ?? null,
        messageId: null,
        requestType: event.payload.requestType,
        status: 'open',
        detail: event.payload.detail ?? null,
        questionsJson: null,
        decision: null,
        createdAt: event.createdAt,
        resolvedAt: null
      } satisfies PendingRuntimeRequestRecord;
      this.deps.pending.upsertPendingRequest(request);
      await this.deps.postRuntimeRequestMessage(input.spaceId, request);
      return request;
    }

    if (event.type === 'user-input.requested' && input.spaceId) {
      const requestId = event.requestId ?? event.eventId;
      const existing = this.deps.pending.getPendingRequest(requestId);
      if (existing && existing.status !== 'open') {
        return null;
      }
      if (existing?.messageId) {
        return existing;
      }
      const request = {
        requestId,
        threadId: event.threadId,
        turnId: event.turnId ?? null,
        spaceId: input.spaceId,
        requesterUserId:
          input.waiterAuthorId ?? this.deps.attribution.getThreadRequester(event.threadId) ?? null,
        messageId: null,
        requestType: 'tool_user_input',
        status: 'open',
        detail: null,
        questionsJson: JSON.stringify(event.payload.questions),
        decision: null,
        createdAt: event.createdAt,
        resolvedAt: null
      } satisfies PendingRuntimeRequestRecord;
      this.deps.pending.upsertPendingRequest(request);
      await this.deps.postRuntimeRequestMessage(input.spaceId, request);
      return request;
    }

    if (event.type === 'request.resolved' && event.requestId) {
      const pending = this.deps.pending.getPendingRequest(event.requestId);
      if (!pending) {
        return null;
      }
      const resolved = {
        ...pending,
        status: 'resolved' as const,
        decision: event.payload.decision ?? null,
        resolvedAt: event.createdAt
      };
      this.deps.pending.upsertPendingRequest(resolved);
      return resolved;
    }

    if (event.type === 'user-input.resolved' && event.requestId) {
      const pending = this.deps.pending.getPendingRequest(event.requestId);
      if (!pending) {
        return null;
      }
      const resolved = {
        ...pending,
        status: 'resolved' as const,
        resolvedAt: event.createdAt
      };
      this.deps.pending.upsertPendingRequest(resolved);
      return resolved;
    }

    return null;
  }
}
