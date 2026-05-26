import type { DatabaseSync } from 'node:sqlite';
import type { ManagedSidecarRecord, SidecarScopeKind } from '../../runtime/supervision/managedSidecar.js';
import { openRuntimeSqliteDatabase } from './sqlite/connection.js';
import { DomainEventLogRepository } from './sqlite/domainEventLogRepository.js';
import { ManagedSidecarRepository } from './sqlite/managedSidecarRepository.js';
import { MissionRepository } from './sqlite/missionRepository.js';
import { RuntimeOrchestrationRepository } from './sqlite/orchestrationRepository.js';
import { PendingRequestRepository } from './sqlite/pendingRequestRepository.js';
import { ProviderBindingRepository } from './sqlite/providerBindingRepository.js';
import { ProviderEventLogRepository } from './sqlite/providerEventLogRepository.js';
import type { EventPersistenceResult } from './sqlite/eventIntegrity.js';
import { RuntimeHistoryPruningRepository, type RuntimeHistoryPruneInput, type RuntimeHistoryPruneResult } from './sqlite/runtimeHistoryPruningRepository.js';
import { RuntimeReceiptRepository } from './sqlite/runtimeReceiptRepository.js';
import { SessionRepository } from './sqlite/sessionRepository.js';
import { SessionMetadataRepository } from './sqlite/sessionMetadataRepository.js';
import {
  type DomainEventRow,
  type PendingRuntimeRequestRecord,
  type ProviderBindingRecord,
  type ProviderRuntimeEvent,
  type RuntimeDomainEvent,
  type RuntimeMissionHookBindingRow,
  type RuntimeEventRow,
  type RuntimeMissionRow,
  type RuntimeMissionRunRow,
  type RuntimeOrchestrationRequestRow,
  type RuntimeReceiptRecord,
  type RuntimeSessionRow
} from './sqlite/types.js';

export type {
  RuntimeMissionHookBindingRow,
  RuntimeMissionRow,
  RuntimeMissionRunRow,
  RuntimeOrchestrationRequestRow,
  RuntimeOrchestrationRequestType,
  RuntimeSessionRow
} from './sqlite/types.js';

export class SqliteSessionStore {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly domainEvents: DomainEventLogRepository;
  private readonly historyPruning: RuntimeHistoryPruningRepository;
  private readonly managedSidecars: ManagedSidecarRepository;
  private readonly metadata: SessionMetadataRepository;
  private readonly missions: MissionRepository;
  private readonly orchestration: RuntimeOrchestrationRepository;
  private readonly pendingRequests: PendingRequestRepository;
  private readonly providerBindings: ProviderBindingRepository;
  private readonly providerEvents: ProviderEventLogRepository;
  private readonly runtimeReceipts: RuntimeReceiptRepository;
  private readonly sessions: SessionRepository;

  constructor(pathOrDb: string | DatabaseSync) {
    if (typeof pathOrDb === 'string') {
      this.db = openRuntimeSqliteDatabase(pathOrDb);
      this.ownsDb = true;
    } else {
      this.db = pathOrDb;
      this.ownsDb = false;
    }
    this.domainEvents = new DomainEventLogRepository(this.db);
    this.historyPruning = new RuntimeHistoryPruningRepository(this.db);
    this.managedSidecars = new ManagedSidecarRepository(this.db);
    this.metadata = new SessionMetadataRepository(this.db);
    this.missions = new MissionRepository(this.db);
    this.orchestration = new RuntimeOrchestrationRepository(this.db);
    this.pendingRequests = new PendingRequestRepository(this.db);
    this.providerBindings = new ProviderBindingRepository(this.db);
    this.providerEvents = new ProviderEventLogRepository(this.db);
    this.runtimeReceipts = new RuntimeReceiptRepository(this.db);
    this.sessions = new SessionRepository(this.db);
  }

  database(): DatabaseSync {
    return this.db;
  }

  upsertSession(row: RuntimeSessionRow): void {
    this.sessions.upsertSession(row);
  }

  getSession(sessionId: string): RuntimeSessionRow | null {
    return this.sessions.getSession(sessionId);
  }

  getSessionBySpaceId(spaceId: string | null | undefined): RuntimeSessionRow | null {
    return this.sessions.getSessionBySpaceId(spaceId);
  }

  getSessionByThreadId(threadId: string): RuntimeSessionRow | null {
    return this.sessions.getSessionByThreadId(threadId);
  }

  listSessions(): RuntimeSessionRow[] {
    return this.sessions.listSessions();
  }

  upsertMission(row: RuntimeMissionRow): void {
    this.missions.upsertMission(row);
  }

  getMission(missionId: string): RuntimeMissionRow | null {
    return this.missions.getMission(missionId);
  }

  getMissionBySpaceId(spaceId: string | null | undefined): RuntimeMissionRow | null {
    return this.missions.getMissionBySpaceId(spaceId);
  }

  getMissionByThreadId(threadId: string): RuntimeMissionRow | null {
    return this.missions.getMissionByThreadId(threadId);
  }

  listMissions(): RuntimeMissionRow[] {
    return this.missions.listMissions();
  }

  deleteMission(missionId: string): void {
    this.missions.deleteMission(missionId);
  }

  upsertMissionRun(row: RuntimeMissionRunRow): void {
    this.missions.upsertMissionRun(row);
  }

  getMissionRun(runId: string): RuntimeMissionRunRow | null {
    return this.missions.getMissionRun(runId);
  }

  listMissionRuns(missionId: string, limit = 20): RuntimeMissionRunRow[] {
    return this.missions.listMissionRuns(missionId, limit);
  }

  getActiveMissionRun(missionId: string): RuntimeMissionRunRow | null {
    return this.missions.getActiveMissionRun(missionId);
  }

  upsertMissionHookBinding(row: RuntimeMissionHookBindingRow): void {
    this.missions.upsertMissionHookBinding(row);
  }

  getMissionHookBinding(bindingId: string): RuntimeMissionHookBindingRow | null {
    return this.missions.getMissionHookBinding(bindingId);
  }

  listMissionHookBindings(input?: { missionId?: string; hookKey?: string }): RuntimeMissionHookBindingRow[] {
    return this.missions.listMissionHookBindings(input);
  }

  deleteMissionHookBinding(bindingId: string): RuntimeMissionHookBindingRow | null {
    return this.missions.deleteMissionHookBinding(bindingId);
  }

  deleteSession(sessionId: string): void {
    this.sessions.deleteSession(sessionId);
  }

  upsertManagedSidecar(row: ManagedSidecarRecord): void {
    this.managedSidecars.upsertManagedSidecar(row);
  }

  getManagedSidecar(sidecarId: string): ManagedSidecarRecord | null {
    return this.managedSidecars.getManagedSidecar(sidecarId);
  }

  listManagedSidecars(): ManagedSidecarRecord[] {
    return this.managedSidecars.listManagedSidecars();
  }

  listManagedSidecarsByScope(scopeKind: SidecarScopeKind, scopeKey: string): ManagedSidecarRecord[] {
    return this.managedSidecars.listManagedSidecarsByScope(scopeKind, scopeKey);
  }

  upsertOrchestrationRequest(row: RuntimeOrchestrationRequestRow): void {
    this.orchestration.upsertOrchestrationRequest(row);
  }

  claimPendingOrchestrationRequest(input: {
    requestId: string;
    executionOwner: string;
    nowIso: string;
  }): RuntimeOrchestrationRequestRow | null {
    return this.orchestration.claimPendingOrchestrationRequest(input);
  }

  failAbandonedRunningOrchestrationRequests(input: {
    executionOwner: string;
    nowIso: string;
    error: string;
  }): number {
    return this.orchestration.failAbandonedRunningOrchestrationRequests(input);
  }

  getOrchestrationRequest(requestId: string): RuntimeOrchestrationRequestRow | null {
    return this.orchestration.getOrchestrationRequest(requestId);
  }

  getLatestOrchestrationRequestByDedupeKey(dedupeKey: string): RuntimeOrchestrationRequestRow | null {
    return this.orchestration.getLatestOrchestrationRequestByDedupeKey(dedupeKey);
  }

  listOpenOrchestrationRequests(): RuntimeOrchestrationRequestRow[] {
    return this.orchestration.listOpenOrchestrationRequests();
  }

  appendRuntimeEvent(event: ProviderRuntimeEvent, spaceId: string | null): EventPersistenceResult {
    return this.providerEvents.appendRuntimeEvent(event, spaceId);
  }

  listRuntimeEvents(threadId: string): RuntimeEventRow[] {
    return this.providerEvents.listRuntimeEvents(threadId);
  }

  appendDomainEvent(event: RuntimeDomainEvent): EventPersistenceResult {
    return this.domainEvents.appendDomainEvent(event);
  }

  listDomainEvents(threadId: string): DomainEventRow[] {
    return this.domainEvents.listDomainEvents(threadId);
  }

  upsertPendingRequest(row: PendingRuntimeRequestRecord): void {
    this.pendingRequests.upsertPendingRequest(row);
  }

  getPendingRequest(requestId: string): PendingRuntimeRequestRecord | null {
    return this.pendingRequests.getPendingRequest(requestId);
  }

  listPendingRequestsBySpace(spaceId: string | null | undefined): PendingRuntimeRequestRecord[] {
    return this.pendingRequests.listPendingRequestsBySpace(spaceId);
  }

  listOpenPendingRequests(): PendingRuntimeRequestRecord[] {
    return this.pendingRequests.listOpenPendingRequests();
  }

  listOpenPendingRequestsBySpace(spaceId: string | null | undefined): PendingRuntimeRequestRecord[] {
    return this.pendingRequests.listOpenPendingRequestsBySpace(spaceId);
  }

  listOpenPendingRequestsByThread(threadId: string | null | undefined): PendingRuntimeRequestRecord[] {
    return this.pendingRequests.listOpenPendingRequestsByThread(threadId);
  }

  deletePendingRequest(requestId: string): void {
    this.pendingRequests.deletePendingRequest(requestId);
  }

  putMetadata(key: string, value: unknown, updatedAt: string): void {
    this.metadata.putMetadata(key, value, updatedAt);
  }

  getMetadata<T>(key: string): T | null {
    return this.metadata.getMetadata<T>(key);
  }

  upsertProviderBinding(row: ProviderBindingRecord): void {
    this.providerBindings.upsertProviderBinding(row);
  }

  getProviderBinding(threadId: string): ProviderBindingRecord | null {
    return this.providerBindings.getProviderBinding(threadId);
  }

  listProviderBindings(): ProviderBindingRecord[] {
    return this.providerBindings.listProviderBindings();
  }

  deleteProviderBinding(threadId: string): void {
    this.providerBindings.deleteProviderBinding(threadId);
  }

  upsertRuntimeReceipt(row: RuntimeReceiptRecord): void {
    this.runtimeReceipts.upsertRuntimeReceipt(row);
  }

  getRuntimeReceipt(threadId: string): RuntimeReceiptRecord | null {
    return this.runtimeReceipts.getRuntimeReceipt(threadId);
  }

  listRuntimeReceipts(): RuntimeReceiptRecord[] {
    return this.runtimeReceipts.listRuntimeReceipts();
  }

  pruneRuntimeHistory(input: RuntimeHistoryPruneInput): RuntimeHistoryPruneResult {
    return this.historyPruning.pruneRuntimeHistory(input);
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
