export type HistoryEntryKind = 'checkpoint' | 'snapshot' | 'external';

export interface TrackedSurfaceTarget {
  path: string;
}

export interface HistoryEntry {
  commitId: string;
  shortCommitId: string;
  kind: HistoryEntryKind;
  title: string;
  createdAt: string;
  actor: string | null;
  reason: string | null;
  operation: string | null;
  targets: TrackedSurfaceTarget[];
}

export interface HistoryStatus {
  gitAvailable: boolean;
  repoInitialized: boolean;
  homeRoot: string;
  branch: string | null;
  dirtyPaths: string[];
  lastEntry: HistoryEntry | null;
}

export interface HistoryRestoreRequest {
  homeRoot: string;
  commitish: string;
  actor: string;
  reason?: string;
  paths?: string[];
}

export interface HistoryDiffRequest {
  homeRoot: string;
  from?: string;
  to?: string;
  path?: string;
}

export interface TrackedMutationDescriptor {
  homeRoot: string;
  actor: string;
  reason: string;
  operation: string;
  targets: string[];
}
