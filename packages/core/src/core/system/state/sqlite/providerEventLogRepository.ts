import type { DatabaseSync } from 'node:sqlite';
import { RuntimeEventIntegrityError, type EventPersistenceResult } from './eventIntegrity.js';
import { mapRows } from './rowMappers.js';
import type { ProviderRuntimeEvent, RuntimeEventRow } from './types.js';

export class ProviderEventLogRepository {
  constructor(private readonly db: DatabaseSync) {}

  appendRuntimeEvent(event: ProviderRuntimeEvent, spaceId: string | null): EventPersistenceResult {
    const providerPackageId = event.providerPackageId ?? event.provider ?? 'unknown';
    const payloadJson = JSON.stringify(event.payload);
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO runtime_events (
          event_id, provider, thread_id, space_id, turn_id, item_id, request_id, type, payload_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.eventId,
        providerPackageId,
        event.threadId,
        spaceId,
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

    const existing = this.getRuntimeEvent(event.eventId);
    if (
      existing &&
      existing.provider === providerPackageId &&
      existing.threadId === event.threadId &&
      existing.spaceId === spaceId &&
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

  listRuntimeEvents(threadId: string): RuntimeEventRow[] {
    return mapRows<RuntimeEventRow>(
      this.db
        .prepare(`
        SELECT
          event_id as eventId,
          provider,
          thread_id as threadId,
          space_id as spaceId,
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
    );
  }

  private getRuntimeEvent(eventId: string): RuntimeEventRow | null {
    return (
      (this.db
        .prepare(`
        SELECT
          event_id as eventId,
          provider,
          thread_id as threadId,
          space_id as spaceId,
          turn_id as turnId,
          item_id as itemId,
          request_id as requestId,
          type,
          payload_json as payloadJson,
          created_at as createdAt
        FROM runtime_events
        WHERE event_id = ?
      `)
        .get(eventId) as RuntimeEventRow | undefined) ?? null
    );
  }
}
