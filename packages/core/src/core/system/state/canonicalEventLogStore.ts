import type { DatabaseSync } from 'node:sqlite';
import type { ProviderRuntimeEvent } from '../../../types/runtime.js';
import { safeReadJsonValue } from '../state/safeJson.js';
import { openRuntimeSqliteDatabase } from './sqlite/connection.js';
import { RuntimeEventIntegrityError, type EventPersistenceResult } from './sqlite/eventIntegrity.js';
import { mapRows } from './sqlite/rowMappers.js';

interface CanonicalProviderEventRow {
  eventId: string;
  provider: string;
  threadId: string;
  transportResourceId: string | null;
  turnId: string | null;
  itemId: string | null;
  requestId: string | null;
  type: string;
  payloadJson: string;
  createdAt: string;
}

export class CanonicalEventLogStore {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;

  constructor(pathOrDb: string | DatabaseSync) {
    if (typeof pathOrDb === 'string') {
      this.db = openRuntimeSqliteDatabase(pathOrDb);
      this.ownsDb = true;
      return;
    }
    this.db = pathOrDb;
    this.ownsDb = false;
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  append(event: ProviderRuntimeEvent, transportResourceId: string | null): EventPersistenceResult {
    const providerPackageId = event.providerPackageId ?? event.provider ?? 'unknown';
    const payloadJson = JSON.stringify(event.payload);
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO runtime_events (
          event_id, provider, thread_id, transport_resource_id, turn_id, item_id, request_id, type, payload_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.eventId,
        providerPackageId,
        event.threadId,
        transportResourceId,
        event.turnId ?? null,
        event.itemId ?? null,
        event.requestId ?? null,
        event.type,
        payloadJson,
        event.createdAt
      ) as { changes?: number };
    if ((result.changes ?? 0) > 0) {
      return { inserted: true };
    }

    const existing = this.getRow(event.eventId);
    if (
      existing &&
      existing.provider === providerPackageId &&
      existing.threadId === event.threadId &&
      existing.transportResourceId === transportResourceId &&
      existing.turnId === (event.turnId ?? null) &&
      existing.itemId === (event.itemId ?? null) &&
      existing.requestId === (event.requestId ?? null) &&
      existing.type === event.type &&
      existing.payloadJson === payloadJson &&
      existing.createdAt === event.createdAt
    ) {
      return { inserted: false };
    }

    throw new RuntimeEventIntegrityError(`Conflicting provider event replay for event_id ${event.eventId}.`);
  }

  isProviderEventProcessed(eventId: string): boolean {
    return (
      this.db
        .prepare(`
        SELECT 1
        FROM provider_event_processing
        WHERE event_id = ?
      `)
        .get(eventId) !== undefined
    );
  }

  markProviderEventProcessed(eventId: string, processedAt: string): void {
    this.db
      .prepare(`
        INSERT INTO provider_event_processing (event_id, processed_at)
        VALUES (?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          processed_at = excluded.processed_at
      `)
      .run(eventId, processedAt);
  }

  listByThread(threadId: string): ProviderRuntimeEvent[] {
    return mapRows<CanonicalProviderEventRow>(
      this.db
        .prepare(`
        SELECT
          event_id as eventId,
          provider,
          thread_id as threadId,
          transport_resource_id as transportResourceId,
          turn_id as turnId,
          item_id as itemId,
          request_id as requestId,
          type,
          payload_json as payloadJson,
          created_at as createdAt
        FROM runtime_events
        WHERE thread_id = ?
        ORDER BY created_at ASC, event_id ASC
      `)
        .all(threadId)
    )
      .flatMap((row) => {
        const mapped = this.mapRow(row);
        return mapped ? [mapped] : [];
      });
  }

  listRecent(limit = 100): ProviderRuntimeEvent[] {
    return mapRows<CanonicalProviderEventRow>(
      this.db
        .prepare(`
        SELECT
          event_id as eventId,
          provider,
          thread_id as threadId,
          transport_resource_id as transportResourceId,
          turn_id as turnId,
          item_id as itemId,
          request_id as requestId,
          type,
          payload_json as payloadJson,
          created_at as createdAt
        FROM runtime_events
        ORDER BY created_at DESC, event_id DESC
        LIMIT ?
      `)
        .all(limit)
    )
      .flatMap((row) => {
        const mapped = this.mapRow(row);
        return mapped ? [mapped] : [];
      });
  }

  private mapRow(row: CanonicalProviderEventRow): ProviderRuntimeEvent | null {
    const payload = safeReadJsonValue<ProviderRuntimeEvent['payload']>(row.payloadJson).value;
    if (payload === undefined) {
      return null;
    }

    return {
      eventId: row.eventId,
      providerPackageId: row.provider as ProviderRuntimeEvent['providerPackageId'],
      provider: row.provider as ProviderRuntimeEvent['provider'],
      threadId: row.threadId,
      createdAt: row.createdAt,
      ...(row.turnId ? { turnId: row.turnId } : {}),
      ...(row.itemId ? { itemId: row.itemId } : {}),
      ...(row.requestId ? { requestId: row.requestId } : {}),
      type: row.type as ProviderRuntimeEvent['type'],
      payload
    } as ProviderRuntimeEvent;
  }

  private getRow(eventId: string): CanonicalProviderEventRow | null {
    return (
      (this.db
        .prepare(`
        SELECT
          event_id as eventId,
          provider,
          thread_id as threadId,
          transport_resource_id as transportResourceId,
          turn_id as turnId,
          item_id as itemId,
          request_id as requestId,
          type,
          payload_json as payloadJson,
          created_at as createdAt
        FROM runtime_events
        WHERE event_id = ?
      `)
        .get(eventId) as CanonicalProviderEventRow | undefined) ?? null
    );
  }
}
