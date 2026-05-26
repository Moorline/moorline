import type { RuntimeActorIdentity } from '../../../types/transport.js';

export type RuntimeReloadMode = 'graceful' | 'force';
export type RuntimeControlAction = 'reload' | 'set-accepting' | 'provider-stop' | 'provider-start';
export type RuntimeControlRequest =
  | {
      action: 'reload';
      mode: RuntimeReloadMode;
      reason: string;
      requestedBy: RuntimeActorIdentity;
    }
  | {
      action: 'set-accepting';
      accepting: boolean;
      reason: string;
      requestedBy: RuntimeActorIdentity;
    }
  | {
      action: 'provider-stop' | 'provider-start';
      threadId?: string;
      reason: string;
      requestedBy: RuntimeActorIdentity;
    };
export type RuntimeControlExecutionRequest = Exclude<RuntimeControlRequest, { action: 'reload' }>;

export interface RuntimeControlResult {
  accepted: boolean;
  detail: string;
}

export interface ProviderControlResult {
  ok: boolean;
  action: 'start' | 'stop';
  scope: 'all' | 'thread';
  threadId: string | null;
  requestedCount: number;
  affectedCount: number;
  skippedCount: number;
  failures: Array<{ threadId: string; error: string }>;
  message: string;
  remediation?: string;
}

export interface RuntimeControlStatus {
  acceptingNewWork: boolean;
  supervised: boolean;
}
