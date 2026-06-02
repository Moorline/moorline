import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeGateRunRecord } from '../../../../types/external.js';
import { mapRows } from './rowMappers.js';
import { hydrateGateRun, type RuntimeGateRunRow } from './types.js';

const GATE_RUN_SELECT = `
  SELECT
    gate_run_id as gateRunId,
    gate_id as gateId,
    package_id as packageId,
    work_item_id as workItemId,
    session_id as sessionId,
    command,
    args_json as argsJson,
    cwd,
    required,
    status,
    exit_code as exitCode,
    stdout,
    stderr,
    started_at as startedAt,
    completed_at as completedAt
  FROM runtime_gate_runs
`;

export class GateRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(record: RuntimeGateRunRecord): RuntimeGateRunRecord {
    this.db
      .prepare(`
        INSERT INTO runtime_gate_runs (
          gate_run_id, gate_id, package_id, work_item_id, session_id, command, args_json, cwd,
          required, status, exit_code, stdout, stderr, started_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(gate_run_id) DO UPDATE SET
          status = excluded.status,
          exit_code = excluded.exit_code,
          stdout = excluded.stdout,
          stderr = excluded.stderr,
          completed_at = excluded.completed_at
      `)
      .run(
        record.gateRunId,
        record.gateId,
        record.packageId,
        record.workItemId ?? null,
        record.sessionId ?? null,
        record.command,
        JSON.stringify(record.args),
        record.cwd ?? null,
        record.required ? 1 : 0,
        record.status,
        record.exitCode,
        record.stdout,
        record.stderr,
        record.startedAt,
        record.completedAt
      );
    return this.get(record.gateRunId)!;
  }

  get(gateRunId: string): RuntimeGateRunRecord | null {
    return hydrateGateRun(
      this.db.prepare(`${GATE_RUN_SELECT} WHERE gate_run_id = ?`).get(gateRunId) as RuntimeGateRunRow | undefined
    );
  }

  list(filter: { workItemId?: string; sessionId?: string; limit?: number } = {}): RuntimeGateRunRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.workItemId) {
      clauses.push('work_item_id = ?');
      params.push(filter.workItemId);
    }
    if (filter.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, filter.limit ?? 200);
    return mapRows<RuntimeGateRunRow>(
      this.db.prepare(`${GATE_RUN_SELECT}${where} ORDER BY started_at DESC LIMIT ?`).all(...params, limit)
    )
      .map((row) => hydrateGateRun(row)!)
      .filter((row): row is RuntimeGateRunRecord => row !== null);
  }
}
