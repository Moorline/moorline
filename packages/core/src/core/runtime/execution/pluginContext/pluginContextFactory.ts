import type { SkillRegistry } from '../../../extension/skills/skillRegistry.js';
import type { RuntimePluginAdminConfig } from '../../../../types/plugin.js';
import {
  PluginAdminCapability,
  PluginMemoryCapability,
  PluginObservabilityCapability,
  PluginSessionCapability,
  PluginSidecarCapability
} from './pluginCapabilities.js';

type GuardedAction = ConstructorParameters<typeof PluginMemoryCapability>[0]['runGuardedAction'];

export function createPluginContextCapabilities(input: {
  actorId: string;
  homeRoot: string;
  runtimeRoot: string;
  skillRegistry: SkillRegistry;
  getAdminConfig?: () => RuntimePluginAdminConfig;
  runGuardedAction: GuardedAction;
}) {
  return {
    admin: input.getAdminConfig ? new PluginAdminCapability(input.getAdminConfig) : null,
    memory: new PluginMemoryCapability({
      actorId: input.actorId,
      homeRoot: input.homeRoot,
      runtimeRoot: input.runtimeRoot,
      skillRegistry: input.skillRegistry,
      runGuardedAction: input.runGuardedAction
    }),
    sessions: new PluginSessionCapability(input.actorId),
    observability: new PluginObservabilityCapability(input.actorId),
    sidecars: new PluginSidecarCapability(input.actorId)
  };
}
