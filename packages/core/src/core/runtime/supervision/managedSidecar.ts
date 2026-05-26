export type SidecarScopeKind = 'global' | 'session' | 'ephemeral';

export type ManagedSidecarStatus = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export type SidecarRestartPolicy = 'never' | 'on-failure';

export type SidecarReadinessProbe =
  | {
      kind: 'none';
    }
  | {
      kind: 'stdio';
      pattern: string;
      stream?: 'stdout' | 'stderr' | 'both';
      timeoutMs?: number;
    };

export type ManagedSidecarScope =
  | {
      kind: 'global';
      key?: never;
    }
  | {
      kind: 'session';
      key: string;
    }
  | {
      kind: 'ephemeral';
      key: string;
    };

export interface ManagedSidecarLaunchSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  restart?: {
    policy?: SidecarRestartPolicy;
    maxRestarts?: number;
  };
  readiness?: SidecarReadinessProbe;
}

export interface ManagedSidecarDefinition {
  pluginId: string;
  name: string;
  scope: ManagedSidecarScope;
  launch: ManagedSidecarLaunchSpec;
}

export interface ManagedSidecarRecord {
  sidecarId: string;
  instanceId: string;
  pluginId: string;
  name: string;
  scopeKind: SidecarScopeKind;
  scopeKey: string;
  status: ManagedSidecarStatus;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  restartPolicy: SidecarRestartPolicy;
  maxRestarts: number;
  readiness: SidecarReadinessProbe;
  artifactDir: string;
  pid: number | null;
  restartCount: number;
  startedAt: string | null;
  readyAt: string | null;
  stoppedAt: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastError: string | null;
  updatedAt: string;
}

export function normalizeSidecarScopeKey(scope: ManagedSidecarScope): string {
  if (scope.kind === 'global') {
    return 'runtime';
  }
  if (!scope.key || !scope.key.trim()) {
    throw new Error(`Sidecar scope ${scope.kind} requires a non-empty key.`);
  }
  return scope.key.trim();
}

export function buildManagedSidecarId(input: {
  pluginId: string;
  name: string;
  scopeKind: SidecarScopeKind;
  scopeKey: string;
}): string {
  return `${input.pluginId}:${input.name}:${input.scopeKind}:${input.scopeKey}`;
}
