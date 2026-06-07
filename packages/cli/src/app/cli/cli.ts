import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcessRunner, CommandRunner } from '@moorline/core/core/shared/utils/commandRunner.js';
import { loadMoorlineConfig, resolveConfigPath, runtimePaths, saveMoorlineConfig } from '@moorline/core/core/system/config/configStore.js';
import {
  DEFAULT_MOORLINE_MODEL,
  defaultAdminConfig,
  defaultHttpApiAdapterConfig,
  defaultMainProcessConfig,
  defaultSurfaceNames,
  defaultMoorlineRuntimeRoot,
  type MoorlineConfig
} from '@moorline/core/types/config.js';
import { validateApiAdapterPackageManifest, type ApiAdapterPackageManifest } from '@moorline/contracts';
import { ApiBootstrapResolver, clearControlApiBootstrapRecord, readControlApiBootstrapRecord } from '@moorline/control-api/bootstrap.js';
import { parseCliArgs, type CliCommand, type ControlApiConnectionOptions } from './cliCommands.js';
import { OperatorPackageService } from '@moorline/core/app/bootstrap/operatorPackageService.js';
import { runApiForeground, runRuntimeWorker } from './cliForegroundCommands.js';

export interface OutputWriter {
  write(line: string): void;
}

interface PromptOption<T extends string> {
  label: string;
  value: T;
  description: string;
}

export interface PromptAdapter {
  input(
    label: string,
    description: string,
    fallback: string,
    validate?: (value: string) => string | null,
    options?: { sensitive?: boolean }
  ): Promise<string>;
  select<T extends string>(label: string, description: string, options: PromptOption<T>[], fallback: T): Promise<T>;
  confirm(label: string, description: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

export { parseCliArgs };

export interface CliDeps {
  prompt: PromptAdapter;
  output: OutputWriter;
  commandRunner: CommandRunner;
  waitForShutdown?: () => Promise<void>;
}

function renderJson(value: unknown, output: OutputWriter): void {
  output.write(JSON.stringify(value, null, 2));
}

function formatHuman(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') {
      return record.message;
    }
    if (typeof record.detail === 'string') {
      return record.detail;
    }
  }
  return JSON.stringify(value, null, 2);
}

function sourceLabel(entry: Record<string, unknown>): string {
  if (entry.registrySource === 'npm') {
    return 'npm';
  }
  if (entry.registrySource === 'local_cache') {
    return 'cached npm';
  }
  return 'unknown';
}

function renderPackageRows(value: unknown, output: OutputWriter): void {
  const entries = Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
  if (entries.length === 0) {
    output.write('No packages found.');
    return;
  }
  for (const entry of entries) {
    output.write(`${entry.packageId}  ${entry.kind}  ${entry.version ?? 'unknown'}  ${sourceLabel(entry)}`);
    if (typeof entry.description === 'string') {
      output.write(`  ${entry.description}`);
    }
  }
}

function renderPackageInfo(value: unknown, output: OutputWriter): void {
  if (!value || typeof value !== 'object') {
    output.write(formatHuman(value));
    return;
  }
  const entry = value as Record<string, unknown>;
  output.write(`${entry.packageId}`);
  output.write(`Name: ${entry.name ?? entry.packageId}`);
  output.write(`Kind: ${entry.kind}`);
  output.write(`Version: ${entry.version ?? 'unknown'}`);
  output.write(`Source: ${sourceLabel(entry)}`);
  if (entry.npm && typeof entry.npm === 'object') {
    const npm = entry.npm as Record<string, unknown>;
    output.write(`Package source: ${npm.packageName ?? 'unknown'}`);
  }
  if (typeof entry.description === 'string') {
    output.write('');
    output.write(entry.description);
  }
}

function renderHelp(output: OutputWriter): void {
  output.write('Moorline CLI');
  output.write('');
  output.write('Setup:');
  output.write('  moorline init [--config <path>]');
  output.write('');
  output.write('Control API:');
  output.write('  moorline run');
  output.write('  moorline api start');
  output.write('  moorline api stop [--url <url>] [--token <token>]');
  output.write('  moorline api status');
  output.write('  moorline api diagnostics-export [--url <url>] [--token <token>] [--json]');
  output.write('  moorline main <status|start|stop|restart> [--url <url>] [--token <token>] [--json]');
  output.write('');
  output.write('Operations:');
  output.write('  moorline ops state [--url <url>] [--token <token>] [--json]');
  output.write('  moorline ops accepting <on|off> [--url <url>] [--token <token>] [--json]');
  output.write('  moorline ops reload <graceful|force> [--url <url>] [--token <token>] [--json]');
  output.write('  moorline ops provider <start|stop> [--thread <id>] [--url <url>] [--token <token>] [--json]');
  output.write('  moorline ops session create ...');
  output.write('');
  output.write('Configure:');
  output.write('  moorline package <search|info|install> ...');
  output.write('  moorline configure state [--url <url>] [--token <token>] [--json]');
  output.write('  moorline configure apply [--url <url>] [--token <token>] [--json]');
  output.write('  moorline configure package <install|remove|activate|deactivate|config> ...');
  output.write('  moorline configure model <model-id> [--url <url>] [--token <token>] [--json]');
  output.write('  moorline configure setup-export [--out <file>] [--url <url>] [--token <token>] [--json]');
  output.write('  moorline configure backup [--include-workspaces] [--out <file>] [--url <url>] [--token <token>] [--json]');
  output.write('  moorline configure import <archive-path> [--force] [--url <url>] [--token <token>] [--json]');
  output.write('');
  output.write('History and Requests:');
  output.write('  moorline history <status|list|show|diff|snapshot|restore|discard> ...');
  output.write('  moorline requests <list|inspect|resolve|answer|cancel> ...');
  output.write('');
  output.write('Interactive wizard:');
  output.write('  moorline interactive [--url <url>] [--token <token>] [--json]');
}

function defaultRuntimeRootForConfig(configPath: string, explicitConfigPath?: string): string {
  if (!explicitConfigPath) {
    return defaultMoorlineRuntimeRoot();
  }
  const extension = extname(configPath);
  const stem = basename(configPath, extension);
  return resolve(dirname(configPath), `${stem}.runtime`);
}

function initialMoorlineConfig(configPath: string, explicitConfigPath?: string): MoorlineConfig {
  const surface = defaultSurfaceNames();
  return {
    version: 4,
    runtimeRoot: defaultRuntimeRootForConfig(configPath, explicitConfigPath),
    admin: defaultAdminConfig(),
    main: defaultMainProcessConfig(),
    defaults: {
      runtimeMode: 'full-access',
      model: DEFAULT_MOORLINE_MODEL
    },
    surface: surface,
    setup: {
      completed: false
    },
    surfaces: {
      apiAdapter: {
        activePackageId: null,
        config: {},
        configByPackageId: {}
      },
      transport: {
        activePackageId: null,
        config: {},
        configByPackageId: {}
      },
      provider: {
        activePackageId: null,
        config: {},
        configByPackageId: {}
      },
      plugins: {
        enabledPackageIds: [],
        configByPackageId: {}
      },
      skills: {
        enabledPackageIds: [],
        configByPackageId: {}
      }
    }
  };
}

function readApiAdapterPackageId(packageDir: string): string | null {
  try {
    const manifest = validateApiAdapterPackageManifest(
      JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as ApiAdapterPackageManifest
    );
    return manifest.id;
  } catch {
    return null;
  }
}

function findBundledApiAdapterPackage(): { packageDir: string; packageId: string } | null {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidates = [
      join(current, 'packages', 'http'),
      join(current, '..', 'http'),
      join(current, 'node_modules', '@moorline', 'http')
    ];
    for (const packageDir of candidates) {
      if (!existsSync(join(packageDir, 'manifest.json'))) {
        continue;
      }
      const packageId = readApiAdapterPackageId(packageDir);
      if (packageId) {
        return { packageDir, packageId };
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function ensureCoreRuntimeDirs(runtimeRoot: string): void {
  const paths = runtimePaths(runtimeRoot);
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.workspacesDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
}

async function runInit(command: Extract<CliCommand, { kind: 'init' }>, deps: CliDeps): Promise<number> {
  const configPath = resolveConfigPath(command.configPath);
  if (existsSync(configPath)) {
    deps.output.write(`Moorline config already exists: ${configPath}`);
    deps.output.write('No changes made.');
    return 0;
  }
  const config = initialMoorlineConfig(configPath, command.configPath);
  ensureCoreRuntimeDirs(config.runtimeRoot);
  saveMoorlineConfig(config, configPath);
  const packageService = new OperatorPackageService(config, configPath);
  packageService.ensureInitialized();
  const bundledApiAdapter = findBundledApiAdapterPackage();
  if (bundledApiAdapter) {
    config.surfaces.apiAdapter.configByPackageId ??= {};
    config.surfaces.apiAdapter.configByPackageId[bundledApiAdapter.packageId] = { ...defaultHttpApiAdapterConfig() };
    await packageService.installPackage({
      kind: 'api-adapter',
      source: {
        kind: 'local_dir',
        path: bundledApiAdapter.packageDir
      }
    });
    packageService.setSelectedPackage('api-adapter', bundledApiAdapter.packageId);
  }
  deps.output.write(`Moorline config: ${configPath}`);
  deps.output.write(`Moorline runtime root: ${config.runtimeRoot}`);
  deps.output.write(
    bundledApiAdapter
      ? `Installed and selected bundled API adapter ${bundledApiAdapter.packageId}.`
      : 'No bundled API adapter found; install one before starting the Control API.'
  );
  deps.output.write('Core runtime scaffold initialized. Run moorline run to open the Control API.');
  return 0;
}

async function controlApiClient(
  input: ControlApiConnectionOptions
): Promise<{
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  getBinary(path: string): Promise<{ bytes: Uint8Array; contentType: string; contentDisposition: string | null }>;
  postBinary(path: string, body: Uint8Array | ArrayBuffer, contentType: string): Promise<unknown>;
}> {
  const { ControlApiClient } = await import('@moorline/control-api/client.js');
  return new ControlApiClient({
    ...(input.url ? { url: input.url } : {}),
    ...(input.token ? { token: input.token } : {}),
    ...(input.configPath ? { configPath: input.configPath } : {}),
    autoStart: true,
    entrypoint: process.argv[1]!
  });
}

function hasRemoteConnection(input: ControlApiConnectionOptions): boolean {
  return Boolean(input.url ?? process.env.MOORLINE_API_URL);
}

function interactiveLeasePolicy(command: ControlApiConnectionOptions) {
  if (hasRemoteConnection(command)) {
    return defaultMainProcessConfig().defaultLifecyclePolicy;
  }
  const config = loadMoorlineConfig(resolveConfigPath(command.configPath));
  return config.main?.defaultLifecyclePolicy ?? defaultMainProcessConfig().defaultLifecyclePolicy;
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/filename="?([^";]+)"?/i);
  if (!match?.[1]) {
    return null;
  }
  return basename(match[1]);
}

async function runInteractive(command: Extract<CliCommand, { kind: 'interactive' }>, deps: CliDeps): Promise<number> {
  const client = await controlApiClient(command);
  const { bindControlApiLease } = await import('@moorline/control-api/client.js');
  const lease = await bindControlApiLease(client as { post(path: string, body: unknown): Promise<unknown> }, {
    clientName: 'cli-interactive',
    policy: interactiveLeasePolicy(command)
  });
  deps.output.write('Moorline interactive mode (prompt wizard).');

  try {
    while (true) {
      const mode = await deps.prompt.select(
        'Mode',
        'Choose a top-level mode.',
        [
          { label: 'Operations', value: 'operations', description: 'Runtime control and live work actions.' },
          { label: 'Configure', value: 'configure', description: 'Package, model, and setup actions.' },
          { label: 'Exit', value: 'exit', description: 'Leave interactive mode.' }
        ],
        'operations'
      );

      if (mode === 'exit') {
        deps.output.write('Interactive mode closed.');
        return 0;
      }

      if (mode === 'operations') {
        const action = await deps.prompt.select(
          'Operations Action',
          'Select an operations action.',
          [
            { label: 'Show state', value: 'state', description: 'Get operations snapshot.' },
            { label: 'Set accepting', value: 'accepting', description: 'Toggle queue intake.' },
            { label: 'Reload runtime', value: 'reload', description: 'Graceful or force reload.' },
            { label: 'Provider test', value: 'test', description: 'Verify selected provider startup.' },
            { label: 'Provider start', value: 'start', description: 'Start provider sessions.' },
            { label: 'Provider stop', value: 'stop', description: 'Stop provider sessions.' },
            { label: 'List requests', value: 'requests', description: 'Inspect pending requests.' }
          ],
          'state'
        );
        if (action === 'state') {
          renderJson(await client.get('/api/state/operations'), deps.output);
          continue;
        }
        if (action === 'accepting') {
          const choice = await deps.prompt.select(
            'Accepting',
            'Set runtime queue acceptance mode.',
            [
              { label: 'On', value: 'on', description: 'Accept new work.' },
              { label: 'Off', value: 'off', description: 'Drain new work.' }
            ],
            'on'
          );
          renderJson(await client.post('/api/runtime/accepting', { accepting: choice === 'on' }), deps.output);
          continue;
        }
        if (action === 'reload') {
          const modeChoice = await deps.prompt.select(
            'Reload Mode',
            'Choose runtime reload mode.',
            [
              { label: 'Graceful', value: 'graceful', description: 'Drain and replace worker.' },
              { label: 'Force', value: 'force', description: 'Immediate interruption.' }
            ],
            'graceful'
          );
          renderJson(await client.post('/api/runtime/reload', { mode: modeChoice }), deps.output);
          continue;
        }
        if (action === 'start') {
          renderJson(await client.post('/api/provider/start', {}), deps.output);
          continue;
        }
        if (action === 'test') {
          renderJson(await client.post('/api/provider/test', { sendTurn: true }), deps.output);
          continue;
        }
        if (action === 'stop') {
          renderJson(await client.post('/api/provider/stop', {}), deps.output);
          continue;
        }
        if (action === 'requests') {
          renderJson(await client.get('/api/pending-requests/list'), deps.output);
          continue;
        }
      }

      if (mode === 'configure') {
        const action = await deps.prompt.select(
          'Configure Action',
          'Select a configure action.',
          [
            { label: 'Show state', value: 'state', description: 'Get configure snapshot.' },
            { label: 'Apply packages', value: 'apply', description: 'Apply staged package/config changes.' },
            { label: 'Set default model', value: 'model', description: 'Update default model id.' },
            { label: 'Create snapshot', value: 'snapshot', description: 'Create local history snapshot.' }
          ],
          'state'
        );
        if (action === 'state') {
          renderJson(await client.get('/api/state/configure'), deps.output);
          continue;
        }
        if (action === 'apply') {
          renderJson(await client.post('/api/packages/apply', {}), deps.output);
          continue;
        }
        if (action === 'model') {
          const model = await deps.prompt.input('Default Model', 'Enter model id.', 'latest');
          renderJson(await client.post('/api/management/default-model', { model }), deps.output);
          continue;
        }
        if (action === 'snapshot') {
          const label = await deps.prompt.input('Snapshot Label', 'Enter snapshot label.', 'interactive snapshot');
          renderJson(await client.post('/api/history/snapshot', { label }), deps.output);
          continue;
        }
      }
    }
  } finally {
    await lease.release();
  }
}

export async function executeCli(command: CliCommand, deps: CliDeps): Promise<number> {
  try {
    switch (command.kind) {
      case 'help': {
        renderHelp(deps.output);
        return 0;
      }
      case 'init': {
        return await runInit(command, deps);
      }
      case 'api-run-foreground': {
        return await runApiForeground(command, deps);
      }
      case 'api-start': {
        const resolver = new ApiBootstrapResolver({
          configPath: command.configPath,
          entrypoint: process.argv[1]!
        });
        const hasRemoteConnection = Boolean(command.url ?? process.env.MOORLINE_API_URL);
        const started = hasRemoteConnection
          ? await resolver.resolveConnection({
              url: command.url,
              token: command.token,
              configPath: command.configPath,
              autoStart: false
            })
          : await resolver.startLocalApiInBackground(resolveConfigPath(command.configPath));
        deps.output.write(`Moorline Control API: ${started.url}`);
        deps.output.write(`Moorline Control API token: ${started.token}`);
        return 0;
      }
      case 'api-stop': {
        const resolver = new ApiBootstrapResolver({
          configPath: command.configPath,
          entrypoint: process.argv[1]!
        });
        const hasRemoteConnection = Boolean(command.url ?? process.env.MOORLINE_API_URL);
        const record = hasRemoteConnection ? null : readControlApiBootstrapRecord(command.configPath);
        const connection =
          hasRemoteConnection
            ? await resolver.resolveConnection({
                url: command.url,
                token: command.token,
                configPath: command.configPath,
                autoStart: false
              })
            : record
              ? { url: record.url, token: record.token, configPath: record.configPath }
              : null;
        if (!connection) {
          deps.output.write('Control API is not running.');
          return 0;
        }
        const client = await controlApiClient({
          configPath: connection.configPath,
          url: connection.url,
          token: connection.token
        });
        await client.post('/api/shutdown', {});
        if (!hasRemoteConnection) {
          clearControlApiBootstrapRecord(command.configPath);
        }
        deps.output.write('Control API shutdown requested.');
        return 0;
      }
      case 'api-status': {
        const resolver = new ApiBootstrapResolver({
          configPath: command.configPath,
          entrypoint: process.argv[1]!
        });
        const hasRemoteConnection = Boolean(command.url ?? process.env.MOORLINE_API_URL);
        const record = hasRemoteConnection ? null : readControlApiBootstrapRecord(command.configPath);
        const connection =
          hasRemoteConnection
            ? await resolver.resolveConnection({
                url: command.url,
                token: command.token,
                configPath: command.configPath,
                autoStart: false
              })
            : record
              ? { url: record.url, token: record.token, configPath: record.configPath, pid: record.pid, startedAt: record.startedAt }
              : null;
        if (!connection) {
          deps.output.write('Control API is not running.');
          return 0;
        }
        const apiBaseUrl = connection.url.replace(/\/+$/, '');
        const response = await fetch(`${apiBaseUrl}/api/state/configure`, {
          headers: {
            authorization: `Bearer ${connection.token}`
          }
        }).catch(() => null);
        if (!response?.ok) {
          deps.output.write(`Control API metadata exists but authenticated status check failed: ${connection.url}`);
          return 1;
        }
        deps.output.write(`Control API: ${connection.url}`);
        if ('pid' in connection) {
          deps.output.write(`PID: ${connection.pid}`);
        }
        if ('startedAt' in connection) {
          deps.output.write(`Started: ${connection.startedAt}`);
        }
        return 0;
      }
      case 'worker-run': {
        return await runRuntimeWorker(command, deps);
      }
      case 'package-search': {
        const params = new globalThis.URLSearchParams();
        if (command.query) {
          params.set('q', command.query);
        }
        if (command.packageKind) {
          params.set('kind', command.packageKind);
        }
        const path = `/api/packages/search${params.toString() ? `?${params.toString()}` : ''}`;
        const payload = await (await controlApiClient(command)).get(path);
        if (command.json) {
          renderJson(payload, deps.output);
        } else {
          renderPackageRows(payload, deps.output);
        }
        return 0;
      }
      case 'package-info': {
        const params = new globalThis.URLSearchParams({
          packageId: command.packageId
        });
        if (command.packageKind) {
          params.set('kind', command.packageKind);
        }
        const payload = await (await controlApiClient(command)).get(`/api/packages/info?${params.toString()}`);
        if (command.json) {
          renderJson(payload, deps.output);
        } else {
          renderPackageInfo(payload, deps.output);
        }
        return 0;
      }
      case 'package-install': {
        const payload = await (await controlApiClient(command)).post('/api/packages/install', {
          kind: command.packageKind,
          packageId: command.packageId
        });
        if (command.json) {
          renderJson(payload, deps.output);
        } else {
          deps.output.write(formatHuman(payload));
        }
        return 0;
      }
      case 'api-get': {
        const payload = await (await controlApiClient(command)).get(command.path);
        if (command.json) {
          renderJson(payload, deps.output);
        } else {
          deps.output.write(formatHuman(payload));
        }
        return 0;
      }
      case 'api-post': {
        const payload = await (await controlApiClient(command)).post(command.path, command.payload);
        if (command.json) {
          renderJson(payload, deps.output);
        } else {
          deps.output.write(formatHuman(payload));
        }
        return 0;
      }
      case 'api-download': {
        const result = await (await controlApiClient(command)).getBinary(command.path);
        const inferredName = filenameFromContentDisposition(result.contentDisposition) ?? 'moorline-download.bin';
        const target = resolve(command.outPath ?? inferredName);
        writeFileSync(target, Buffer.from(result.bytes));
        if (command.json) {
          renderJson({ path: target, bytes: result.bytes.byteLength, contentType: result.contentType }, deps.output);
        } else {
          deps.output.write(`Saved ${result.bytes.byteLength} bytes to ${target}.`);
        }
        return 0;
      }
      case 'api-upload': {
        const bytes = readFileSync(resolve(command.filePath));
        const payload = await (await controlApiClient(command)).postBinary(command.path, bytes, command.contentType);
        if (command.json) {
          renderJson(payload, deps.output);
        } else {
          deps.output.write(formatHuman(payload));
        }
        return 0;
      }
      case 'interactive': {
        return await runInteractive(command, deps);
      }
      default:
        return 1;
    }
  } finally {
    deps.prompt.close();
  }
}

export function cliDefaults(output: OutputWriter, prompt: PromptAdapter, commandRunner: ChildProcessRunner): CliDeps {
  return {
    output,
    prompt,
    commandRunner,
    waitForShutdown: () =>
      new Promise<void>((resolve) => {
        const finish = (): void => {
          process.off('SIGINT', finish);
          process.off('SIGTERM', finish);
          resolve();
        };

        process.on('SIGINT', finish);
        process.on('SIGTERM', finish);
      })
  };
}
