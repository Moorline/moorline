import type {
  ManagedSidecarDefinition,
  ManagedSidecarRecord,
  SidecarReadinessProbe
} from './managedSidecar.js';

export function normalizeReadinessProbe(probe: SidecarReadinessProbe | undefined): SidecarReadinessProbe {
  if (!probe) {
    return { kind: 'none' };
  }
  if (probe.kind === 'stdio') {
    return {
      kind: 'stdio',
      pattern: probe.pattern,
      stream: probe.stream ?? 'stdout',
      timeoutMs: probe.timeoutMs ?? 15_000
    };
  }
  return { kind: 'none' };
}

export function isSameLaunchDefinition(current: ManagedSidecarRecord, next: ManagedSidecarDefinition, cwd: string): boolean {
  return (
    current.command === next.launch.command &&
    JSON.stringify(current.args) === JSON.stringify(next.launch.args ?? []) &&
    current.cwd === cwd &&
    JSON.stringify(current.env) === JSON.stringify(next.launch.env ?? {}) &&
    current.restartPolicy === (next.launch.restart?.policy ?? 'never') &&
    current.maxRestarts === (next.launch.restart?.maxRestarts ?? 0) &&
    JSON.stringify(current.readiness) === JSON.stringify(normalizeReadinessProbe(next.launch.readiness))
  );
}
