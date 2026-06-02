import type { DatabaseSync } from 'node:sqlite';
import type { ManagedSidecarRecord, SidecarScopeKind } from '../../runtime/supervision/managedSidecar.js';
import { openRuntimeSqliteDatabase } from './sqlite/connection.js';
import { DomainEventLogRepository } from './sqlite/domainEventLogRepository.js';
import { ExternalResourceRepository } from './sqlite/externalResourceRepository.js';
import { GateRunRepository } from './sqlite/gateRunRepository.js';
import { ManagedSidecarRepository } from './sqlite/managedSidecarRepository.js';
import { RuntimeOrchestrationRepository } from './sqlite/orchestrationRepository.js';
import { PackageJobRepository } from './sqlite/packageJobRepository.js';
import { PackageStateRepository } from './sqlite/packageStateRepository.js';
import { PendingRequestRepository } from './sqlite/pendingRequestRepository.js';
import { ProviderBindingRepository } from './sqlite/providerBindingRepository.js';
import { ProviderEventLogRepository } from './sqlite/providerEventLogRepository.js';
import type { EventPersistenceResult } from './sqlite/eventIntegrity.js';
import { RuntimeHistoryPruningRepository, type RuntimeHistoryPruneInput, type RuntimeHistoryPruneResult } from './sqlite/runtimeHistoryPruningRepository.js';
import { RuntimeReceiptRepository } from './sqlite/runtimeReceiptRepository.js';
import { SessionRepository } from './sqlite/sessionRepository.js';
import { SessionMetadataRepository } from './sqlite/sessionMetadataRepository.js';
import { WorkItemRepository } from './sqlite/workItemRepository.js';
import type {
  RuntimeExternalResourceRecord,
  RuntimeExternalResourceRef,
  RuntimeGateRunRecord,
  RuntimeWorkItemRecord,
  RuntimeWorkItemStatus
} from '../../../types/external.js';
import {
  type DomainEventRow,
  type PendingRuntimeRequestRecord,
  type ProviderBindingRecord,
  type ProviderRuntimeEvent,
  type RuntimeDomainEvent,
  type RuntimeEventRow,
  type RuntimeOrchestrationRequestRow,
  type RuntimePackageJobRow,
  type RuntimePackageStateRow,
  type RuntimeReceiptRecord,
  type RuntimeSessionRow
} from './sqlite/types.js';

export type {
  RuntimeOrchestrationRequestRow,
  RuntimeOrchestrationRequestType,
  RuntimePackageJobRow,
  RuntimeSessionRow
} from './sqlite/types.js';

export class SqliteSessionStore {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly domainEvents: DomainEventLogRepository;
  private readonly externalResources: ExternalResourceRepository;
  private readonly gateRuns: GateRunRepository;
  private readonly historyPruning: RuntimeHistoryPruningRepository;
  private readonly managedSidecars: ManagedSidecarRepository;
  private readonly metadata: SessionMetadataRepository;
  private readonly orchestration: RuntimeOrchestrationRepository;
  private readonly packageJobs: PackageJobRepository;
  private readonly packageState: PackageStateRepository;
  private readonly pendingRequests: PendingRequestRepository;
  private readonly providerBindings: ProviderBindingRepository;
  private readonly providerEvents: ProviderEventLogRepository;
  private readonly runtimeReceipts: RuntimeReceiptRepository;
  private readonly sessions: SessionRepository;
  private readonly workItems: WorkItemRepository;

  constructor(pathOrDb: string | DatabaseSync) {
    if (typeof pathOrDb === 'string') {
      this.db = openRuntimeSqliteDatabase(pathOrDb);
      this.ownsDb = true;
    } else {
      this.db = pathOrDb;
      this.ownsDb = false;
    }
    this.domainEvents = new DomainEventLogRepository(this.db);
    this.externalResources = new ExternalResourceRepository(this.db);
    this.gateRuns = new GateRunRepository(this.db);
    this.historyPruning = new RuntimeHistoryPruningRepository(this.db);
    this.managedSidecars = new ManagedSidecarRepository(this.db);
    this.metadata = new SessionMetadataRepository(this.db);
    this.orchestration = new RuntimeOrchestrationRepository(this.db);
    this.packageJobs = new PackageJobRepository(this.db);
    this.packageState = new PackageStateRepository(this.db);
    this.pendingRequests = new PendingRequestRepository(this.db);
    this.providerBindings = new ProviderBindingRepository(this.db);
    this.providerEvents = new ProviderEventLogRepository(this.db);
    this.runtimeReceipts = new RuntimeReceiptRepository(this.db);
    this.sessions = new SessionRepository(this.db);
    this.workItems = new WorkItemRepository(this.db);
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

  getSessionByTransportResourceId(transportResourceId: string | null | undefined): RuntimeSessionRow | null {
    return this.sessions.getSessionByTransportResourceId(transportResourceId);
  }

  getSessionByThreadId(threadId: string): RuntimeSessionRow | null {
    return this.sessions.getSessionByThreadId(threadId);
  }

  listSessions(): RuntimeSessionRow[] {
    return this.sessions.listSessions();
  }

  deleteSession(sessionId: string): void {
    this.sessions.deleteSession(sessionId);
  }

  getPackageState(packageId: string, key: string): RuntimePackageStateRow | null {
    return this.packageState.get(packageId, key);
  }

  listPackageState(packageId: string, prefix?: string): RuntimePackageStateRow[] {
    return this.packageState.list(packageId, prefix);
  }

  putPackageState(row: RuntimePackageStateRow): void {
    this.packageState.put(row);
  }

  deletePackageState(packageId: string, key: string): RuntimePackageStateRow | null {
    return this.packageState.delete(packageId, key);
  }

  upsertPackageJob(row: RuntimePackageJobRow): void {
    this.packageJobs.upsert(row);
  }

  getPackageJob(packageId: string, jobId: string): RuntimePackageJobRow | null {
    return this.packageJobs.get(packageId, jobId);
  }

  listPackageJobs(packageId: string): RuntimePackageJobRow[] {
    return this.packageJobs.list(packageId);
  }

  listDuePackageJobs(nowIso: string): RuntimePackageJobRow[] {
    return this.packageJobs.listDue(nowIso);
  }

  deletePackageJob(packageId: string, jobId: string): RuntimePackageJobRow | null {
    return this.packageJobs.delete(packageId, jobId);
  }

  upsertExternalResource(input: RuntimeExternalResourceRef & { state?: string; nowIso: string }): RuntimeExternalResourceRecord {
    return this.externalResources.upsert(input);
  }

  listExternalResources(filter?: { provider?: string; kind?: string; limit?: number }): RuntimeExternalResourceRecord[] {
    return this.externalResources.list(filter);
  }

  bindSessionToExternalResource(input: {
    sessionId: string;
    resource: RuntimeExternalResourceRef;
    relationship: string;
    nowIso: string;
  }): void {
    this.externalResources.bindSession(input);
  }

  listExternalResourcesForSession(sessionId: string): RuntimeExternalResourceRecord[] {
    return this.externalResources.listResourcesForSession(sessionId);
  }

  listSessionIdsForExternalResource(resource: RuntimeExternalResourceRef): string[] {
    return this.externalResources.listSessionBindingsForResource(resource).map((row) => row.sessionId);
  }

  updateWorkItem(record: RuntimeWorkItemRecord): RuntimeWorkItemRecord {
    return this.workItems.update(record);
  }

  enqueueWorkItem(record: RuntimeWorkItemRecord): RuntimeWorkItemRecord {
    return this.workItems.enqueue(record);
  }

  getWorkItem(workItemId: string): RuntimeWorkItemRecord | null {
    return this.workItems.get(workItemId);
  }

  listWorkItems(filter?: {
    packageId?: string;
    queue?: string;
    status?: RuntimeWorkItemStatus;
    externalResource?: RuntimeExternalResourceRef;
    limit?: number;
  }): RuntimeWorkItemRecord[] {
    return this.workItems.list(filter);
  }

  claimWorkItem(input: {
    packageId: string;
    queue: string;
    leaseOwner: string;
    leaseExpiresAt: string;
    nowIso: string;
  }): RuntimeWorkItemRecord | null {
    return this.workItems.claim(input);
  }

  upsertGateRun(record: RuntimeGateRunRecord): RuntimeGateRunRecord {
    return this.gateRuns.upsert(record);
  }

  getGateRun(gateRunId: string): RuntimeGateRunRecord | null {
    return this.gateRuns.get(gateRunId);
  }

  listGateRuns(filter?: { workItemId?: string; sessionId?: string; limit?: number }): RuntimeGateRunRecord[] {
    return this.gateRuns.list(filter);
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

  appendRuntimeEvent(event: ProviderRuntimeEvent, transportResourceId: string | null): EventPersistenceResult {
    return this.providerEvents.appendRuntimeEvent(event, transportResourceId);
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

  listPendingRequestsByTransportResource(transportResourceId: string | null | undefined): PendingRuntimeRequestRecord[] {
    return this.pendingRequests.listPendingRequestsByTransportResource(transportResourceId);
  }

  listOpenPendingRequests(): PendingRuntimeRequestRecord[] {
    return this.pendingRequests.listOpenPendingRequests();
  }

  listOpenPendingRequestsByTransportResource(transportResourceId: string | null | undefined): PendingRuntimeRequestRecord[] {
    return this.pendingRequests.listOpenPendingRequestsByTransportResource(transportResourceId);
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
