import { randomUUID } from 'node:crypto';
import type { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type { RuntimeActivityRecord } from '../../system/projection/runtimeActivityStore.js';
import type { RuntimeSnapshotQuery } from '../../system/projection/runtimeSnapshotQuery.js';
import type { PendingRuntimeRequestRecord } from '../../../types/runtime.js';
import type { RuntimeProvider } from '../../../types/provider.js';
import type { SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import type { RuntimeActorIdentity, RuntimeMessagePayload } from '../../../types/transport.js';

function requestSummary(request: PendingRuntimeRequestRecord): string {
  switch (request.requestType) {
    case 'command_execution_approval':
    case 'exec_command_approval':
      return 'Command approval requested';
    case 'file_read_approval':
      return 'File read approval requested';
    case 'file_change_approval':
    case 'apply_patch_approval':
      return 'File change approval requested';
    case 'tool_user_input':
      return 'User input requested';
    default:
      return 'Runtime request opened';
  }
}

function formatPendingRequestQuestions(questionsJson: string): { value: string; malformed: boolean } {
  try {
    const parsed = JSON.parse(questionsJson) as Array<{ header?: unknown; question?: unknown }>;
    if (!Array.isArray(parsed)) {
      throw new Error('questionsJson was not an array');
    }
    const rendered = parsed
      .map((question) => {
        const header = typeof question.header === 'string' && question.header.trim() ? question.header.trim() : 'Question';
        const prompt = typeof question.question === 'string' && question.question.trim() ? question.question.trim() : '(missing prompt)';
        return `${header}: ${prompt}`;
      })
      .join('\n')
      .slice(0, 1024);
    return {
      value: rendered || 'Question payload was empty. Use the management action to answer manually.',
      malformed: false
    };
  } catch {
    return {
      value: 'Question payload is malformed. Use the management action to answer this request manually.',
      malformed: true
    };
  }
}

interface RuntimePendingRequestServiceDeps {
  store: SqliteSessionStore;
  snapshots: RuntimeSnapshotQuery;
  providerService: RuntimeProvider;
  providerId: string;
  isAdminActor(input: RuntimeActorIdentity): boolean;
  now(): string;
  postTransportMessage(actor: string, transportResourceId: string, payload: RuntimeMessagePayload): Promise<{ id: string }>;
  runGuardedAction<T>(input: {
    action: Parameters<RuntimeActionGuard['run']>[0]['action'];
    actor: string;
    target?: string;
    payload?: unknown;
    threadId?: string;
    title: string;
    execute: () => Promise<T>;
  }): Promise<T>;
  recordRuntimeActivity(input: Omit<RuntimeActivityRecord, 'activityId'>): void;
}

type PendingRequestActionErrorCode =
  | 'REQUEST_NOT_OPEN'
  | 'REQUEST_FORBIDDEN'
  | 'REQUEST_TYPE_MISMATCH';

export class PendingRequestActionError extends Error {
  constructor(
    readonly code: PendingRequestActionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PendingRequestActionError';
  }
}

export class RuntimePendingRequestService {
  constructor(private readonly deps: RuntimePendingRequestServiceDeps) {}

  private providerPolicyTarget(threadId: string, suffix: string): string {
    return `provider:${this.deps.providerId}:${threadId}:${suffix}`;
  }

  async postRuntimeRequestMessage(transportResourceId: string, request: PendingRuntimeRequestRecord): Promise<void> {
    const openRequests = this.deps.snapshots.listOpenRequestsByTransportResource(transportResourceId);
    const parsedQuestions = request.questionsJson ? formatPendingRequestQuestions(request.questionsJson) : null;
    if (parsedQuestions?.malformed) {
      this.deps.recordRuntimeActivity({
        threadId: request.threadId,
        sessionId: this.deps.snapshots.getSessionByThreadId(request.threadId)?.session.sessionId ?? null,
        transportResourceId,
        sourceEventId: randomUUID(),
        kind: 'pending_request.payload.invalid',
        severity: 'warning',
        title: 'Pending request payload is malformed',
        detail: `Unable to parse questionsJson for ${request.requestId}.`,
        createdAt: this.deps.now()
      });
    }
    const payload: RuntimeMessagePayload = {
      blocks: [
        {
          kind: 'fields',
          title: requestSummary(request),
          tone: request.requestType === 'tool_user_input' ? 'warning' : 'info',
          fields: [
            { label: 'Request ID', value: request.requestId },
            { label: 'Type', value: request.requestType, inline: true },
            { label: 'Status', value: request.status, inline: true },
            { label: 'Open Requests', value: String(Math.max(openRequests.length, 1)), inline: true },
            ...(request.requesterUserId ? [{ label: 'Requester', value: request.requesterUserId, inline: true }] : []),
            ...(request.detail ? [{ label: 'Detail', value: request.detail.slice(0, 1024) }] : []),
            ...(parsedQuestions
              ? [{
                  label: 'Questions',
                  value: parsedQuestions.value
                }]
              : [])
          ],
          metadata: {
            createdAt: request.createdAt
          }
        }
      ],
      text:
        request.requestType === 'tool_user_input'
          ? `User input is needed for request ${request.requestId}. Resolve it through a management action.`
          : request.requesterUserId
            ? 'Only the original requester can resolve this request.'
            : 'Only a Moorline operator can resolve this request.',
      ...(request.requestType !== 'tool_user_input'
        ? {
            actions: [
              {
                actionId: 'runtime.pending_request.respond',
                label: 'Accept',
                style: 'success',
                input: { requestId: request.requestId, decision: 'accept' }
              },
              {
                actionId: 'runtime.pending_request.respond',
                label: 'Decline',
                style: 'danger',
                input: { requestId: request.requestId, decision: 'decline' }
              },
              {
                actionId: 'runtime.pending_request.respond',
                label: 'Cancel',
                style: 'secondary',
                input: { requestId: request.requestId, decision: 'cancel' }
              }
            ]
          }
        : {})
    };
    const receipt = await this.deps.postTransportMessage('runtime:status', transportResourceId, payload);
    this.deps.store.upsertPendingRequest({
      ...request,
      messageId: receipt.id
    });
    this.deps.recordRuntimeActivity({
      threadId: request.threadId,
      sessionId: this.deps.snapshots.getSessionByThreadId(request.threadId)?.session.sessionId ?? null,
      transportResourceId,
      sourceEventId: request.requestId,
      kind: 'pending_request.opened',
      severity: 'warning',
      title: requestSummary(request),
      detail: request.detail,
      createdAt: this.deps.now()
    });
  }

  async respondToProviderRequest(
    actor: string,
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
    title: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.deps.runGuardedAction({
        action: 'net.connect',
        actor,
        target: this.providerPolicyTarget(threadId, `request:${requestId}`),
        payload: { decision, ...payload },
        threadId,
        title,
        execute: async () => this.deps.providerService.respondToRequest(threadId, requestId, decision)
      });
      const pending = this.deps.store.getPendingRequest(requestId);
      this.deps.recordRuntimeActivity({
        threadId,
        sessionId: this.deps.snapshots.getSessionByThreadId(threadId)?.session.sessionId ?? null,
        transportResourceId: pending?.transportResourceId ?? null,
        sourceEventId: requestId,
        kind: decision === 'cancel' ? 'pending_request.cancelled' : 'pending_request.resolved',
        severity: 'info',
        title: `Pending request ${decision}`,
        detail: null,
        createdAt: this.deps.now()
      });
    } catch (error) {
      if (this.isUnknownPendingRequestError(error)) {
        this.resolveRequestAsOrphaned(requestId, threadId, `Provider no longer knows request ${requestId}.`);
        return;
      }
      throw error;
    }
  }

  async respondToProviderUserInput(
    actor: string,
    threadId: string,
    requestId: string,
    answers: Record<string, string | string[]>
  ): Promise<void> {
    try {
      await this.deps.runGuardedAction({
        action: 'net.connect',
        actor,
        target: this.providerPolicyTarget(threadId, `request:${requestId}`),
        payload: { answers },
        threadId,
        title: 'Provider user input blocked',
        execute: async () => this.deps.providerService.respondToUserInput(threadId, requestId, answers)
      });
    } catch (error) {
      if (this.isUnknownPendingRequestError(error)) {
        this.resolveRequestAsOrphaned(requestId, threadId, `Provider no longer knows user-input request ${requestId}.`);
        return;
      }
      throw error;
    }
  }

  async cancelProviderUserInput(actor: string, threadId: string, requestId: string): Promise<void> {
    try {
      await this.deps.runGuardedAction({
        action: 'net.connect',
        actor,
        target: this.providerPolicyTarget(threadId, 'interrupt'),
        threadId,
        title: 'Provider request cancel blocked',
        execute: async () => this.deps.providerService.interruptTurn(threadId)
      });
      const pending = this.deps.store.getPendingRequest(requestId);
      if (pending) {
        this.deps.store.upsertPendingRequest({
          ...pending,
          status: 'resolved',
          decision: 'cancel',
          resolvedAt: this.deps.now()
        });
      }
      this.deps.recordRuntimeActivity({
        threadId,
        sessionId: this.deps.snapshots.getSessionByThreadId(threadId)?.session.sessionId ?? null,
        transportResourceId: pending?.transportResourceId ?? null,
        sourceEventId: requestId,
        kind: 'pending_request.cancelled',
        severity: 'info',
        title: 'Pending request cancelled',
        detail: null,
        createdAt: this.deps.now()
      });
    } catch (error) {
      if (this.isUnknownPendingRequestError(error)) {
        this.resolveRequestAsOrphaned(requestId, threadId, `Provider no longer has active turn for ${requestId}.`);
        return;
      }
      throw error;
    }
  }

  async resolvePendingRequest(input: {
    actorId: string;
    requestId: string;
    decision: 'accept' | 'decline' | 'cancel';
    deniedTitle: string;
    metadata?: Record<string, unknown>;
    requestActor?: RuntimeActorIdentity;
  }): Promise<PendingRuntimeRequestRecord> {
    const request = await this.requireAuthorizedOpenRequest({
      requestId: input.requestId,
      actorId: input.actorId,
      requestActor: input.requestActor
    });
    if (request.requestType === 'tool_user_input') {
      if (input.decision !== 'cancel') {
        throw new PendingRequestActionError(
          'REQUEST_TYPE_MISMATCH',
          `Request ${request.requestId} is tool_user_input. Use request answer or cancel.`
        );
      }
      await this.cancelProviderUserInput(input.actorId, request.threadId, request.requestId);
      return request;
    }
    await this.respondToProviderRequest(
      input.actorId,
      request.threadId,
      request.requestId,
      input.decision,
      input.deniedTitle,
      input.metadata
    );
    return request;
  }

  async answerPendingRequest(input: {
    actorId: string;
    requestId: string;
    answers: Record<string, string | string[]>;
    requestActor?: RuntimeActorIdentity;
  }): Promise<PendingRuntimeRequestRecord> {
    const request = await this.requireAuthorizedOpenRequest({
      requestId: input.requestId,
      actorId: input.actorId,
      requestActor: input.requestActor
    });
    if (request.requestType !== 'tool_user_input') {
      throw new PendingRequestActionError(
        'REQUEST_TYPE_MISMATCH',
        `Request ${request.requestId} is approval-driven. Use request resolve actions instead.`
      );
    }
    await this.respondToProviderUserInput(
      input.actorId,
      request.threadId,
      request.requestId,
      input.answers
    );
    return request;
  }

  getAuthorizedOpenRequest(input: {
    requestId: string;
    actorId: string;
    requestActor?: RuntimeActorIdentity;
  }): Promise<PendingRuntimeRequestRecord> {
    return this.requireAuthorizedOpenRequest(input);
  }

  private isUnknownPendingRequestError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes('unknown pending approval request') || message.includes('unknown pending user input request');
  }

  private resolveRequestAsOrphaned(requestId: string, threadId: string, detail: string): void {
    const pending = this.deps.store.getPendingRequest(requestId);
    if (pending) {
      this.deps.store.upsertPendingRequest({
        ...pending,
        status: 'resolved',
        decision: 'cancel',
        resolvedAt: this.deps.now()
      });
    }
    const snapshot = this.deps.snapshots.getSessionByThreadId(threadId);
    this.deps.recordRuntimeActivity({
      threadId,
      sessionId: snapshot?.session.sessionId ?? null,
      transportResourceId: snapshot?.session.transportResourceId ?? null,
      sourceEventId: randomUUID(),
      kind: 'request.orphaned',
      severity: 'warning',
      title: 'Provider request expired',
      detail,
      createdAt: this.deps.now()
    });
  }

  private async requireAuthorizedOpenRequest(input: {
    requestId: string;
    actorId: string;
    requestActor?: RuntimeActorIdentity;
  }): Promise<PendingRuntimeRequestRecord> {
    const request = this.deps.snapshots.getOpenRequestById(input.requestId);
    if (!request) {
      throw new PendingRequestActionError('REQUEST_NOT_OPEN', 'This request is no longer open.');
    }
    const actor = this.normalizeRequestActor(input.actorId, input.requestActor);
    const isOperator = await this.isOperatorActor(actor);
    if (request.requesterUserId) {
      if (request.requesterUserId !== actor.actorId && !isOperator) {
        throw new PendingRequestActionError(
          'REQUEST_FORBIDDEN',
          'Only the original requester can resolve this request.'
        );
      }
      return request;
    }
    if (!isOperator) {
      throw new PendingRequestActionError(
        'REQUEST_FORBIDDEN',
        'Only a Moorline operator can resolve this request.'
      );
    }
    return request;
  }

  private normalizeRequestActor(actorId: string, actor?: RuntimeActorIdentity): RuntimeActorIdentity {
    if (!actor) {
      return {
        actorId,
        accessGroupIds: [],
        isSurfaceAdmin: false
      };
    }
    return {
      ...actor,
      actorId: actor.actorId
    };
  }

  private async isOperatorActor(actor: RuntimeActorIdentity): Promise<boolean> {
    if (this.deps.isAdminActor(actor)) {
      return true;
    }
    if (this.isTrustedRuntimeActor(actor.actorId)) {
      return true;
    }
    if (!actor.actorId.startsWith('plugin:')) {
      return false;
    }
    return await this.canResolveOperatorRequest(actor.actorId);
  }

  private isTrustedRuntimeActor(actorId: string): boolean {
    return (
      actorId.startsWith('runtime:') ||
      actorId.startsWith('cli:') ||
      actorId === 'app:control-api'
    );
  }

  private async canResolveOperatorRequest(actorId: string): Promise<boolean> {
    try {
      return await this.deps.runGuardedAction({
        action: 'runtime.control',
        actor: actorId,
        target: 'pending-request:operator',
        title: 'Pending request operator resolution blocked',
        execute: async () => true
      });
    } catch {
      return false;
    }
  }
}
