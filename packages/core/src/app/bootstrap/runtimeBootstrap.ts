import {
  DEFAULT_PROVIDER_TOOL_POLICY,
  type ProviderToolPolicyConfig,
  type RuntimeEnvironmentVerifier,
  type RuntimeProviderFactory,
  validateProviderToolPolicyConfig
} from '../../types/provider.js';
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

function resolveProviderToolPolicy(input: {
  manifestToolPolicy?: ProviderToolPolicyConfig;
  providerConfig: Record<string, unknown>;
}): ProviderToolPolicyConfig {
  const configuredPolicy = validateProviderToolPolicyConfig(
    input.providerConfig.toolPolicy,
    'provider config.toolPolicy'
  );
  return configuredPolicy ?? input.manifestToolPolicy ?? DEFAULT_PROVIDER_TOOL_POLICY;
}

export async function loadConfiguredRuntimePackages(input: {
  config: MoorlineConfig;
  commandRunner?: CommandRunner;
}): Promise<{
  transport: RuntimeTransport;
  providerFactory: RuntimeProviderFactory;
  providerToolPolicy: ProviderToolPolicyConfig;
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

  const transportConfig = selectedSurfaceConfig(input.config, 'transport');
  const providerConfig = selectedSurfaceConfig(input.config, 'provider');
  return {
    transport: transportPackage.createTransport({
      config: transportConfig,
      commandRunner: input.commandRunner
    }),
    providerFactory: providerPackage.createProviderFactory({
      config: providerConfig,
      commandRunner: input.commandRunner
    }) as RuntimeProviderFactory,
    providerToolPolicy: resolveProviderToolPolicy({
      manifestToolPolicy: providerPackage.manifest.toolPolicy,
      providerConfig
    }),
    verifyEnvironment:
      providerPackage.createEnvironmentVerifier?.({
        config: providerConfig,
        commandRunner: input.commandRunner
      }) ?? null
  };
}
