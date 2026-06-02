import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeExternalResourceRef, RuntimeWorkItemRecord, RuntimeWorkItemStatus } from '../../../../types/external.js';
import { mapRows } from './rowMappers.js';
import { hydrateWorkItem, type RuntimeWorkItemRow } from './types.js';

const WORK_ITEM_SELECT = `
  SELECT
    work_item_id as workItemId,
    package_id as packageId,
    queue,
    status,
    priority,
    idempotency_key as idempotencyKey,
    external_provider as externalProvider,
    external_kind as externalKind,
    external_id as externalId,
    external_url as externalUrl,
    external_title as externalTitle,
    external_metadata_json as externalMetadataJson,
    session_id as sessionId,
    payload_json as payloadJson,
    phase,
    attempts,
    max_attempts as maxAttempts,
    run_after as runAfter,
    lease_owner as leaseOwner,
    lease_expires_at as leaseExpiresAt,
    last_error as lastError,
    created_at as createdAt,
    updated_at as updatedAt,
    completed_at as completedAt
  FROM runtime_work_items
`;

function workItemRow(input: RuntimeWorkItemRecord): RuntimeWorkItemRow {
  return {
    workItemId: input.workItemId,
    packageId: input.packageId,
    queue: input.queue,
    status: input.status,
    priority: input.priority,
    idempotencyKey: input.idempotencyKey ?? null,
    externalProvider: input.externalResource?.provider ?? null,
    externalKind: input.externalResource?.kind ?? null,
    externalId: input.externalResource?.id ?? null,
    externalUrl: input.externalResource?.url ?? null,
    externalTitle: input.externalResource?.title ?? null,
    externalMetadataJson: input.externalResource ? JSON.stringify(input.externalResource.metadata ?? {}) : null,
    sessionId: input.sessionId ?? null,
    payloadJson: JSON.stringify(input.payload),
    phase: input.phase ?? null,
    attempts: input.attempts,
    maxAttempts: input.maxAttempts,
    runAfter: input.runAfter,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: input.leaseExpiresAt,
    lastError: input.lastError,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt
  };
}

export class WorkItemRepository {
  constructor(private readonly db: DatabaseSync) {}

  private insert(row: RuntimeWorkItemRow, conflictClause: string): void {
    this.db
      .prepare(`
        INSERT ${conflictClause} INTO runtime_work_items (
          work_item_id, package_id, queue, status, priority, idempotency_key,
          external_provider, external_kind, external_id, external_url, external_title, external_metadata_json,
          session_id, payload_json, phase, attempts, max_attempts, run_after, lease_owner, lease_expires_at,
          last_error, created_at, updated_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.workItemId,
        row.packageId,
        row.queue,
        row.status,
        row.priority,
        row.idempotencyKey,
        row.externalProvider,
        row.externalKind,
        row.externalId,
        row.externalUrl,
        row.externalTitle,
        row.externalMetadataJson,
        row.sessionId,
        row.payloadJson,
        row.phase,
        row.attempts,
        row.maxAttempts,
        row.runAfter,
        row.leaseOwner,
        row.leaseExpiresAt,
        row.lastError,
        row.createdAt,
        row.updatedAt,
        row.completedAt
      );
  }

  update(record: RuntimeWorkItemRecord): RuntimeWorkItemRecord {
    const row = workItemRow(record);
    this.db
      .prepare(`
        UPDATE runtime_work_items
        SET
          status = ?,
          priority = ?,
          external_provider = ?,
          external_kind = ?,
          external_id = ?,
          external_url = ?,
          external_title = ?,
          external_metadata_json = ?,
          session_id = ?,
          payload_json = ?,
          phase = ?,
          attempts = ?,
          max_attempts = ?,
          run_after = ?,
          lease_owner = ?,
          lease_expires_at = ?,
          last_error = ?,
          updated_at = ?,
          completed_at = ?
        WHERE work_item_id = ?
      `)
      .run(
        row.status,
        row.priority,
        row.externalProvider,
        row.externalKind,
        row.externalId,
        row.externalUrl,
        row.externalTitle,
        row.externalMetadataJson,
        row.sessionId,
        row.payloadJson,
        row.phase,
        row.attempts,
        row.maxAttempts,
        row.runAfter,
        row.leaseOwner,
        row.leaseExpiresAt,
        row.lastError,
        row.updatedAt,
        row.completedAt,
        row.workItemId
      );
    return this.get(record.workItemId)!;
  }

  enqueue(record: RuntimeWorkItemRecord): RuntimeWorkItemRecord {
    const row = workItemRow(record);
    if (row.idempotencyKey) {
      this.insert(row, 'OR IGNORE');
      return this.findByIdempotencyKey(row.packageId, row.queue, row.idempotencyKey)!;
    }
    this.insert(row, '');
    return this.get(record.workItemId)!;
  }

  get(workItemId: string): RuntimeWorkItemRecord | null {
    return hydrateWorkItem(
      this.db.prepare(`${WORK_ITEM_SELECT} WHERE work_item_id = ?`).get(workItemId) as RuntimeWorkItemRow | undefined
    );
  }

  findByIdempotencyKey(packageId: string, queue: string, idempotencyKey: string): RuntimeWorkItemRecord | null {
    return hydrateWorkItem(
      this.db
        .prepare(`${WORK_ITEM_SELECT} WHERE package_id = ? AND queue = ? AND idempotency_key = ?`)
        .get(packageId, queue, idempotencyKey) as RuntimeWorkItemRow | undefined
    );
  }

  list(filter: {
    packageId?: string;
    queue?: string;
    status?: RuntimeWorkItemStatus;
    externalResource?: RuntimeExternalResourceRef;
    limit?: number;
  } = {}): RuntimeWorkItemRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.packageId) {
      clauses.push('package_id = ?');
      params.push(filter.packageId);
    }
    if (filter.queue) {
      clauses.push('queue = ?');
      params.push(filter.queue);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.externalResource) {
      clauses.push('external_provider = ? AND external_kind = ? AND external_id = ?');
      params.push(filter.externalResource.provider, filter.externalResource.kind, filter.externalResource.id);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, filter.limit ?? 200);
    return mapRows<RuntimeWorkItemRow>(
      this.db.prepare(`${WORK_ITEM_SELECT}${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit)
    )
      .map((row) => hydrateWorkItem(row)!)
      .filter((row): row is RuntimeWorkItemRecord => row !== null);
  }

  claim(input: {
    packageId: string;
    queue: string;
    leaseOwner: string;
    leaseExpiresAt: string;
    nowIso: string;
  }): RuntimeWorkItemRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const candidate = hydrateWorkItem(
        this.db
          .prepare(`
            ${WORK_ITEM_SELECT}
            WHERE package_id = ?
              AND queue = ?
              AND (
                status = 'queued'
                OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
              )
              AND (run_after IS NULL OR run_after <= ?)
            ORDER BY priority DESC, created_at ASC, work_item_id ASC
            LIMIT 1
          `)
          .get(input.packageId, input.queue, input.nowIso, input.nowIso) as RuntimeWorkItemRow | undefined
      );
      if (!candidate) {
        this.db.exec('COMMIT');
        return null;
      }
      const result = this.db
        .prepare(`
          UPDATE runtime_work_items
          SET
            status = 'running',
            attempts = attempts + 1,
            lease_owner = ?,
            lease_expires_at = ?,
            updated_at = ?,
            completed_at = NULL
          WHERE work_item_id = ?
            AND package_id = ?
            AND queue = ?
            AND (
              status = 'queued'
              OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
            )
            AND (run_after IS NULL OR run_after <= ?)
        `)
        .run(
          input.leaseOwner,
          input.leaseExpiresAt,
          input.nowIso,
          candidate.workItemId,
          input.packageId,
          input.queue,
          input.nowIso,
          input.nowIso
        );
      const claimed = result.changes > 0 ? this.get(candidate.workItemId) : null;
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
