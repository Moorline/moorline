import type { RuntimeEnvironmentVerifier, RuntimeProviderFactory } from '../../types/provider.js';
import { homeRootForRuntime, type MoorlineConfig } from '../../types/config.js';
import { resolveMoorlineAssetRoot, ensureRuntimeLayout } from '../../core/runtime/hosting/runtimeLayout.js';
import { GitHistoryService } from '../../core/system/vcs/gitHistoryService.js';
import type { CommandRunner } from '../../core/shared/utils/commandRunner.js';
import { loadConfiguredProviderPackage } from './providerPackageLoader.js';
import { loadConfiguredTransportPackage } from './transportPackageLoader.js';
import type { RuntimeTransport } from '../../types/transport.js';

function selectedSurfaceConfig(config: MoorlineConfig, surface: 'transport' | 'provider'): Record<string, unknown> {
  const selection = config.surfaces[surface];
  return {
    ...selection.config,
    ...(selection.activePackageId ? selection.configByPackageId?.[selection.activePackageId] ?? {} : {})
  };
}

export async function loadConfiguredRuntimePackages(input: {
  config: MoorlineConfig;
  commandRunner?: CommandRunner;
}): Promise<{
  transport: RuntimeTransport;
  providerFactory: RuntimeProviderFactory;
  verifyEnvironment: RuntimeEnvironmentVerifier | null;
}> {
  await ensureRuntimeLayout({
    runtimeRoot: input.config.runtimeRoot,
    assetRoot: resolveMoorlineAssetRoot(import.meta.url)
  });
  await new GitHistoryService().ensureInitialized(homeRootForRuntime(input.config.runtimeRoot));

  const [transportPackage, providerPackage] = await Promise.all([
    loadConfiguredTransportPackage({
      runtimeRoot: input.config.runtimeRoot,
      config: input.config,
      commandRunner: input.commandRunner
    }),
    loadConfiguredProviderPackage({
      runtimeRoot: input.config.runtimeRoot,
      config: input.config,
      commandRunner: input.commandRunner
    })
  ]);

  return {
    transport: transportPackage.createTransport({
      config: selectedSurfaceConfig(input.config, 'transport'),
      commandRunner: input.commandRunner
    }),
    providerFactory: providerPackage.createProviderFactory({
      config: selectedSurfaceConfig(input.config, 'provider'),
      commandRunner: input.commandRunner
    }) as RuntimeProviderFactory,
    verifyEnvironment:
      providerPackage.createEnvironmentVerifier?.({
        config: selectedSurfaceConfig(input.config, 'provider'),
        commandRunner: input.commandRunner
      }) ?? null
  };
}
