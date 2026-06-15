import type {
  ProviderSessionStatus,
  ProviderThreadTokenUsage,
  RuntimeAgentKind,
  RuntimeModeName
} from '../../../types/runtime.js';
import type { RuntimeProviderConnectionSnapshot } from '../../../types/plugin.js';

export interface ProviderConnectionRecord {
  threadId: string;
  providerPackageId: string;
  runtimeMode: RuntimeModeName;
  agentKind?: RuntimeAgentKind;
  workspacePath: string | null;
  providerCwd?: string | null;
  providerThreadId: string | null;
  status: ProviderSessionStatus;
  model: string | null;
  accountLabel: string | null;
  availableModels: string[];
  updatedAt: string;
  lastError: string | null;
  tokenUsage?: ProviderThreadTokenUsage;
  providerOptions?: Record<string, unknown>;
  capabilityMetadata: Record<string, unknown>;
}

export interface ProviderConnectionStore {
  get(threadId: string): ProviderConnectionRecord | null;
  list(): ProviderConnectionRecord[];
  upsert(input: ProviderConnectionRecord): ProviderConnectionRecord;
  delete(threadId: string): void;
}

export function toRuntimeProviderConnectionSnapshot(
  record: ProviderConnectionRecord
): RuntimeProviderConnectionSnapshot {
  return {
    threadId: record.threadId,
    providerPackageId: record.providerPackageId,
    runtimeMode: record.runtimeMode,
    agentKind: record.agentKind,
    workspacePath: record.workspacePath,
    providerCwd: record.providerCwd,
    providerThreadId: record.providerThreadId,
    status: record.status,
    model: record.model,
    accountLabel: record.accountLabel,
    availableModels: [...record.availableModels],
    updatedAt: record.updatedAt,
    lastError: record.lastError,
    ...(record.tokenUsage ? { tokenUsage: record.tokenUsage } : {}),
    capabilityMetadata: { ...record.capabilityMetadata }
  };
}
