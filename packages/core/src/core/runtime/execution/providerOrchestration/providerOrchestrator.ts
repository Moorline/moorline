import type { RuntimeMessagePayload } from '../../../../types/transport.js';
import type { ProviderRuntimeEvent } from '../../../../types/runtime.js';
import type { RuntimeSessionRow } from '../../../system/state/sqliteSessionStore.js';
import type { ProviderConnectionStore } from '../providerProjectionTypes.js';
import type { RuntimeProvider } from '../../../../types/provider.js';
import type { ProviderCompactionPolicy } from './providerCompactionPolicy.js';
import type { ProviderEventPipeline } from './providerEventPipeline.js';
import type { ProviderSessionOrchestrator } from './providerSessionOrchestrator.js';
import type { ProviderTurnBroker, RuntimeProviderTurnInput } from './providerTurnBroker.js';

interface ProviderOrchestratorDeps {
  provider: RuntimeProvider;
  connections: ProviderConnectionStore;
  sessions: ProviderSessionOrchestrator;
  turns: ProviderTurnBroker;
  compaction: ProviderCompactionPolicy;
  events: ProviderEventPipeline;
}

export class ProviderOrchestrator {
  constructor(private readonly deps: ProviderOrchestratorDeps) {}

  providerAutoStartEnabled(session: RuntimeSessionRow): boolean {
    return this.deps.sessions.providerAutoStartEnabled(session);
  }

  setProviderAutoStartDefault(enabled: boolean): void {
    this.deps.sessions.setProviderAutoStartDefault(enabled);
  }

  providerStoppedReply(session: RuntimeSessionRow): string {
    return this.deps.sessions.providerStoppedReply(session);
  }

  async ensureSession(
    session: RuntimeSessionRow,
    actor: string,
    options: { persistSessionState?: boolean } = {}
  ): Promise<void> {
    await this.deps.sessions.ensureSession(session, actor, options);
  }

  refreshActiveSessionsForProviderDefault(): void {
    this.deps.sessions.refreshActiveSessionsForProviderDefault();
  }

  async runTurn(input: RuntimeProviderTurnInput): Promise<RuntimeMessagePayload> {
    return await this.deps.turns.runTurn(input);
  }

  teardownThread(threadId: string, reason: string): void {
    this.deps.compaction.clearLatch(threadId);
    this.deps.turns.clearThreadState(threadId);
    this.deps.provider.stopSession(threadId);
    this.deps.connections.delete(threadId);
    this.deps.turns.rejectThread(threadId, reason);
  }

  rejectThread(threadId: string, reason: string): void {
    this.deps.turns.rejectThread(threadId, reason);
  }

  rejectAll(reason: string): void {
    this.deps.turns.rejectAll(reason);
  }

  flushThread(threadId: string): void {
    this.deps.turns.flushThread(threadId);
  }

  clearRequestAttribution(): void {
    this.deps.turns.clearRequestAttribution();
  }

  clearCompactionLatches(): void {
    this.deps.compaction.clearAllLatches();
  }

  async handleProviderEvent(event: ProviderRuntimeEvent): Promise<void> {
    await this.deps.events.handleProviderEvent(event);
  }
}
