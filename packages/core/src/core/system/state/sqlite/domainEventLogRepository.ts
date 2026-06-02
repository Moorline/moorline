import type { DatabaseSync } from 'node:sqlite';
import { RuntimeEventIntegrityError, type EventPersistenceResult } from './eventIntegrity.js';
import { mapRows } from './rowMappers.js';
import type { DomainEventRow, RuntimeDomainEvent } from './types.js';

export class DomainEventLogRepository {
  constructor(private readonly db: DatabaseSync) {}

  appendDomainEvent(event: RuntimeDomainEvent): EventPersistenceResult {
    const payloadJson = JSON.stringify(event.payload);
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO domain_events (
          event_id, thread_id, transport_resource_id, session_id, source_provider_event_id, type, payload_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.eventId,
        event.threadId,
        event.transportResourceId,
        event.sessionId,
        event.sourceProviderEventId ?? null,
        event.type,
        payloadJson,
        event.createdAt
      ) as { changes?: number };
    if ((result.changes ?? 0) > 0) {
      return { inserted: true };
    }

    const existing = this.getDomainEvent(event.eventId);
    if (
      existing?.threadId === event.threadId &&
      existing.transportResourceId === event.transportResourceId &&
      existing.sessionId === event.sessionId &&
      existing.sourceProviderEventId === (event.sourceProviderEventId ?? null) &&
      existing.type === event.type &&
      existing.payloadJson === payloadJson &&
      existing.createdAt === event.createdAt
    ) {
      return { inserted: false };
    }

    throw new RuntimeEventIntegrityError(`Conflicting domain event replay for event_id ${event.eventId}.`);
  }

  listDomainEvents(threadId: string): DomainEventRow[] {
    return mapRows<DomainEventRow>(
      this.db
        .prepare(`
        SELECT
          event_id as eventId,
          thread_id as threadId,
          transport_resource_id as transportResourceId,
          session_id as sessionId,
          source_provider_event_id as sourceProviderEventId,
          type,
          payload_json as payloadJson,
          created_at as createdAt
        FROM domain_events
        WHERE thread_id = ?
        ORDER BY created_at ASC, event_id ASC
      `)
        .all(threadId)
    );
  }

  private getDomainEvent(eventId: string): DomainEventRow | null {
    return (
      (this.db
        .prepare(`
          SELECT
            event_id as eventId,
            thread_id as threadId,
            transport_resource_id as transportResourceId,
            session_id as sessionId,
            source_provider_event_id as sourceProviderEventId,
            type,
            payload_json as payloadJson,
            created_at as createdAt
          FROM domain_events
          WHERE event_id = ?
        `)
        .get(eventId) as DomainEventRow | undefined) ?? null
    );
  }
}
