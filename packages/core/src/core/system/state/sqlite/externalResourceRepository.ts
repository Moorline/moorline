import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeExternalResourceRecord, RuntimeExternalResourceRef } from '../../../../types/external.js';
import { mapRows } from './rowMappers.js';
import {
  hydrateExternalResource,
  type RuntimeExternalResourceRow,
  type RuntimeSessionExternalResourceRow
} from './types.js';

const EXTERNAL_RESOURCE_SELECT = `
  SELECT
    provider,
    kind,
    external_id as externalId,
    url,
    title,
    state,
    metadata_json as metadataJson,
    first_seen_at as firstSeenAt,
    last_seen_at as lastSeenAt
  FROM runtime_external_resources
`;

export class ExternalResourceRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(input: RuntimeExternalResourceRef & { state?: string; nowIso: string }): RuntimeExternalResourceRecord {
    const existing = this.get(input);
    this.db
      .prepare(`
        INSERT INTO runtime_external_resources (
          provider, kind, external_id, url, title, state, metadata_json, first_seen_at, last_seen_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, kind, external_id) DO UPDATE SET
          url = COALESCE(excluded.url, runtime_external_resources.url),
          title = COALESCE(excluded.title, runtime_external_resources.title),
          state = COALESCE(excluded.state, runtime_external_resources.state),
          metadata_json = excluded.metadata_json,
          last_seen_at = excluded.last_seen_at
      `)
      .run(
        input.provider,
        input.kind,
        input.id,
        input.url ?? null,
        input.title ?? null,
        input.state ?? null,
        JSON.stringify(input.metadata ?? {}),
        existing?.firstSeenAt ?? input.nowIso,
        input.nowIso
      );
    return this.get(input)!;
  }

  get(input: Pick<RuntimeExternalResourceRef, 'provider' | 'kind' | 'id'>): RuntimeExternalResourceRecord | null {
    return hydrateExternalResource(
      this.db
        .prepare(`${EXTERNAL_RESOURCE_SELECT} WHERE provider = ? AND kind = ? AND external_id = ?`)
        .get(input.provider, input.kind, input.id) as RuntimeExternalResourceRow | undefined
    );
  }

  list(filter: { provider?: string; kind?: string; limit?: number } = {}): RuntimeExternalResourceRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.provider) {
      clauses.push('provider = ?');
      params.push(filter.provider);
    }
    if (filter.kind) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, filter.limit ?? 200);
    return mapRows<RuntimeExternalResourceRow>(
      this.db.prepare(`${EXTERNAL_RESOURCE_SELECT}${where} ORDER BY last_seen_at DESC LIMIT ?`).all(...params, limit)
    )
      .map((row) => hydrateExternalResource(row)!)
      .filter((row): row is RuntimeExternalResourceRecord => row !== null);
  }

  bindSession(input: {
    sessionId: string;
    resource: RuntimeExternalResourceRef;
    relationship: string;
    nowIso: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO runtime_session_external_resources (
          session_id, provider, kind, external_id, relationship, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, provider, kind, external_id) DO UPDATE SET
          relationship = excluded.relationship
      `)
      .run(
        input.sessionId,
        input.resource.provider,
        input.resource.kind,
        input.resource.id,
        input.relationship,
        input.nowIso
      );
  }

  listSessionBindingsForResource(resource: RuntimeExternalResourceRef): RuntimeSessionExternalResourceRow[] {
    return mapRows<RuntimeSessionExternalResourceRow>(
      this.db
        .prepare(`
          SELECT
            session_id as sessionId,
            provider,
            kind,
            external_id as externalId,
            relationship,
            created_at as createdAt
          FROM runtime_session_external_resources
          WHERE provider = ? AND kind = ? AND external_id = ?
          ORDER BY created_at ASC
        `)
        .all(resource.provider, resource.kind, resource.id)
    );
  }

  listResourcesForSession(sessionId: string): RuntimeExternalResourceRecord[] {
    return mapRows<RuntimeExternalResourceRow>(
      this.db
        .prepare(`
          ${EXTERNAL_RESOURCE_SELECT}
          WHERE (provider, kind, external_id) IN (
            SELECT provider, kind, external_id
            FROM runtime_session_external_resources
            WHERE session_id = ?
          )
          ORDER BY last_seen_at DESC
        `)
        .all(sessionId)
    )
      .map((row) => hydrateExternalResource(row)!)
      .filter((row): row is RuntimeExternalResourceRecord => row !== null);
  }
}
