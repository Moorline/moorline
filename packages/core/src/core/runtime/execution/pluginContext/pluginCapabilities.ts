import { join } from 'node:path';
import type { SkillRegistry } from '../../../extension/skills/skillRegistry.js';
import { writeSkill } from '../../../extension/skills/skillWriter.js';
import { recordHistoryCheckpoint } from '../../../system/vcs/gitCheckpointService.js';
import type { RuntimePluginAdminConfig, RuntimePluginContext } from '../../../../types/plugin.js';

type GuardedAction = <T>(input: {
  action: string;
  actor: string;
  target: string;
  title: string;
  execute: () => Promise<T> | T;
}) => Promise<T>;

export class PluginAdminCapability {
  constructor(private readonly getConfig: () => RuntimePluginAdminConfig) {}

  getAdminConfig(): RuntimePluginAdminConfig {
    return this.getConfig();
  }
}

export class PluginMemoryCapability {
  constructor(
    private readonly input: {
      actorId: string;
      homeRoot: string;
      runtimeRoot: string;
      skillRegistry: SkillRegistry;
      runGuardedAction: GuardedAction;
    }
  ) {}

  listSkills(): ReturnType<SkillRegistry['list']> {
    return this.input.skillRegistry.list();
  }

  loadSkill(name: string): ReturnType<RuntimePluginContext['loadSkill']> {
    return this.input.runGuardedAction({
      action: 'fs.read',
      actor: this.input.actorId,
      target: `skill:${name}`,
      title: 'Skill read blocked',
      execute: async () => await this.input.skillRegistry.load(name)
    });
  }

  writeSkill(input: Parameters<RuntimePluginContext['writeSkill']>[0]): ReturnType<RuntimePluginContext['writeSkill']> {
    return this.input.runGuardedAction({
      action: 'fs.write',
      actor: this.input.actorId,
      target: `skill:${input.directoryName ?? input.name}`,
      title: 'Skill write blocked',
      execute: () => {
        const written = writeSkill({
          rootDir: join(this.input.runtimeRoot, 'packages', 'skills'),
          name: input.name,
          description: input.description,
          tags: input.tags,
          body: input.body,
          directoryName: input.directoryName,
          resourceFiles: input.resourceFiles
        });
        this.input.skillRegistry.invalidateCache();
        recordHistoryCheckpoint({
          homeRoot: this.input.homeRoot,
          actor: this.input.actorId,
          reason: `Updated skill ${input.name}.`,
          operation: `write skill ${input.directoryName ?? input.name}`,
          absoluteTargets: [written.skillDir]
        });
        return written;
      }
    });
  }

}

class ActorScopedCapability {
  constructor(readonly actorId: string) {}
}

export class PluginSessionCapability extends ActorScopedCapability {}
export class PluginObservabilityCapability extends ActorScopedCapability {}
export class PluginSidecarCapability extends ActorScopedCapability {}
