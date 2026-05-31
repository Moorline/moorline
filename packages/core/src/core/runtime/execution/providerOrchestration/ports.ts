import type { RuntimeProvider } from '../../../../types/provider.js';
import type { PendingRuntimeRequestRecord } from '../../../../types/runtime.js';
import type { RuntimeActivityRecord } from '../../../system/projection/runtimeActivityStore.js';
import type { RuntimeSnapshotQuery } from '../../../system/projection/runtimeSnapshotQuery.js';
import type { RuntimeDomainEvent } from '../runtimeDomain.js';

export interface ProviderAuditPort {
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
  recordRuntimeActivity(input: Omit<RuntimeActivityRecord, 'activityId'>): void;
}

export interface ProviderGuardPort {
  runGuardedProviderAction<T>(input: {
    action: 'net.connect';
    actor: string;
    target: string;
    payload?: Record<string, unknown>;
    threadId?: string;
    title: string;
    execute: () => Promise<T>;
  }): Promise<T>;
}

export interface ProviderTypingPort {
  startTypingLoop(actor: string, spaceId: string): () => void;
}

export interface PendingRequestPort {
  upsertPendingRequest(request: PendingRuntimeRequestRecord): void;
  getPendingRequest(requestId: string): PendingRuntimeRequestRecord | null;
}

export interface ProviderProjectionPort {
  handleDomainEvent(event: RuntimeDomainEvent): Promise<void>;
}

export interface ProviderRequestMessagePort {
  postRuntimeRequestMessage(spaceId: string, request: PendingRuntimeRequestRecord): Promise<void>;
}

export interface ProviderModelPort {
  configuredProviderModel(): string | undefined;
  providerPolicyTarget(threadId: string, suffix: string): string;
}

export interface ProviderRuntimePorts extends ProviderAuditPort, ProviderGuardPort, ProviderModelPort {
  provider: RuntimeProvider;
  snapshots: RuntimeSnapshotQuery;
  now(): string;
}

export type ProviderTurnSurface = 'main_chat' | 'session';

export interface TurnBufferAttachment {
  path: string;
}

export type TurnCompletionState = 'completed' | 'failed' | 'cancelled' | 'interrupted';
