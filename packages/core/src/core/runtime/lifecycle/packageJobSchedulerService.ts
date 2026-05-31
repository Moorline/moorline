import type { RuntimeActorIdentity } from '../../../types/transport.js';
import type { PluginHost } from '../../extension/plugins/pluginHost.js';
import type { SqliteSessionStore, RuntimePackageJobRow } from '../../system/state/sqliteSessionStore.js';
import type { RuntimePluginContext } from '../../../types/plugin.js';
import {
  computeNextPackageJobRunAtWithMeta,
  parsePackageScheduleMeta
} from '../../shared/scheduling/packageSchedule.js';

interface PackageJobSchedulerServiceDeps {
  store: SqliteSessionStore;
  getPluginHost(): PluginHost;
  createPluginContext(actorId: string): RuntimePluginContext;
  queue<T>(key: string, work: () => Promise<T>): Promise<T>;
  now(): string;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
}

function readPayload(row: RuntimePackageJobRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.payloadJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class PackageJobSchedulerService {
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(private readonly deps: PackageJobSchedulerServiceDeps) {}

  start(): void {
    this.stop();
    const tick = () => {
      void this.tick().catch((error: unknown) => {
        this.deps.appendAuditEvent('package_job.tick.failed', {
          error: error instanceof Error ? error.message : String(error),
          occurredAt: this.deps.now()
        });
      });
    };
    tick();
    this.timer = setInterval(tick, 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const nowIso = this.deps.now();
    for (const job of this.deps.store.listDuePackageJobs(nowIso)) {
      await this.deps.queue(`package-job:${job.packageId}:${job.jobId}`, async () => {
        const current = this.deps.store.getPackageJob(job.packageId, job.jobId);
        if (!current || !current.nextRunAt || Date.parse(current.nextRunAt) > Date.parse(this.deps.now())) {
          return;
        }
        const payload = readPayload(current);
        const actor: RuntimeActorIdentity = {
          actorId: 'runtime:package-job',
          displayName: 'Package Job'
        };
        try {
          await this.deps.getPluginHost().executeAction(
            current.actionId,
            {
              ...payload,
              jobId: current.jobId,
              scheduledAt: current.nextRunAt
            },
            {
              scopeId: 'runtime',
              actorId: actor.actorId,
              displayName: actor.displayName
            },
            (pluginId) => this.deps.createPluginContext(`plugin:${pluginId}`)
          );
          this.reschedule(current);
        } catch (error) {
          this.deps.appendAuditEvent('package_job.dispatch.failed', {
            packageId: current.packageId,
            jobId: current.jobId,
            actionId: current.actionId,
            error: error instanceof Error ? error.message : String(error),
            occurredAt: this.deps.now()
          });
          this.reschedule(current);
        }
      });
    }
  }

  private reschedule(job: RuntimePackageJobRow): void {
    const nowIso = this.deps.now();
    const nextRunAt = computeNextPackageJobRunAtWithMeta(
      job.scheduleAnchorAt,
      job.cadenceMinutes,
      job.nextRunAt ?? nowIso,
      parsePackageScheduleMeta(job.scheduleMetaJson)
    );
    this.deps.store.upsertPackageJob({
      ...job,
      nextRunAt,
      updatedAt: nowIso
    });
  }
}
