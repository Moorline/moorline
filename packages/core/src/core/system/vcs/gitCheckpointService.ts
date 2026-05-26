import { configPathUnderHome, toTrackedRelativeTargets } from './gitTrackedPaths.js';
import { GitHistoryService } from './gitHistoryService.js';

interface RecordHistoryCheckpointInput {
  homeRoot: string;
  actor: string;
  reason: string;
  operation: string;
  absoluteTargets?: string[];
  relativeTargets?: string[];
  configPath?: string;
}

export function recordHistoryCheckpoint(input: RecordHistoryCheckpointInput): void {
  const relativeTargets = new Set(input.relativeTargets ?? []);
  for (const target of input.absoluteTargets ?? []) {
    try {
      for (const relativeTarget of toTrackedRelativeTargets(input.homeRoot, [target])) {
        relativeTargets.add(relativeTarget);
      }
    } catch {
      continue;
    }
  }
  if (input.configPath) {
    const configTarget = configPathUnderHome(input.homeRoot, input.configPath);
    if (configTarget) {
      relativeTargets.add(configTarget);
    }
  }
  if (relativeTargets.size === 0) {
    return;
  }
  new GitHistoryService().createCheckpointSync({
    homeRoot: input.homeRoot,
    actor: input.actor,
    reason: input.reason,
    operation: input.operation,
    targets: [...relativeTargets]
  });
}
