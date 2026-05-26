import type { DatabaseSync } from 'node:sqlite';
import { mapRows } from './rowMappers.js';
import type { ProviderBindingRecord } from './types.js';

const providerBindingSelect = `
  SELECT
    thread_id as threadId,
    provider,
    runtime_mode as runtimeMode,
    cwd,
    provider_thread_id as providerThreadId,
    status,
    model,
    account_label as accountLabel,
    available_models_json as availableModelsJson,
    updated_at as updatedAt,
    last_error as lastError,
    runtime_payload_json as runtimePayloadJson,
    capability_metadata_json as capabilityMetadataJson
  FROM provider_bindings
`;

export class ProviderBindingRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsertProviderBinding(row: ProviderBindingRecord): void {
    this.db
      .prepare(`
        INSERT INTO provider_bindings (
          thread_id, provider, runtime_mode, cwd, provider_thread_id, status, model,
          account_label, available_models_json, updated_at, last_error, runtime_payload_json, capability_metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          provider = excluded.provider,
          runtime_mode = excluded.runtime_mode,
          cwd = excluded.cwd,
          provider_thread_id = excluded.provider_thread_id,
          status = excluded.status,
          model = excluded.model,
          account_label = excluded.account_label,
          available_models_json = excluded.available_models_json,
          updated_at = excluded.updated_at,
          last_error = excluded.last_error,
          runtime_payload_json = excluded.runtime_payload_json,
          capability_metadata_json = excluded.capability_metadata_json
      `)
      .run(
        row.threadId,
        row.provider,
        row.runtimeMode,
        row.cwd,
        row.providerThreadId,
        row.status,
        row.model,
        row.accountLabel,
        row.availableModelsJson,
        row.updatedAt,
        row.lastError,
        row.runtimePayloadJson,
        row.capabilityMetadataJson
      );
  }

  getProviderBinding(threadId: string): ProviderBindingRecord | null {
    return (this.db.prepare(`${providerBindingSelect} WHERE thread_id = ?`).get(threadId) as ProviderBindingRecord | undefined) ?? null;
  }

  listProviderBindings(): ProviderBindingRecord[] {
    return mapRows<ProviderBindingRecord>(this.db.prepare(`${providerBindingSelect} ORDER BY updated_at ASC, thread_id ASC`).all());
  }

  deleteProviderBinding(threadId: string): void {
    this.db.prepare(`DELETE FROM provider_bindings WHERE thread_id = ?`).run(threadId);
  }
}
