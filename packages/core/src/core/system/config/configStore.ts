import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  defaultMoorlineHomePath,
  homeRootForRuntime,
  parseMoorlineConfig,
  type MoorlineConfig,
  type MoorlineSecrets,
  type ManagedNamespaceState,
  type ProviderConfig,
  type TransportConfig
} from '../../../types/config.js';
import { resolvePackageConfigSchema, secretConfigKeys } from '../../extension/packages/packageConfigSchema.js';
import { GitHistoryService } from '../vcs/gitHistoryService.js';
import { writeFileAtomicSync } from '../../shared/fs/atomicWrite.js';

interface RuntimePaths {
  runtimeRoot: string;
  stateDir: string;
  workspacesDir: string;
  logsDir: string;
  sqlitePath: string;
  installationPath: string;
  packageInventoryPath: string;
  packageLoadReportPath: string;
}

interface ConfigMigrationWarning {
  type: 'secret_history_reset';
  createdAt: string;
  backupGitDir: string | null;
  detail: string;
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeJsonFile(path: string, value: unknown, options: { mode?: number } = {}): void {
  ensureParentDir(path);
  writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

function defaultConfigPath(): string {
  return resolve(defaultMoorlineHomePath(), 'config.json');
}

function defaultSecretsPath(): string {
  return resolve(defaultMoorlineHomePath(), 'config.secrets.json');
}

function secretsPathForConfigPath(configPath: string): string {
  const resolvedConfigPath = resolve(configPath);
  if (resolvedConfigPath === defaultConfigPath()) {
    return defaultSecretsPath();
  }
  return join(dirname(resolvedConfigPath), 'config.secrets.json');
}

export function resolveSecretsPathForConfigPath(configPath: string): string {
  return secretsPathForConfigPath(configPath);
}

function defaultMigrationWarningPath(runtimeRoot: string): string {
  return join(resolve(runtimeRoot), 'state', 'config-migration-warning.json');
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const normalizedRoot = resolve(rootPath);
  const normalizedCandidate = resolve(candidatePath);
  const relativePath = relative(normalizedRoot, normalizedCandidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export function resolveConfigPath(customPath?: string): string {
  return customPath ? resolve(customPath) : defaultConfigPath();
}

function defaultSecrets(): MoorlineSecrets {
  return {
    version: 1,
    surfaces: {
      apiAdapter: {
        config: {},
        configByPackageId: {}
      },
      transport: {
        config: {},
        configByPackageId: {}
      },
      provider: {
        config: {},
        configByPackageId: {}
      },
      plugins: {
        configByPackageId: {}
      },
      skills: {
        configByPackageId: {}
      }
    }
  };
}

function cloneConfig(config: MoorlineConfig): MoorlineConfig {
  return JSON.parse(JSON.stringify(config)) as MoorlineConfig;
}

function buildAppliedTransport(config: MoorlineConfig): TransportConfig | undefined {
  const activePackageId = config.surfaces.transport.activePackageId;
  if (!activePackageId) {
    return undefined;
  }
  const source = {
    ...config.surfaces.transport.config,
    ...(config.surfaces.transport.configByPackageId?.[activePackageId] ?? {})
  };
  return {
    kind: activePackageId.split('/').at(-1) ?? activePackageId,
    packageId: activePackageId,
    config: source,
    scopeId: typeof source.scopeId === 'string' ? source.scopeId : ''
  };
}

function buildAppliedProvider(config: MoorlineConfig): ProviderConfig | undefined {
  const activePackageId = config.surfaces.provider.activePackageId;
  if (!activePackageId) {
    return undefined;
  }
  return {
    kind: activePackageId.split('/').at(-1) ?? activePackageId,
    packageId: activePackageId,
    config: {
      ...config.surfaces.provider.config,
      ...(config.surfaces.provider.configByPackageId?.[activePackageId] ?? {})
    }
  };
}

function applyConfigBuildError(surface: 'transport' | 'provider', packageId: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Selected ${surface} package ${packageId} cannot be applied: ${detail}`);
}

export function buildRequiredAppliedSurfaceConfigs(config: MoorlineConfig): {
  transport?: TransportConfig;
  provider?: ProviderConfig;
} {
  let transport: TransportConfig | undefined;
  let provider: ProviderConfig | undefined;

  if (config.surfaces.transport.activePackageId) {
    try {
      transport = buildAppliedTransport(config);
    } catch (error) {
      throw applyConfigBuildError('transport', config.surfaces.transport.activePackageId, error);
    }
  }
  if (config.surfaces.provider.activePackageId) {
    try {
      provider = buildAppliedProvider(config);
    } catch (error) {
      throw applyConfigBuildError('provider', config.surfaces.provider.activePackageId, error);
    }
  }

  return {
    ...(transport ? { transport } : {}),
    ...(provider ? { provider } : {})
  };
}

export function buildAppliedSurfaceConfigs(config: MoorlineConfig): {
  transport?: TransportConfig;
  provider?: ProviderConfig;
} {
  let transport: TransportConfig | undefined;
  let provider: ProviderConfig | undefined;
  try {
    transport = buildAppliedTransport(config);
  } catch {
    transport = undefined;
  }
  try {
    provider = buildAppliedProvider(config);
  } catch {
    provider = undefined;
  }
  return {
    ...(transport ? { transport } : {}),
    ...(provider ? { provider } : {})
  };
}

function configRootsForSurface(
  config: MoorlineConfig,
  secrets: MoorlineSecrets,
  surface: 'api-adapter' | 'transport' | 'provider',
  packageId: string | null
): {
  publicRoot: Record<string, unknown>;
  secretRoot: Record<string, unknown>;
} {
  if (packageId) {
    if (surface === 'api-adapter') {
      config.surfaces.apiAdapter.configByPackageId ??= {};
      config.surfaces.apiAdapter.configByPackageId[packageId] ??= {};
      secrets.surfaces.apiAdapter.configByPackageId[packageId] ??= {};
    } else if (surface === 'transport') {
      config.surfaces.transport.configByPackageId ??= {};
      config.surfaces.transport.configByPackageId[packageId] ??= {};
      secrets.surfaces.transport.configByPackageId[packageId] ??= {};
    } else {
      config.surfaces.provider.configByPackageId ??= {};
      config.surfaces.provider.configByPackageId[packageId] ??= {};
      secrets.surfaces.provider.configByPackageId[packageId] ??= {};
    }
  }
  return {
    publicRoot:
      packageId && surface === 'transport'
        ? config.surfaces.transport.configByPackageId![packageId]
        : packageId && surface === 'api-adapter'
          ? config.surfaces.apiAdapter.configByPackageId![packageId]
        : packageId && surface === 'provider'
          ? config.surfaces.provider.configByPackageId![packageId]
          : surface === 'api-adapter'
            ? config.surfaces.apiAdapter.config
          : surface === 'transport'
            ? config.surfaces.transport.config
            : config.surfaces.provider.config,
    secretRoot:
      packageId && surface === 'transport'
        ? secrets.surfaces.transport.configByPackageId[packageId]
        : packageId && surface === 'api-adapter'
          ? secrets.surfaces.apiAdapter.configByPackageId[packageId]
        : packageId && surface === 'provider'
          ? secrets.surfaces.provider.configByPackageId[packageId]
          : surface === 'api-adapter'
            ? secrets.surfaces.apiAdapter.config
          : surface === 'transport'
            ? secrets.surfaces.transport.config
            : secrets.surfaces.provider.config
  };
}

const BASELINE_SECRET_KEYS_BY_SURFACE: Record<'api-adapter' | 'transport' | 'provider', readonly string[]> = {
  'api-adapter': ['token', 'bearerToken', 'clientSecret'],
  transport: ['authToken', 'botToken', 'token', 'accessToken', 'refreshToken', 'clientSecret'],
  provider: [
    'apiKey',
    'authToken',
    'token',
    'accessToken',
    'refreshToken',
    'clientSecret',
    'secret',
    'password',
    'privateKey'
  ]
};

function normalizeConfigKeyForSensitivityCheck(key: string): string {
  return key.replace(/[^a-z0-9]/giu, '').toLowerCase();
}

function keyLooksSensitive(key: string): boolean {
  const normalized = normalizeConfigKeyForSensitivityCheck(key);
  if (!normalized) {
    return false;
  }
  if (normalized.includes('token') || normalized.includes('secret') || normalized.includes('password')) {
    return true;
  }
  return (
    normalized.includes('apikey') ||
    normalized.includes('privatekey') ||
    normalized.includes('accesskey') ||
    normalized.includes('refreshkey')
  );
}

function secretKeysForSurface(input: {
  runtimeRoot: string;
  surface: 'api-adapter' | 'transport' | 'provider';
  packageId: string | null;
  publicRoot: Record<string, unknown>;
}): string[] {
  const schema = resolvePackageConfigSchema({
    runtimeRoot: input.runtimeRoot,
    surface: input.surface,
    packageId: input.packageId
  });
  const keys = new Set<string>([
    ...BASELINE_SECRET_KEYS_BY_SURFACE[input.surface],
    ...secretConfigKeys(schema),
    ...Object.keys(input.publicRoot).filter((key) => keyLooksSensitive(key))
  ]);
  return [...keys].sort();
}

function configByPackageRootsForSurface(
  config: MoorlineConfig,
  secrets: MoorlineSecrets,
  surface: 'plugin' | 'skill',
  packageId: string
): {
  publicRoot: Record<string, unknown>;
  secretRoot: Record<string, unknown>;
} {
  const publicContainer = surface === 'plugin' ? config.surfaces.plugins.configByPackageId : config.surfaces.skills.configByPackageId;
  const secretContainer =
    surface === 'plugin' ? secrets.surfaces.plugins.configByPackageId : secrets.surfaces.skills.configByPackageId;
  if (!publicContainer[packageId]) {
    publicContainer[packageId] = {};
  }
  if (!secretContainer[packageId]) {
    secretContainer[packageId] = {};
  }
  return {
    publicRoot: publicContainer[packageId],
    secretRoot: secretContainer[packageId]
  };
}

function applySecretSplitToSurface(input: {
  runtimeRoot: string;
  config: MoorlineConfig;
  secrets: MoorlineSecrets;
  surface: 'api-adapter' | 'transport' | 'provider';
  packageId: string | null;
}): boolean {
  const roots = configRootsForSurface(input.config, input.secrets, input.surface, input.packageId);
  const keys = secretKeysForSurface({
    runtimeRoot: input.runtimeRoot,
    surface: input.surface,
    packageId: input.packageId,
    publicRoot: roots.publicRoot
  });
  if (keys.length === 0) {
    return false;
  }
  let changed = false;
  for (const key of keys) {
    if (key in roots.publicRoot) {
      roots.secretRoot[key] = roots.publicRoot[key];
      delete roots.publicRoot[key];
      changed = true;
    }
  }
  return changed;
}

function applySecretSplitToSurfacePackageConfigs(input: {
  runtimeRoot: string;
  config: MoorlineConfig;
  secrets: MoorlineSecrets;
  surface: 'api-adapter' | 'transport' | 'provider';
}): boolean {
  const configByPackageId =
    input.surface === 'api-adapter'
      ? input.config.surfaces.apiAdapter.configByPackageId ?? {}
      : input.surface === 'transport'
        ? input.config.surfaces.transport.configByPackageId ?? {}
        : input.config.surfaces.provider.configByPackageId ?? {};
  let changed = false;
  for (const packageId of Object.keys(configByPackageId)) {
    changed =
      applySecretSplitToSurface({
        runtimeRoot: input.runtimeRoot,
        config: input.config,
        secrets: input.secrets,
        surface: input.surface,
        packageId
      }) || changed;
  }
  return changed;
}

function applySecretSplitToPackageConfigs(input: {
  runtimeRoot: string;
  config: MoorlineConfig;
  secrets: MoorlineSecrets;
  surface: 'plugin' | 'skill';
}): boolean {
  const publicContainer =
    input.surface === 'plugin' ? input.config.surfaces.plugins.configByPackageId : input.config.surfaces.skills.configByPackageId;
  const enabledPackageIds =
    input.surface === 'plugin' ? input.config.surfaces.plugins.enabledPackageIds : input.config.surfaces.skills.enabledPackageIds;
  const packageIds = new Set([...Object.keys(publicContainer), ...enabledPackageIds]);
  let changed = false;
  for (const packageId of packageIds) {
    const schema = resolvePackageConfigSchema({
      runtimeRoot: input.runtimeRoot,
      surface: input.surface,
      packageId
    });
    const keys = secretConfigKeys(schema);
    if (keys.length === 0) {
      continue;
    }
    const roots = configByPackageRootsForSurface(input.config, input.secrets, input.surface, packageId);
    for (const key of keys) {
      if (key in roots.publicRoot) {
        roots.secretRoot[key] = roots.publicRoot[key];
        delete roots.publicRoot[key];
        changed = true;
      }
    }
  }
  return changed;
}

function mergeSecretsIntoSurface(input: {
  config: MoorlineConfig;
  secrets: MoorlineSecrets;
  surface: 'api-adapter' | 'transport' | 'provider';
}): void {
  const roots = configRootsForSurface(input.config, input.secrets, input.surface, null);
  Object.assign(roots.publicRoot, roots.secretRoot);
  const secretContainer =
    input.surface === 'api-adapter'
      ? input.secrets.surfaces.apiAdapter.configByPackageId
      : input.surface === 'transport'
        ? input.secrets.surfaces.transport.configByPackageId
        : input.secrets.surfaces.provider.configByPackageId;
  for (const [packageId, secretConfig] of Object.entries(secretContainer)) {
    const packageRoots = configRootsForSurface(input.config, input.secrets, input.surface, packageId);
    Object.assign(packageRoots.publicRoot, secretConfig);
  }
}

function mergeSecretsIntoPackageConfigs(input: {
  config: MoorlineConfig;
  secrets: MoorlineSecrets;
  surface: 'plugin' | 'skill';
}): void {
  const publicContainer = input.surface === 'plugin' ? input.config.surfaces.plugins.configByPackageId : input.config.surfaces.skills.configByPackageId;
  const secretContainer =
    input.surface === 'plugin' ? input.secrets.surfaces.plugins.configByPackageId : input.secrets.surfaces.skills.configByPackageId;
  for (const [packageId, secretConfig] of Object.entries(secretContainer)) {
    if (!publicContainer[packageId]) {
      publicContainer[packageId] = {};
    }
    Object.assign(publicContainer[packageId], secretConfig);
  }
}

function mergeAppliedConfig(config: MoorlineConfig): MoorlineConfig {
  const applied = buildAppliedSurfaceConfigs(config);
  return {
    ...config,
    ...applied
  };
}

function sanitizePersistedConfig(config: MoorlineConfig): Partial<MoorlineConfig> {
  const persistedConfig = cloneConfig(config) as Partial<MoorlineConfig>;
  delete persistedConfig.transport;
  delete persistedConfig.provider;
  persistedConfig.version = 4;
  return persistedConfig;
}

function splitConfigAndSecrets(config: MoorlineConfig): { publicConfig: Partial<MoorlineConfig>; secrets: MoorlineSecrets } {
  const publicConfig = cloneConfig(config);
  const secrets = defaultSecrets();
  applySecretSplitToSurface({
    runtimeRoot: publicConfig.runtimeRoot,
    config: publicConfig,
    secrets,
    surface: 'api-adapter',
    packageId: null
  });
  applySecretSplitToSurfacePackageConfigs({
    runtimeRoot: publicConfig.runtimeRoot,
    config: publicConfig,
    secrets,
    surface: 'api-adapter'
  });
  applySecretSplitToSurface({
    runtimeRoot: publicConfig.runtimeRoot,
    config: publicConfig,
    secrets,
    surface: 'transport',
    packageId: null
  });
  applySecretSplitToSurfacePackageConfigs({
    runtimeRoot: publicConfig.runtimeRoot,
    config: publicConfig,
    secrets,
    surface: 'transport'
  });
  applySecretSplitToSurface({
    runtimeRoot: publicConfig.runtimeRoot,
    config: publicConfig,
    secrets,
    surface: 'provider',
    packageId: null
  });
  applySecretSplitToSurfacePackageConfigs({
    runtimeRoot: publicConfig.runtimeRoot,
    config: publicConfig,
    secrets,
    surface: 'provider'
  });
  applySecretSplitToPackageConfigs({
    runtimeRoot: publicConfig.runtimeRoot,
    config: publicConfig,
    secrets,
    surface: 'plugin'
  });
  applySecretSplitToPackageConfigs({
    runtimeRoot: publicConfig.runtimeRoot,
    config: publicConfig,
    secrets,
    surface: 'skill'
  });
  return {
    publicConfig: sanitizePersistedConfig(publicConfig),
    secrets
  };
}

export function buildShareableMoorlineConfig(config: MoorlineConfig): MoorlineConfig {
  return splitConfigAndSecrets(config).publicConfig as MoorlineConfig;
}

function loadSecretsFile(path: string): MoorlineSecrets {
  if (!existsSync(path)) {
    return defaultSecrets();
  }
  const parsed = readJsonFile(path) as Partial<MoorlineSecrets>;
  return {
    version: 1,
    surfaces: {
      transport: {
        config:
          parsed.surfaces?.transport?.config && typeof parsed.surfaces.transport.config === 'object'
            ? { ...parsed.surfaces.transport.config }
            : {},
        configByPackageId:
          parsed.surfaces?.transport?.configByPackageId && typeof parsed.surfaces.transport.configByPackageId === 'object'
            ? { ...parsed.surfaces.transport.configByPackageId }
            : {}
      },
      apiAdapter: {
        config:
          parsed.surfaces?.apiAdapter?.config && typeof parsed.surfaces.apiAdapter.config === 'object'
            ? { ...parsed.surfaces.apiAdapter.config }
            : {},
        configByPackageId:
          parsed.surfaces?.apiAdapter?.configByPackageId && typeof parsed.surfaces.apiAdapter.configByPackageId === 'object'
            ? { ...parsed.surfaces.apiAdapter.configByPackageId }
            : {}
      },
      provider: {
        config:
          parsed.surfaces?.provider?.config && typeof parsed.surfaces.provider.config === 'object'
            ? { ...parsed.surfaces.provider.config }
            : {},
        configByPackageId:
          parsed.surfaces?.provider?.configByPackageId && typeof parsed.surfaces.provider.configByPackageId === 'object'
            ? { ...parsed.surfaces.provider.configByPackageId }
            : {}
      },
      plugins: {
        configByPackageId:
          parsed.surfaces?.plugins?.configByPackageId && typeof parsed.surfaces.plugins.configByPackageId === 'object'
            ? { ...parsed.surfaces.plugins.configByPackageId }
            : {}
      },
      skills: {
        configByPackageId:
          parsed.surfaces?.skills?.configByPackageId && typeof parsed.surfaces.skills.configByPackageId === 'object'
            ? { ...parsed.surfaces.skills.configByPackageId }
            : {}
      }
    }
  };
}

function persistedConfigContainsSecrets(config: MoorlineConfig): boolean {
  const working = cloneConfig(config);
  const secrets = defaultSecrets();
  return (
    applySecretSplitToSurface({
      runtimeRoot: working.runtimeRoot,
      config: working,
      secrets,
      surface: 'api-adapter',
      packageId: null
    }) ||
    applySecretSplitToSurfacePackageConfigs({
      runtimeRoot: working.runtimeRoot,
      config: working,
      secrets,
      surface: 'api-adapter'
    }) ||
    applySecretSplitToSurface({
      runtimeRoot: working.runtimeRoot,
      config: working,
      secrets,
      surface: 'transport',
      packageId: null
    }) ||
    applySecretSplitToSurfacePackageConfigs({
      runtimeRoot: working.runtimeRoot,
      config: working,
      secrets,
      surface: 'transport'
    }) ||
    applySecretSplitToSurface({
      runtimeRoot: working.runtimeRoot,
      config: working,
      secrets,
      surface: 'provider',
      packageId: null
    }) ||
    applySecretSplitToSurfacePackageConfigs({
      runtimeRoot: working.runtimeRoot,
      config: working,
      secrets,
      surface: 'provider'
    }) ||
    applySecretSplitToPackageConfigs({
      runtimeRoot: working.runtimeRoot,
      config: working,
      secrets,
      surface: 'plugin'
    }) ||
    applySecretSplitToPackageConfigs({
      runtimeRoot: working.runtimeRoot,
      config: working,
      secrets,
      surface: 'skill'
    })
  );
}

function backupGitHistoryForSecretSplit(input: { homeRoot: string; runtimeRoot: string; configPath: string }): ConfigMigrationWarning | null {
  const homeRoot = resolve(input.homeRoot);
  const gitDir = join(homeRoot, '.git');
  if (!existsSync(gitDir)) {
    return null;
  }
  const backupGitDir = join(homeRoot, `.git.pre-secret-split-${Date.now()}`);
  renameSync(gitDir, backupGitDir);
  const warning: ConfigMigrationWarning = {
    type: 'secret_history_reset',
    createdAt: new Date().toISOString(),
    backupGitDir,
    detail:
      `Previous Moorline history may contain secrets from earlier config state at ${resolve(input.configPath)}. Only the new home-root repo is safe to share by default.`
  };
  writeJsonFile(defaultMigrationWarningPath(input.runtimeRoot), warning);
  return warning;
}

function maybeSanitizePersistedConfig(path: string, config: MoorlineConfig): void {
  const containsSecrets = persistedConfigContainsSecrets(config);
  if (!containsSecrets) {
    saveMoorlineConfig(config, path);
    return;
  }

  const resolvedConfigPath = resolve(path);
  const historyHomeRoot = resolve(homeRootForRuntime(config.runtimeRoot));
  if (isPathWithinRoot(historyHomeRoot, resolvedConfigPath)) {
    backupGitHistoryForSecretSplit({
      homeRoot: historyHomeRoot,
      runtimeRoot: config.runtimeRoot,
      configPath: resolvedConfigPath
    });
    saveMoorlineConfig(config, path);
    new GitHistoryService().ensureInitializedSync(historyHomeRoot);
    return;
  }

  writeJsonFile(defaultMigrationWarningPath(config.runtimeRoot), {
    type: 'secret_history_reset',
    createdAt: new Date().toISOString(),
    backupGitDir: null,
    detail: [
      `Secret split migration moved sensitive values out of ${resolvedConfigPath}.`,
      `The managed history root ${historyHomeRoot} does not include this config path, so Moorline did not reset git history automatically.`,
      'Manually review any other repositories that may have tracked this config path before sharing history.'
    ].join(' ')
  } satisfies ConfigMigrationWarning);
  saveMoorlineConfig(config, path);
}

function loadMoorlineConfigInternal(path: string, migratePersistedConfig: boolean): MoorlineConfig {
  if (!existsSync(path)) {
    throw new Error(`Moorline config not found: ${path}`);
  }

  const raw = readJsonFile(path) as { version?: unknown };
  const parsed = parseMoorlineConfig(raw);
  const needsSanitization = raw.version !== 4 || persistedConfigContainsSecrets(parsed);
  const secrets = loadSecretsFile(secretsPathForConfigPath(path));
  mergeSecretsIntoSurface({ config: parsed, secrets, surface: 'api-adapter' });
  mergeSecretsIntoSurface({ config: parsed, secrets, surface: 'transport' });
  mergeSecretsIntoSurface({ config: parsed, secrets, surface: 'provider' });
  mergeSecretsIntoPackageConfigs({ config: parsed, secrets, surface: 'plugin' });
  mergeSecretsIntoPackageConfigs({ config: parsed, secrets, surface: 'skill' });

  if (migratePersistedConfig && needsSanitization) {
    maybeSanitizePersistedConfig(path, parsed);
  }

  return mergeAppliedConfig(parsed);
}

export function readMoorlineConfig(path = defaultConfigPath()): MoorlineConfig {
  return loadMoorlineConfigInternal(path, false);
}

export function loadMoorlineConfig(path = defaultConfigPath()): MoorlineConfig {
  return loadMoorlineConfigInternal(path, true);
}

export function saveMoorlineConfig(config: MoorlineConfig, path = defaultConfigPath()): void {
  const { publicConfig, secrets } = splitConfigAndSecrets(config);
  writeJsonFile(path, publicConfig);
  const secretsPath = secretsPathForConfigPath(path);
  const hasSecrets =
    Object.keys(secrets.surfaces.apiAdapter.config).length > 0 ||
    Object.keys(secrets.surfaces.apiAdapter.configByPackageId).length > 0 ||
    Object.keys(secrets.surfaces.transport.config).length > 0 ||
    Object.keys(secrets.surfaces.transport.configByPackageId).length > 0 ||
    Object.keys(secrets.surfaces.provider.config).length > 0 ||
    Object.keys(secrets.surfaces.provider.configByPackageId).length > 0 ||
    Object.keys(secrets.surfaces.plugins.configByPackageId).length > 0 ||
    Object.keys(secrets.surfaces.skills.configByPackageId).length > 0;
  if (hasSecrets) {
    writeJsonFile(secretsPath, secrets, { mode: 0o600 });
  } else if (existsSync(secretsPath)) {
    rmSync(secretsPath, { force: true });
  }
}

export function runtimePaths(runtimeRoot: string): RuntimePaths {
  const normalized = resolve(runtimeRoot);
  const stateDir = join(normalized, 'state');
  return {
    runtimeRoot: normalized,
    stateDir,
    workspacesDir: join(normalized, 'workspaces'),
    logsDir: join(normalized, 'logs'),
    sqlitePath: join(normalized, 'state.db'),
    installationPath: join(stateDir, 'installation.json'),
    packageInventoryPath: join(stateDir, 'package-inventory.json'),
    packageLoadReportPath: join(stateDir, 'package-load-report.json')
  };
}

export function ensureRuntimePaths(runtimeRoot: string): RuntimePaths {
  const paths = runtimePaths(runtimeRoot);
  mkdirSync(paths.runtimeRoot, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.workspacesDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  return paths;
}

export function loadInstallationState(path: string): ManagedNamespaceState | null {
  if (!existsSync(path)) {
    return null;
  }
  return readJsonFile(path) as ManagedNamespaceState;
}

export function saveInstallationState(path: string, state: ManagedNamespaceState): void {
  writeJsonFile(path, state);
}

export function readConfigMigrationWarning(runtimeRoot: string): ConfigMigrationWarning | null {
  const path = defaultMigrationWarningPath(runtimeRoot);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = readJsonFile(path) as Partial<ConfigMigrationWarning>;
    if (
      parsed.type !== 'secret_history_reset' ||
      typeof parsed.createdAt !== 'string' ||
      (parsed.backupGitDir !== null && typeof parsed.backupGitDir !== 'string') ||
      typeof parsed.detail !== 'string'
    ) {
      return null;
    }
    return {
      type: parsed.type,
      createdAt: parsed.createdAt,
      backupGitDir: parsed.backupGitDir,
      detail: parsed.detail
    };
  } catch {
    return null;
  }
}

export function acknowledgeConfigMigrationWarning(runtimeRoot: string): void {
  rmSync(defaultMigrationWarningPath(runtimeRoot), { force: true });
}
