import { SqliteSessionStore } from '../../system/state/sqliteSessionStore.js';
import { isRecord, safeReadJson } from '../../system/state/safeJson.js';
import type { ProviderThreadTokenUsage } from '../../../types/runtime.js';
import type { ProviderBindingRecord } from './runtimeDomain.js';
import type { ProviderConnectionRecord, ProviderConnectionStore } from './providerProjectionTypes.js';

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  return safeReadJson(value, isRecord).value;
}

function parseStringList(value: string | null): string[] {
  const parsed = safeReadJson(value, (entry): entry is string[] =>
    Array.isArray(entry) && entry.every((item) => typeof item === 'string')
  ).value;
  return parsed ?? [];
}

export class ProviderSessionDirectory implements ProviderConnectionStore {
  constructor(private readonly store: SqliteSessionStore) {}

  get(threadId: string): ProviderConnectionRecord | null {
    const binding = this.store.getProviderBinding(threadId);
    return binding ? this.map(binding) : null;
  }

  list(): ProviderConnectionRecord[] {
    return this.store.listProviderBindings().map((binding) => this.map(binding));
  }

  upsert(input: ProviderConnectionRecord): ProviderConnectionRecord {
    const capabilityMetadata = input.capabilityMetadata ?? {};
    const runtimePayload = {
      cwd: input.workspacePath,
      model: input.model,
      resumeThreadId: input.providerThreadId,
      ...(input.tokenUsage ? { tokenUsage: input.tokenUsage } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      ...(Object.keys(capabilityMetadata).length > 0 ? { capabilityMetadata } : {})
    };

    this.store.upsertProviderBinding({
      threadId: input.threadId,
      provider: input.providerPackageId,
      runtimeMode: input.runtimeMode,
      cwd: input.workspacePath,
      providerThreadId: input.providerThreadId,
      status: input.status,
      model: input.model,
      accountLabel: input.accountLabel,
      availableModelsJson: JSON.stringify(input.availableModels ?? []),
      updatedAt: input.updatedAt,
      lastError: input.lastError,
      runtimePayloadJson: JSON.stringify(runtimePayload),
      capabilityMetadataJson: Object.keys(capabilityMetadata).length > 0
        ? JSON.stringify(capabilityMetadata)
        : null
    });

    return this.get(input.threadId)!;
  }

  delete(threadId: string): void {
    this.store.deleteProviderBinding(threadId);
  }

  private map(binding: ProviderBindingRecord): ProviderConnectionRecord {
    const runtimePayloadRecord = parseJsonRecord(binding.runtimePayloadJson);
    const capabilityMetadata = parseJsonRecord(binding.capabilityMetadataJson);
    const tokenUsage = this.parseTokenUsage(runtimePayloadRecord?.tokenUsage);
    return {
      threadId: binding.threadId,
      providerPackageId: binding.provider,
      runtimeMode: binding.runtimeMode,
      workspacePath: typeof runtimePayloadRecord?.cwd === 'string' ? runtimePayloadRecord.cwd : binding.cwd,
      providerThreadId: binding.providerThreadId,
      status: binding.status,
      model: typeof runtimePayloadRecord?.model === 'string' ? runtimePayloadRecord.model : binding.model,
      accountLabel: binding.accountLabel,
      availableModels: parseStringList(binding.availableModelsJson),
      updatedAt: binding.updatedAt,
      lastError: binding.lastError,
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(runtimePayloadRecord?.providerOptions && typeof runtimePayloadRecord.providerOptions === 'object'
        ? { providerOptions: runtimePayloadRecord.providerOptions as Record<string, unknown> }
        : {}),
      capabilityMetadata: capabilityMetadata ?? {}
    };
  }

  private parseTokenUsage(value: unknown): ProviderThreadTokenUsage | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const totalTokens = typeof record.totalTokens === 'number' ? record.totalTokens : null;
    const lastTurnTokens = typeof record.lastTurnTokens === 'number' ? record.lastTurnTokens : null;
    const modelContextWindow = typeof record.modelContextWindow === 'number' ? record.modelContextWindow : null;
    if (totalTokens === null) {
      return undefined;
    }
    return {
      totalTokens,
      lastTurnTokens,
      modelContextWindow
    };
  }
}
