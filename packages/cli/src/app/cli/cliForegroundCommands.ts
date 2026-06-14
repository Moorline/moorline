import { evaluateRuntimeStartability } from '@moorline/core/core/extension/packages/runtimeStartability.js';
import { MoorlineRuntime } from '@moorline/core/core/runtime/moorlineRuntime.js';
import { createWorkerControlBridge } from '@moorline/core/core/runtime/supervision/runtimeSupervisor.js';
import { loadMoorlineConfig, resolveConfigPath } from '@moorline/core/core/system/config/configStore.js';
import { detectSqliteRuntimeSupport } from '@moorline/core/core/system/state/sqliteSupport.js';
import { defaultHttpApiAdapterConfig, selectedApiAdapterPackageConfig } from '@moorline/core/types/config.js';
import { OperatorPackageService } from '@moorline/core/app/bootstrap/operatorPackageService.js';
import { loadConfiguredApiAdapterPackage } from '@moorline/core/app/bootstrap/apiAdapterPackageLoader.js';
import { loadConfiguredRuntimePackages } from '@moorline/core/app/bootstrap/runtimeBootstrap.js';
import { clearControlApiBootstrapRecord, writeControlApiBootstrapRecord } from '@moorline/control-api/bootstrap.js';
import type { RuntimeApiAdapterPackage } from '@moorline/contracts';
import type { CliDeps } from './cli.js';
import type { CliCommand } from './cliCommands.js';

function sqliteRuntimeGuidance(detail: string): string {
  const bunHint =
    typeof process.versions.bun === 'string'
      ? ' Run Node-backed commands via `bun run moorline <command>` or `node packages/cli/dist/main.js <command>`.'
      : '';
  return `Moorline requires node:sqlite support for runtime workers. ${detail}.${bunHint}`;
}

function selectedApiAdapterHostPort(config: ReturnType<typeof loadMoorlineConfig>, packageId: string): { host: string; port: number } {
  const rawConfig = selectedApiAdapterPackageConfig(config, packageId);
  return {
    host: typeof rawConfig.host === 'string' && rawConfig.host.trim().length > 0 ? rawConfig.host.trim() : defaultHttpApiAdapterConfig().host,
    port: Number.isInteger(rawConfig.port) && typeof rawConfig.port === 'number' ? rawConfig.port : 0
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function waitForEndpointClosed(url: string): Promise<void> {
  const endpoint = url.replace(/\/+$/u, '');
  while (true) {
    await sleep(250);
    try {
      const response = await fetch(`${endpoint}/`);
      await response.arrayBuffer().catch(() => undefined);
    } catch {
      return;
    }
  }
}

async function loadSelectedApiAdapterPackage(input: {
  config: ReturnType<typeof loadMoorlineConfig>;
  context: Parameters<RuntimeApiAdapterPackage['createAdapter']>[0];
}): Promise<RuntimeApiAdapterPackage> {
  const selectedPackageId = input.config.surfaces.apiAdapter.activePackageId;
  if (!selectedPackageId) {
    throw new Error('No API adapter package is selected. Run `moorline configure` to select an API adapter.');
  }
  return await loadConfiguredApiAdapterPackage({
    config: input.config,
    context: input.context
  });
}

export async function runApiForeground(command: Extract<CliCommand, { kind: 'api-run-foreground' }>, deps: CliDeps): Promise<number> {
  const configPath = resolveConfigPath(command.configPath);
  const config = loadMoorlineConfig(configPath);
  const adapterPackageId = config.surfaces.apiAdapter.activePackageId;
  if (!adapterPackageId) {
    throw new Error('No API adapter package is selected. Run `moorline configure` to select an API adapter.');
  }
  const api = selectedApiAdapterHostPort(config, adapterPackageId);
  const adapterContext = {
    host: api.host,
    port: api.port,
    configPath,
    entrypoint: process.argv[1]!,
    config: selectedApiAdapterPackageConfig(config, adapterPackageId)
  };
  const adapterPackage = await loadSelectedApiAdapterPackage({
    config,
    context: adapterContext
  });
  const adapter = adapterPackage.createAdapter(adapterContext);
  let adapterStarted = false;
  try {
    const started = await adapter.start();
    adapterStarted = true;
    const httpEndpoint = started.endpoints.find((endpoint) => endpoint.protocol === 'http');
    if (!httpEndpoint) {
      await adapter.stop();
      adapterStarted = false;
      clearControlApiBootstrapRecord(configPath);
      deps.output.write(`Moorline API adapter ${adapterPackage.manifest.id} did not expose an HTTP endpoint.`);
      return 1;
    }
    if (!httpEndpoint.token) {
      await adapter.stop();
      adapterStarted = false;
      clearControlApiBootstrapRecord(configPath);
      throw new Error(`Moorline API adapter ${adapterPackage.manifest.id} exposed HTTP without a bearer token.`);
    }
    writeControlApiBootstrapRecord({
      version: 1,
      protocol: 'http',
      adapterPackageId: adapterPackage.manifest.id,
      pid: process.pid,
      url: httpEndpoint.url,
      token: httpEndpoint.token,
      startedAt: new Date().toISOString(),
      configPath
    });
    deps.output.write(`Moorline Control API: ${httpEndpoint.url}`);
    deps.output.write(`Moorline Control API token: ${httpEndpoint.token}`);
    deps.output.write('Use moorline ops/configure/history/requests/main commands against this API.');
    if (deps.waitForShutdown) {
      await Promise.race([
        deps.waitForShutdown(),
        waitForEndpointClosed(httpEndpoint.url)
      ]);
      await adapter.stop();
      adapterStarted = false;
    }
  } catch (error) {
    if (adapterStarted) {
      await adapter.stop();
      adapterStarted = false;
    }
    clearControlApiBootstrapRecord(configPath);
    throw error;
  } finally {
    clearControlApiBootstrapRecord(configPath);
  }
  return 0;
}

export async function runRuntimeWorker(command: Extract<CliCommand, { kind: 'worker-run' }>, deps: CliDeps): Promise<number> {
  const configPath = resolveConfigPath(command.configPath);
  const config = loadMoorlineConfig(configPath);
  const startability = evaluateRuntimeStartability(config, new OperatorPackageService(config, configPath).getInventory());
  const sqliteSupport = await detectSqliteRuntimeSupport();
  if (!sqliteSupport.ok) {
    throw new Error(sqliteRuntimeGuidance(sqliteSupport.detail));
  }
  if (!startability.startable || !config.transport || !config.provider) {
    throw new Error(
      `Moorline worker-run requires startable selected packages. ${startability.issues.join(' | ') || 'Run moorline configure package ... and moorline configure apply first.'}`
    );
  }
  const runtimePackages = await loadConfiguredRuntimePackages({
    config,
    commandRunner: deps.commandRunner
  });
  const controlBridge = createWorkerControlBridge();
  const runtime = new MoorlineRuntime({
    config,
    configPath,
    commandRunner: deps.commandRunner,
    providerFactory: runtimePackages.providerFactory,
    verifyEnvironment: runtimePackages.verifyEnvironment ?? undefined,
    transport: runtimePackages.transport,
    supervised: typeof process.send === 'function',
    requestControl: controlBridge.requestControl
  });

  controlBridge.attachControlHandler(async (input) => await runtime.executeSupervisorControl(input));
  controlBridge.attachShutdownHandler(async ({ mode, timeoutMs }) => {
    await runtime.shutdownForSupervisor(mode, timeoutMs);
    process.exit(0);
  });

  try {
    await runtime.start();
    process.send?.({
      type: 'worker.management.ready',
      url: null,
      accessUrl: null
    });
    process.send?.({ type: 'worker.lifecycle.ready' });
  } catch (error) {
    process.send?.({
      type: 'worker.lifecycle.start_failed',
      detail: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }

  if (deps.waitForShutdown) {
    await deps.waitForShutdown();
    await runtime.stop();
  }

  return 0;
}
