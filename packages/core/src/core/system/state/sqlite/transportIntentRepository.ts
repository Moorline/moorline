import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeTransportIntent } from '../../../../types/transport.js';
import { RuntimeEventIntegrityError, type EventPersistenceResult } from './eventIntegrity.js';
import { mapRows } from './rowMappers.js';
import { safeReadJsonValue } from '../safeJson.js';

interface TransportIntentRow {
  intentId: string;
  scopeId: string;
  transportPackageId: string | null;
  type: string;
  transportResourceId: string | null;
  payloadJson: string;
  occurredAt: string;
  processedAt: string | null;
  failedAt: string | null;
  failure: string | null;
}

function intentTransportResourceId(intent: RuntimeTransportIntent): string | null {
  if ('transportResourceId' in intent && typeof intent.transportResourceId === 'string') {
    return intent.transportResourceId;
  }
  if (intent.type === 'transport.resource.observed') {
    return intent.resource.id;
  }
  return null;
}

export class TransportIntentRepository {
  constructor(private readonly db: DatabaseSync) {}

  appendIntent(intent: RuntimeTransportIntent): EventPersistenceResult {
    const payloadJson = JSON.stringify(intent);
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO transport_intents (
          intent_id, scope_id, transport_package_id, type, transport_resource_id, payload_json, occurred_at,
          processed_at, failed_at, failure
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `)
      .run(
        intent.intentId,
        intent.scopeId,
        intent.transportPackageId ?? null,
        intent.type,
        intentTransportResourceId(intent),
        payloadJson,
        intent.occurredAt
      ) as { changes?: number };

    if ((result.changes ?? 0) > 0) {
      return { inserted: true };
    }

    const existing = this.getRow(intent.intentId);
    if (
      existing &&
      existing.scopeId === intent.scopeId &&
      existing.transportPackageId === (intent.transportPackageId ?? null) &&
      existing.type === intent.type &&
      existing.transportResourceId === intentTransportResourceId(intent) &&
      existing.payloadJson === payloadJson &&
      existing.occurredAt === intent.occurredAt
    ) {
      return { inserted: false };
    }

    throw new RuntimeEventIntegrityError(`Conflicting transport intent replay for intent_id ${intent.intentId}.`);
  }

  markProcessed(intentId: string, processedAt: string): void {
    this.db
      .prepare(`
        UPDATE transport_intents
        SET processed_at = ?, failed_at = NULL, failure = NULL
        WHERE intent_id = ?
      `)
      .run(processedAt, intentId);
  }

  markFailed(intentId: string, failedAt: string, failure: string): void {
    this.db
      .prepare(`
        UPDATE transport_intents
        SET failed_at = ?, failure = ?
        WHERE intent_id = ?
      `)
      .run(failedAt, failure, intentId);
  }

  listPending(limit = 100): RuntimeTransportIntent[] {
    return mapRows<TransportIntentRow>(
      this.db
        .prepare(`
          SELECT
            intent_id as intentId,
            scope_id as scopeId,
            transport_package_id as transportPackageId,
            type,
            transport_resource_id as transportResourceId,
            payload_json as payloadJson,
            occurred_at as occurredAt,
            processed_at as processedAt,
            failed_at as failedAt,
            failure
          FROM transport_intents
          WHERE processed_at IS NULL AND failed_at IS NULL
          ORDER BY occurred_at ASC, intent_id ASC
          LIMIT ?
        `)
        .all(limit)
    ).flatMap((row) => {
      const parsed = safeReadJsonValue<RuntimeTransportIntent>(row.payloadJson).value;
      return parsed ? [parsed] : [];
    });
  }

  private getRow(intentId: string): TransportIntentRow | null {
    return (
      (this.db
        .prepare(`
          SELECT
            intent_id as intentId,
            scope_id as scopeId,
            transport_package_id as transportPackageId,
            type,
            transport_resource_id as transportResourceId,
            payload_json as payloadJson,
            occurred_at as occurredAt,
            processed_at as processedAt,
            failed_at as failedAt,
            failure
          FROM transport_intents
          WHERE intent_id = ?
        `)
        .get(intentId) as TransportIntentRow | undefined) ?? null
    );
  }
}
