import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeWorkflowRunRecord } from '../../../../types/plugin.js';
import { mapRows } from './rowMappers.js';
import type { RuntimeWorkflowRunRow } from './types.js';

const WORKFLOW_RUN_SELECT = `
  SELECT
    run_id as runId,
    package_id as packageId,
    workflow_id as workflowId,
    status,
    input_json as inputJson,
    actor_json as actorJson,
    origin_json as originJson,
    result_json as resultJson,
    error,
    created_at as createdAt,
    updated_at as updatedAt,
    completed_at as completedAt
  FROM runtime_workflow_runs
`;

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hydrateWorkflowRun(row: RuntimeWorkflowRunRow | undefined): RuntimeWorkflowRunRecord | null {
  if (!row) {
    return null;
  }
  const actor = parseJsonRecord(row.actorJson);
  return {
    runId: row.runId,
    packageId: row.packageId,
    workflowId: row.workflowId,
    status: row.status,
    input: parseJsonRecord(row.inputJson) ?? {},
    actor: {
      actorId: typeof actor?.actorId === 'string' ? actor.actorId : 'unknown',
      ...(typeof actor?.displayName === 'string' ? { displayName: actor.displayName } : {})
    },
    ...(parseJsonRecord(row.originJson) ? { origin: parseJsonRecord(row.originJson)! } : {}),
    result: parseJsonRecord(row.resultJson),
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt
  };
}

function workflowRunRow(input: RuntimeWorkflowRunRecord): RuntimeWorkflowRunRow {
  return {
    runId: input.runId,
    packageId: input.packageId,
    workflowId: input.workflowId,
    status: input.status,
    inputJson: JSON.stringify(input.input ?? {}),
    actorJson: JSON.stringify(input.actor),
    originJson: input.origin ? JSON.stringify(input.origin) : null,
    resultJson: input.result ? JSON.stringify(input.result) : null,
    error: input.error ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt ?? null
  };
}

export class WorkflowRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(record: RuntimeWorkflowRunRecord): RuntimeWorkflowRunRecord {
    const row = workflowRunRow(record);
    this.db
      .prepare(
        `INSERT INTO runtime_workflow_runs (
           run_id, package_id, workflow_id, status, input_json, actor_json, origin_json,
           result_json, error, created_at, updated_at, completed_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status,
           input_json = excluded.input_json,
           actor_json = excluded.actor_json,
           origin_json = excluded.origin_json,
           result_json = excluded.result_json,
           error = excluded.error,
           updated_at = excluded.updated_at,
           completed_at = excluded.completed_at`
      )
      .run(
        row.runId,
        row.packageId,
        row.workflowId,
        row.status,
        row.inputJson,
        row.actorJson,
        row.originJson,
        row.resultJson,
        row.error,
        row.createdAt,
        row.updatedAt,
        row.completedAt
      );
    return this.get(row.runId)!;
  }

  get(runId: string): RuntimeWorkflowRunRecord | null {
    return hydrateWorkflowRun(
      this.db.prepare(`${WORKFLOW_RUN_SELECT} WHERE run_id = ?`).get(runId) as RuntimeWorkflowRunRow | undefined
    );
  }

  list(filter: { packageId?: string; workflowId?: string; status?: RuntimeWorkflowRunRecord['status']; limit?: number } = {}): RuntimeWorkflowRunRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.packageId) {
      clauses.push('package_id = ?');
      params.push(filter.packageId);
    }
    if (filter.workflowId) {
      clauses.push('workflow_id = ?');
      params.push(filter.workflowId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, filter.limit ?? 50);
    return mapRows<RuntimeWorkflowRunRow>(
      this.db.prepare(`${WORKFLOW_RUN_SELECT}${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit)
    )
      .map((row) => hydrateWorkflowRun(row))
      .filter((row): row is RuntimeWorkflowRunRecord => row !== null);
  }
}
