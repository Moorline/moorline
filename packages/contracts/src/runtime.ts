export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeCommandRunner {
  run(command: string, args: string[], cwd?: string): Promise<CommandResult>;
}

export type RuntimeModeName = 'full-access' | 'approval-required';

const RUNTIME_MODE_NAMES: RuntimeModeName[] = ['full-access', 'approval-required'];

function isRuntimeModeName(value: unknown): value is RuntimeModeName {
  return value === 'full-access' || value === 'approval-required';
}

export function parseRuntimeModeName(value: unknown, label = 'runtime_mode'): RuntimeModeName {
  if (isRuntimeModeName(value)) {
    return value;
  }
  throw new Error(`${label} must be one of: ${RUNTIME_MODE_NAMES.join(', ')}.`);
}

export type ProviderPackageId = string;

export type ProviderSessionStatus =
  | 'connecting'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'error'
  | 'closed';

export interface ProviderAccountMetadata {
  accountLabel: string | null;
  availableModels: string[];
}

export type ProviderInputImage = { url: string } | { localPath: string };
export type ProviderMessagePhase = 'commentary' | 'final_answer';

export interface ProviderThreadTokenUsage {
  totalTokens: number;
  lastTurnTokens: number | null;
  modelContextWindow: number | null;
}

export type CanonicalItemType =
  | 'assistant_message'
  | 'reasoning'
  | 'plan'
  | 'command_execution'
  | 'file_change'
  | 'web_search'
  | 'image_view'
  | 'dynamic_tool_call'
  | 'error'
  | 'unknown';

export type CanonicalRequestType =
  | 'command_execution_approval'
  | 'file_read_approval'
  | 'file_change_approval'
  | 'apply_patch_approval'
  | 'exec_command_approval'
  | 'tool_user_input'
  | 'dynamic_tool_call'
  | 'auth_tokens_refresh'
  | 'unknown';

export type ProviderApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ProviderSessionRecord {
  providerPackageId: ProviderPackageId;
  provider?: ProviderPackageId;
  providerSessionKind?: string;
  capabilities?: Record<string, unknown>;
  nativeMetadata?: Record<string, unknown>;
  threadId: string;
  runtimeMode: RuntimeModeName;
  cwd: string;
  model?: string;
  status: ProviderSessionStatus;
  activeTurnId?: string;
  resumeCursor?: {
    threadId: string;
  };
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface ProviderRuntimeEventBase {
  eventId: string;
  providerPackageId: ProviderPackageId;
  provider?: ProviderPackageId;
  providerSessionKind?: string;
  capabilities?: Record<string, unknown>;
  nativeMetadata?: Record<string, unknown>;
  threadId: string;
  createdAt: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
}

export type ProviderRuntimeEvent =
  | (ProviderRuntimeEventBase & {
      type: 'provider.metadata.updated';
      payload: ProviderAccountMetadata;
    })
  | (ProviderRuntimeEventBase & {
      type: 'session.state.changed';
      payload: {
        state: ProviderSessionStatus;
        reason?: string;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'thread.started';
      payload: {
        providerThreadId: string;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'thread.state.changed';
      payload: {
        state: 'open' | 'archived' | 'closed' | 'compacted';
        detail?: unknown;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'thread.token-usage.updated';
      payload: ProviderThreadTokenUsage;
    })
  | (ProviderRuntimeEventBase & {
      type: 'turn.started';
      payload: {
        model?: string;
        effort?: string;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'turn.completed';
      payload: {
        state: 'completed' | 'failed' | 'cancelled' | 'interrupted';
        stopReason?: string;
        errorMessage?: string;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'turn.aborted';
      payload: {
        reason: string;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'content.delta';
      payload: {
        streamKind: 'assistant_text';
        delta: string;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'item.started' | 'item.completed';
      payload: {
        itemType: CanonicalItemType;
        title?: string;
        detail?: string;
        status?: string;
        localPath?: string;
        phase?: ProviderMessagePhase;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'request.opened';
      payload: {
        requestType: CanonicalRequestType;
        detail?: string;
        args?: unknown;
        parameterKeys?: string[];
        parameterSummary?: Record<string, unknown>;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'request.resolved';
      payload: {
        requestType: CanonicalRequestType;
        decision?: ProviderApprovalDecision;
        resolution?: unknown;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'user-input.requested';
      payload: {
        questions: Array<{
          id: string;
          header: string;
          question: string;
          options: Array<{
            label: string;
            description: string;
          }>;
        }>;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'user-input.resolved';
      payload: {
        answers: Record<string, string | string[]>;
      };
    })
  | (ProviderRuntimeEventBase & {
      type: 'runtime.warning' | 'runtime.error';
      payload: {
        message: string;
        class?: string;
        detail?: unknown;
      };
    });

export interface PendingRuntimeRequestRecord {
  requestId: string;
  threadId: string;
  turnId: string | null;
  transportResourceId: string;
  requesterUserId: string | null;
  messageId: string | null;
  requestType: CanonicalRequestType;
  status: 'open' | 'resolved';
  detail: string | null;
  questionsJson: string | null;
  decision: ProviderApprovalDecision | null;
  createdAt: string;
  resolvedAt: string | null;
}
