import type { DatabaseSync } from 'node:sqlite';

export interface RuntimeHistoryPruneInput {
  nowIso: string;
  runtimeEventTtlMs?: number;
  domainEventTtlMs?: number;
  resolvedRequestTtlMs?: number;
  orchestrationTtlMs?: number;
  maxRuntimeEvents?: number;
  maxDomainEvents?: number;
  maxResolvedRequests?: number;
  maxClosedOrchestrationRequests?: number;
}

export interface RuntimeHistoryPruneResult {
  runtimeEventsDeleted: number;
  domainEventsDeleted: number;
  resolvedRequestsDeleted: number;
  closedOrchestrationRequestsDeleted: number;
}

export class RuntimeHistoryPruningRepository {
  constructor(private readonly db: DatabaseSync) {}

  pruneRuntimeHistory(input: RuntimeHistoryPruneInput): RuntimeHistoryPruneResult {
    const nowMs = Date.parse(input.nowIso);
    const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const toIso = (ageMs: number): string => new Date(safeNowMs - ageMs).toISOString();
    const runtimeEventCutoff = toIso(input.runtimeEventTtlMs ?? 14 * 24 * 60 * 60 * 1000);
    const domainEventCutoff = toIso(input.domainEventTtlMs ?? 14 * 24 * 60 * 60 * 1000);
    const resolvedRequestCutoff = toIso(input.resolvedRequestTtlMs ?? 14 * 24 * 60 * 60 * 1000);
    const orchestrationCutoff = toIso(input.orchestrationTtlMs ?? 14 * 24 * 60 * 60 * 1000);

    const runtimeEventsByTtl = this.db.prepare(`DELETE FROM runtime_events WHERE created_at < ?`).run(runtimeEventCutoff) as { changes?: number };
    const runtimeEventsByCount = this.db
      .prepare(`
        DELETE FROM runtime_events
        WHERE event_id IN (
          SELECT event_id
          FROM runtime_events
          ORDER BY created_at DESC, event_id DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(input.maxRuntimeEvents ?? 20_000) as { changes?: number };

    const domainEventsByTtl = this.db.prepare(`DELETE FROM domain_events WHERE created_at < ?`).run(domainEventCutoff) as { changes?: number };
    const domainEventsByCount = this.db
      .prepare(`
        DELETE FROM domain_events
        WHERE event_id IN (
          SELECT event_id
          FROM domain_events
          ORDER BY created_at DESC, event_id DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(input.maxDomainEvents ?? 20_000) as { changes?: number };

    const resolvedRequestsByTtl = this.db
      .prepare(`
        DELETE FROM pending_runtime_requests
        WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ?
      `)
      .run(resolvedRequestCutoff) as { changes?: number };
    const resolvedRequestsByCount = this.db
      .prepare(`
        DELETE FROM pending_runtime_requests
        WHERE request_id IN (
          SELECT request_id
          FROM pending_runtime_requests
          WHERE status = 'resolved'
          ORDER BY COALESCE(resolved_at, created_at) DESC, request_id DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(input.maxResolvedRequests ?? 5_000) as { changes?: number };

    const closedOrchestrationByTtl = this.db
      .prepare(`
        DELETE FROM runtime_orchestration_requests
        WHERE status IN ('completed', 'failed') AND updated_at < ?
      `)
      .run(orchestrationCutoff) as { changes?: number };
    const closedOrchestrationByCount = this.db
      .prepare(`
        DELETE FROM runtime_orchestration_requests
        WHERE request_id IN (
          SELECT request_id
          FROM runtime_orchestration_requests
          WHERE status IN ('completed', 'failed')
          ORDER BY updated_at DESC, request_id DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(input.maxClosedOrchestrationRequests ?? 5_000) as { changes?: number };

    return {
      runtimeEventsDeleted: (runtimeEventsByTtl.changes ?? 0) + (runtimeEventsByCount.changes ?? 0),
      domainEventsDeleted: (domainEventsByTtl.changes ?? 0) + (domainEventsByCount.changes ?? 0),
      resolvedRequestsDeleted: (resolvedRequestsByTtl.changes ?? 0) + (resolvedRequestsByCount.changes ?? 0),
      closedOrchestrationRequestsDeleted:
        (closedOrchestrationByTtl.changes ?? 0) + (closedOrchestrationByCount.changes ?? 0)
    };
  }
}
