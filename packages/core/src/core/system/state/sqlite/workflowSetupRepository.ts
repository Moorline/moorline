import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeActorIdentity } from '../../../../types/transport.js';
import type { RuntimeWorkflowRunOrigin, RuntimeWorkflowSetupRecord } from '../../../../types/plugin.js';
import { mapRows } from './rowMappers.js';
import type { RuntimeWorkflowSetupRow } from './types.js';

const WORKFLOW_SETUP_SELECT = `
  SELECT
    setup_id as setupId,
    package_id as packageId,
    workflow_id as workflowId,
    status,
    actor_json as actorJson,
    origin_json as originJson,
    answers_json as answersJson,
    current_question as currentQuestion,
    draft_input_json as draftInputJson,
    draft_summary as draftSummary,
    run_id as runId,
    error,
    created_at as createdAt,
    updated_at as updatedAt,
    expires_at as expiresAt
  FROM runtime_workflow_setups
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

function parseAnswers(value: string): RuntimeWorkflowSetupRecord['answers'] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => ({
        answer: typeof entry.answer === 'string' ? entry.answer : '',
        answeredAt: typeof entry.answeredAt === 'string' ? entry.answeredAt : ''
      }))
      .filter((entry) => entry.answer && entry.answeredAt);
  } catch {
    return [];
  }
}

function hydrateActor(value: string): RuntimeActorIdentity {
  const actor = parseJsonRecord(value);
  return {
    actorId: typeof actor?.actorId === 'string' ? actor.actorId : 'unknown',
    ...(typeof actor?.displayName === 'string' ? { displayName: actor.displayName } : {})
  };
}

function hydrateWorkflowSetup(row: RuntimeWorkflowSetupRow | undefined): RuntimeWorkflowSetupRecord | null {
  if (!row) {
    return null;
  }
  const origin = parseJsonRecord(row.originJson) as RuntimeWorkflowRunOrigin | null;
  return {
    setupId: row.setupId,
    packageId: row.packageId,
    workflowId: row.workflowId,
    status: row.status,
    actor: hydrateActor(row.actorJson),
    ...(origin ? { origin } : {}),
    answers: parseAnswers(row.answersJson),
    currentQuestion: row.currentQuestion,
    draftInput: parseJsonRecord(row.draftInputJson),
    draftSummary: row.draftSummary,
    runId: row.runId,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt
  };
}

function workflowSetupRow(input: RuntimeWorkflowSetupRecord): RuntimeWorkflowSetupRow {
  return {
    setupId: input.setupId,
    packageId: input.packageId,
    workflowId: input.workflowId,
    status: input.status,
    actorJson: JSON.stringify(input.actor),
    originJson: input.origin ? JSON.stringify(input.origin) : null,
    answersJson: JSON.stringify(input.answers ?? []),
    currentQuestion: input.currentQuestion,
    draftInputJson: input.draftInput ? JSON.stringify(input.draftInput) : null,
    draftSummary: input.draftSummary,
    runId: input.runId,
    error: input.error,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    expiresAt: input.expiresAt
  };
}

export class WorkflowSetupRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(record: RuntimeWorkflowSetupRecord): RuntimeWorkflowSetupRecord {
    const row = workflowSetupRow(record);
    this.db
      .prepare(
        `INSERT INTO runtime_workflow_setups (
           setup_id, package_id, workflow_id, status, actor_json, origin_json, answers_json,
           current_question, draft_input_json, draft_summary, run_id, error,
           created_at, updated_at, expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(setup_id) DO UPDATE SET
           status = excluded.status,
           actor_json = excluded.actor_json,
           origin_json = excluded.origin_json,
           answers_json = excluded.answers_json,
           current_question = excluded.current_question,
           draft_input_json = excluded.draft_input_json,
           draft_summary = excluded.draft_summary,
           run_id = excluded.run_id,
           error = excluded.error,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`
      )
      .run(
        row.setupId,
        row.packageId,
        row.workflowId,
        row.status,
        row.actorJson,
        row.originJson,
        row.answersJson,
        row.currentQuestion,
        row.draftInputJson,
        row.draftSummary,
        row.runId,
        row.error,
        row.createdAt,
        row.updatedAt,
        row.expiresAt
      );
    return this.get(row.setupId)!;
  }

  get(setupId: string): RuntimeWorkflowSetupRecord | null {
    return hydrateWorkflowSetup(
      this.db.prepare(`${WORKFLOW_SETUP_SELECT} WHERE setup_id = ?`).get(setupId) as RuntimeWorkflowSetupRow | undefined
    );
  }

  list(filter: { packageId?: string; workflowId?: string; status?: RuntimeWorkflowSetupRecord['status']; limit?: number } = {}): RuntimeWorkflowSetupRecord[] {
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
    return mapRows<RuntimeWorkflowSetupRow>(
      this.db.prepare(`${WORKFLOW_SETUP_SELECT}${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit)
    )
      .map((row) => hydrateWorkflowSetup(row))
      .filter((row): row is RuntimeWorkflowSetupRecord => row !== null);
  }
}
