import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

import type { PackageKind, PackageSourceDescriptor } from './package.js';
import { validatePackageId } from './package.js';

export type MoorlineConfigVersion = 4;
export const CURRENT_MOORLINE_CONFIG_VERSION: MoorlineConfigVersion = 4;
export const DEFAULT_MOORLINE_MODEL = 'latest';

export type ExecutionModeName = 'full-access' | 'approval-required';

export interface RuntimeSurfaceNames {
  mainCategoryName: string;
  coordinationResourceName: string;
  statusResourceName: string;
  sessionsGroupName: string;
  archiveGroupName: string;
}

export interface TransportConfig {
  kind: string;
  packageId?: string;
  config: Record<string, unknown>;
  scopeId: string;
}

export interface ProviderConfig {
  kind: string;
  packageId?: string;
  config: Record<string, unknown>;
}

export const DEFAULT_MOORLINE_ADMIN_ROLE_NAME = 'Moorline Admin';
export const DEFAULT_MOORLINE_USER_ROLE_NAME = 'Moorline User';

export interface ManagedAdminRoleConfig {
  enabled: boolean;
  name: string;
}

export interface ManagedUserRoleConfig {
  enabled: boolean;
  name: string;
}

export interface AdminConfig {
  accessGroupIds: string[];
  userIds: string[];
  allowTransportAdmin?: boolean;
  managedRole: ManagedAdminRoleConfig;
  managedUserRole: ManagedUserRoleConfig;
}

type ManagementExposureMode = 'loopback' | 'remote';
type ManagementAuthMode = 'bearer';

interface LocalManagementAuthConfig {
  mode: ManagementAuthMode;
}

interface LocalManagementTlsConfig {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
}

export interface LocalManagementConfig {
  enabled: boolean;
  host: string;
  port: number;
  exposure?: ManagementExposureMode;
  auth?: LocalManagementAuthConfig;
  tls?: LocalManagementTlsConfig;
}

export type ControlApiConfig = LocalManagementConfig;
export type MainLifecyclePolicy = 'detached' | 'stop_on_last_lease';

export interface MainProcessConfig {
  autostart: boolean;
  defaultLifecyclePolicy: MainLifecyclePolicy;
}

export interface SurfaceSelectionState {
  activePackageId: string | null;
  config: Record<string, unknown>;
  configByPackageId?: Record<string, Record<string, unknown>>;
}

export interface SurfaceEnablementState {
  enabledPackageIds: string[];
  configByPackageId: Record<string, Record<string, unknown>>;
}

export interface MoorlineSetupState {
  completed: boolean;
  completedAt?: string;
}

export interface MoorlineSecrets {
  version: 1;
  surfaces: {
    apiAdapter: {
      config: Record<string, unknown>;
      configByPackageId: Record<string, Record<string, unknown>>;
    };
    transport: {
      config: Record<string, unknown>;
      configByPackageId: Record<string, Record<string, unknown>>;
    };
    provider: {
      config: Record<string, unknown>;
      configByPackageId: Record<string, Record<string, unknown>>;
    };
    plugins: {
      configByPackageId: Record<string, Record<string, unknown>>;
    };
    skills: {
      configByPackageId: Record<string, Record<string, unknown>>;
    };
  };
}

export interface MoorlineShareBundle {
  version: 1;
  exportedAt: string;
  productVersion: string;
  config: MoorlineConfig;
  packages: {
    selectedApiAdapterPackageId: string | null;
    selectedTransportPackageId: string | null;
    selectedProviderPackageId: string | null;
    enabledPluginPackageIds: string[];
    enabledSkillPackageIds: string[];
    installed: Array<{
      kind?: PackageKind;
      surface: PackageKind;
      packageId: string;
      source: PackageSourceDescriptor | null;
      shareState: 'portable' | 'local_only' | 'missing_source';
    }>;
  };
  notes: string[];
}

export interface MoorlineConfig {
  version: MoorlineConfigVersion;
  runtimeRoot: string;
  transport?: TransportConfig;
  provider?: ProviderConfig;
  admin?: AdminConfig;
  main?: MainProcessConfig;
  defaults: {
    runtimeMode: ExecutionModeName;
    model: string;
  };
  surface: RuntimeSurfaceNames;
  setup: MoorlineSetupState;
  surfaces: {
    apiAdapter: SurfaceSelectionState;
    transport: SurfaceSelectionState;
    provider: SurfaceSelectionState;
    plugins: SurfaceEnablementState;
    skills: SurfaceEnablementState;
  };
}

export type AppliedMoorlineConfig = MoorlineConfig & {
  transport: TransportConfig;
  provider: ProviderConfig;
  main: MainProcessConfig;
  surface: RuntimeSurfaceNames;
};

export interface RuntimeSurfaceState {
  scopeId?: string;
  surfaceId: string;
  coordinationResourceId?: string;
  statusResourceId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export type ManagedSurfaceState = RuntimeSurfaceState;

export function defaultMoorlineHomePath(): string {
  const override = process.env.MOORLINE_HOME?.trim();
  return resolve(override || homedir(), override ? '.' : '.moorline');
}

export function defaultMoorlineRuntimeRoot(): string {
  return resolve(defaultMoorlineHomePath(), 'runtime');
}

export function homeRootForRuntime(runtimeRoot: string): string {
  const normalizedRuntimeRoot = resolve(runtimeRoot);
  return normalizedRuntimeRoot === defaultMoorlineRuntimeRoot() ? defaultMoorlineHomePath() : normalizedRuntimeRoot;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function containsControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function parseManagedRuntimeRoot(value: unknown): string {
  const managedRuntimeRoot = defaultMoorlineRuntimeRoot();
  if (value === undefined) {
    return managedRuntimeRoot;
  }

  const rawRuntimeRoot = asString(value, 'config.runtimeRoot').trim();
  if (containsControlCharacters(rawRuntimeRoot)) {
    throw new Error('config.runtimeRoot contains forbidden control characters.');
  }
  const configuredRuntimeRoot = resolve(rawRuntimeRoot);
  if (configuredRuntimeRoot === resolve('/')) {
    throw new Error('config.runtimeRoot must not be the filesystem root.');
  }
  return configuredRuntimeRoot;
}

function asModelDefault(value: unknown, label: string): string {
  if (value === undefined) {
    return DEFAULT_MOORLINE_MODEL;
  }
  const model = asString(value, label);
  return model.trim().toLowerCase() === 'latest' ? DEFAULT_MOORLINE_MODEL : model;
}

function asExecutionMode(value: unknown, label: string): ExecutionModeName {
  if (value === 'full-access' || value === 'approval-required') {
    return value;
  }
  throw new Error(`${label} must be "full-access" or "approval-required"`);
}

function parseStringList(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((entry) => asString(entry, label));
}

function parseTransportConfig(root: Record<string, unknown>): TransportConfig {
  const packageId = parseOptionalPackageId(root.packageId, 'config.transport.packageId');
  const config = parseRecord(root.config);
  const scopeId = typeof root.scopeId === 'string' && root.scopeId.trim() ? root.scopeId : typeof config.scopeId === 'string' ? config.scopeId : '';
  return {
    kind: typeof root.kind === 'string' && root.kind.trim() ? root.kind : (packageId ?? 'transport'),
    ...(packageId ? { packageId } : {}),
    config,
    scopeId
  };
}

function parseProviderConfig(root: Record<string, unknown>): ProviderConfig {
  const packageId = parseOptionalPackageId(root.packageId, 'config.provider.packageId');
  return {
    kind: typeof root.kind === 'string' && root.kind.trim() ? root.kind : (packageId ?? 'provider'),
    ...(packageId ? { packageId } : {}),
    config: parseRecord(root.config)
  };
}

function parseAdminConfig(root: Record<string, unknown>): AdminConfig {
  const managedRoleRoot =
    root.managedRole && typeof root.managedRole === 'object'
      ? asObject(root.managedRole, 'config.admin.managedRole')
      : {};
  const managedUserRoleRoot =
    root.managedUserRole && typeof root.managedUserRole === 'object'
      ? asObject(root.managedUserRole, 'config.admin.managedUserRole')
      : {};
  return {
    accessGroupIds: parseStringList(root.accessGroupIds, 'config.admin.accessGroupIds'),
    userIds: parseStringList(root.userIds, 'config.admin.userIds'),
    allowTransportAdmin: root.allowTransportAdmin === true,
    managedRole: {
      enabled: managedRoleRoot.enabled !== false,
      name:
        managedRoleRoot.name === undefined
          ? DEFAULT_MOORLINE_ADMIN_ROLE_NAME
          : asString(managedRoleRoot.name, 'config.admin.managedRole.name')
    },
    managedUserRole: {
      enabled: managedUserRoleRoot.enabled !== false,
      name:
        managedUserRoleRoot.name === undefined
          ? DEFAULT_MOORLINE_USER_ROLE_NAME
          : asString(managedUserRoleRoot.name, 'config.admin.managedUserRole.name')
    }
  };
}

function parseManagementConfig(root: Record<string, unknown>): LocalManagementConfig {
  const defaults = defaultManagementConfig();
  const exposure = root.exposure === 'remote' ? 'remote' : 'loopback';
  const host =
    root.host === undefined
      ? defaults.host
      : parseManagementHost(root.host, 'config.surfaces.apiAdapter.config.host', {
          allowRemote: exposure === 'remote'
        });
  const port = root.port === undefined ? defaults.port : Number(root.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('config.surfaces.apiAdapter.config.port must be an integer between 0 and 65535');
  }

  const authRoot = parseRecord(root.auth);
  const authMode = authRoot.mode === 'bearer' ? 'bearer' : defaults.auth?.mode ?? 'bearer';
  const tlsRoot = parseRecord(root.tls);
  const certPath = typeof tlsRoot.certPath === 'string' && tlsRoot.certPath.trim().length > 0 ? tlsRoot.certPath.trim() : undefined;
  const keyPath = typeof tlsRoot.keyPath === 'string' && tlsRoot.keyPath.trim().length > 0 ? tlsRoot.keyPath.trim() : undefined;

  return {
    enabled: root.enabled !== false,
    host,
    port,
    exposure,
    auth: {
      mode: authMode
    },
    tls: {
      enabled: tlsRoot.enabled === true,
      ...(certPath ? { certPath } : {}),
      ...(keyPath ? { keyPath } : {})
    }
  };
}

function parseMainProcessConfig(root: Record<string, unknown>): MainProcessConfig {
  return {
    autostart: root.autostart === true,
    defaultLifecyclePolicy: root.defaultLifecyclePolicy === 'stop_on_last_lease' ? 'stop_on_last_lease' : 'detached'
  };
}

function isLoopbackIPv4Address(host: string): boolean {
  const segments = host.split('.');
  if (segments.length !== 4) {
    return false;
  }
  const octets = segments.map((segment) => Number(segment));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  return octets[0] === 127;
}

function isLoopbackIPv6Address(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackIPv4Address(normalized.slice('::ffff:'.length));
  }
  return false;
}

function stripIpv6Brackets(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeManagementHost(host: string): string {
  const normalized = stripIpv6Brackets(host).trim().toLowerCase();
  if (normalized === 'localhost') {
    return 'localhost';
  }
  return normalized;
}

function formatManagementHostForUrl(host: string): string {
  const normalized = stripIpv6Brackets(host).trim();
  return isIP(normalized) === 6 ? `[${normalized}]` : normalized;
}

export function formatManagementHttpUrl(host: string, port: number): string {
  return `http://${formatManagementHostForUrl(host)}:${port}`;
}

export function normalizeManagementOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    const host = normalizeManagementHost(parsed.hostname);
    const parsedPort = parsed.port ? Number.parseInt(parsed.port, 10) : Number.NaN;
    const port =
      Number.isFinite(parsedPort) && parsedPort > 0
        ? parsedPort
        : parsed.protocol === 'http:'
          ? 80
          : parsed.protocol === 'https:'
            ? 443
            : null;
    if (!port) {
      return null;
    }
    return `${parsed.protocol}//${formatManagementHostForUrl(host)}:${port}`;
  } catch {
    return null;
  }
}

function parseManagementHost(
  value: unknown,
  label: string,
  options: {
    allowRemote?: boolean;
  } = {}
): string {
  const host = normalizeManagementHost(asString(value, label));
  if (options.allowRemote) {
    return host;
  }
  if (host === 'localhost') {
    return host;
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4 && isLoopbackIPv4Address(host)) {
    return host;
  }
  if (ipVersion === 6 && isLoopbackIPv6Address(host)) {
    return host;
  }
  throw new Error(`${label} must be localhost or a loopback IP address (127.0.0.0/8 or ::1).`);
}

function parseSurfaceNames(root: Record<string, unknown>): RuntimeSurfaceNames {
  return {
    mainCategoryName: asString(root.mainCategoryName, 'config.surface.mainCategoryName'),
    coordinationResourceName: asString(root.coordinationResourceName, 'config.surface.coordinationResourceName'),
    statusResourceName: asString(root.statusResourceName, 'config.surface.statusResourceName'),
    sessionsGroupName: asString(root.sessionsGroupName, 'config.surface.sessionsGroupName'),
    archiveGroupName: asString(root.archiveGroupName, 'config.surface.archiveGroupName')
  };
}

function parseRecord(root: unknown): Record<string, unknown> {
  return root && typeof root === 'object' ? (root as Record<string, unknown>) : {};
}

function parseOptionalPackageId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string when provided`);
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return validatePackageId(normalized, label);
}

function parseSelectionState(root: unknown, label: string): SurfaceSelectionState {
  const value = parseRecord(root);
  const activePackageIdRaw = value.activePackageId;
  let activePackageId: string | null = null;
  if (activePackageIdRaw !== undefined && activePackageIdRaw !== null) {
    if (typeof activePackageIdRaw !== 'string') {
      throw new Error(`${label}.activePackageId must be a string when provided.`);
    }
    activePackageId = validatePackageId(activePackageIdRaw, `${label}.activePackageId`);
  }
  return {
    activePackageId,
    config: parseRecord(value.config),
    configByPackageId: parseConfigByPackageIdRecord(value.configByPackageId, `${label}.configByPackageId`)
  };
}

function parseConfigByPackageIdRecord(root: unknown, label: string): Record<string, Record<string, unknown>> {
  const value = parseRecord(root);
  const entries: Array<[string, Record<string, unknown>]> = [];
  for (const [packageId, entry] of Object.entries(value)) {
    entries.push([validatePackageId(packageId, `${label}.${packageId}`), parseRecord(entry)]);
  }
  return Object.fromEntries(entries);
}

function parseEnablementState(root: unknown, label: string): SurfaceEnablementState {
  const value = parseRecord(root);
  return {
    enabledPackageIds: parseStringList(value.enabledPackageIds, `${label}.enabledPackageIds`).map((entry, index) =>
      validatePackageId(entry, `${label}.enabledPackageIds[${index}]`)
    ),
    configByPackageId: parseConfigByPackageIdRecord(value.configByPackageId, `${label}.configByPackageId`)
  };
}

function parseSetupState(root: unknown): MoorlineSetupState {
  const value = parseRecord(root);
  return {
    completed: value.completed === true,
    ...(typeof value.completedAt === 'string' && value.completedAt.trim() ? { completedAt: value.completedAt } : {})
  };
}

export function defaultSurfaceNames(): RuntimeSurfaceNames {
  return {
    mainCategoryName: 'Moorline',
    coordinationResourceName: 'moorline-coordination',
    statusResourceName: 'moorline-status',
    sessionsGroupName: 'Moorline Sessions',
    archiveGroupName: 'Moorline Archive'
  };
}

export function defaultAdminConfig(): AdminConfig {
  return {
    accessGroupIds: [],
    userIds: [],
    allowTransportAdmin: false,
    managedRole: {
      enabled: true,
      name: DEFAULT_MOORLINE_ADMIN_ROLE_NAME
    },
    managedUserRole: {
      enabled: true,
      name: DEFAULT_MOORLINE_USER_ROLE_NAME
    }
  };
}

export function defaultManagementConfig(): LocalManagementConfig {
  return {
    enabled: true,
    host: '127.0.0.1',
    port: 45173,
    exposure: 'loopback',
    auth: {
      mode: 'bearer'
    },
    tls: {
      enabled: false
    }
  };
}

export function defaultHttpApiAdapterConfig(): ControlApiConfig {
  return defaultManagementConfig();
}

export function parseHttpApiAdapterConfig(config: Record<string, unknown>): ControlApiConfig {
  return parseManagementConfig(config);
}

export function selectedApiAdapterPackageConfig(config: MoorlineConfig, packageId = config.surfaces.apiAdapter.activePackageId): Record<string, unknown> {
  if (!packageId) {
    return {};
  }
  const directConfig = Object.fromEntries(
    Object.entries(config.surfaces.apiAdapter.config).filter(
      ([key, value]) => !(key.includes('/') && typeof value === 'object' && value !== null && !Array.isArray(value))
    )
  );
  return {
    ...(config.surfaces.apiAdapter.activePackageId === packageId ? directConfig : {}),
    ...(config.surfaces.apiAdapter.configByPackageId?.[packageId] ?? {})
  };
}

export function defaultMainProcessConfig(): MainProcessConfig {
  return {
    autostart: false,
    defaultLifecyclePolicy: 'detached'
  };
}

export function defaultTransportPackageId(kind: string): string {
  return kind;
}

export function defaultProviderPackageId(kind: string): string {
  return kind;
}

export function usesProviderDefaultModel(model: string): boolean {
  return model.trim().toLowerCase() === DEFAULT_MOORLINE_MODEL;
}

export function parseMoorlineConfig(input: unknown): MoorlineConfig {
  const root = asObject(input, 'config');
  const version = root.version;

  if (version !== 4) {
    throw new Error('config.version must be 4');
  }

  const defaults = asObject(root.defaults, 'config.defaults');
  if (root.namespace !== undefined) {
    throw new Error('config.namespace has been removed. Use config.surface.');
  }
  const surface = asObject(root.surface, 'config.surface');
  const transportRoot = root.transport && typeof root.transport === 'object' ? (root.transport as Record<string, unknown>) : null;
  const providerRoot = root.provider && typeof root.provider === 'object' ? (root.provider as Record<string, unknown>) : null;
  if (root.management !== undefined || root.api !== undefined || root.clients !== undefined) {
    throw new Error('Top-level management, api, and clients config blocks have been removed. Configure the API adapter under config.surfaces.apiAdapter.');
  }
  const mainRoot = parseRecord(root.main);
  const surfacesRoot = parseRecord(root.surfaces);

  return {
    version: CURRENT_MOORLINE_CONFIG_VERSION,
    runtimeRoot: parseManagedRuntimeRoot(root.runtimeRoot),
    ...(transportRoot ? { transport: parseTransportConfig(transportRoot) } : {}),
    ...(providerRoot ? { provider: parseProviderConfig(providerRoot) } : {}),
    admin: parseAdminConfig(parseRecord(root.admin)),
    main: parseMainProcessConfig(mainRoot),
    defaults: {
      runtimeMode: asExecutionMode(defaults.runtimeMode, 'config.defaults.runtimeMode'),
      model: asModelDefault(defaults.model, 'config.defaults.model')
    },
    surface: parseSurfaceNames(surface),
    setup: parseSetupState(root.setup),
    surfaces: {
      apiAdapter: parseSelectionState(surfacesRoot.apiAdapter, 'config.surfaces.apiAdapter'),
      transport: parseSelectionState(surfacesRoot.transport, 'config.surfaces.transport'),
      provider: parseSelectionState(surfacesRoot.provider, 'config.surfaces.provider'),
      plugins: parseEnablementState(surfacesRoot.plugins, 'config.surfaces.plugins'),
      skills: parseEnablementState(surfacesRoot.skills, 'config.surfaces.skills')
    }
  };
}

export function configuredApiAdapterConfig(
  config: MoorlineConfig,
  packageId = config.surfaces.apiAdapter.activePackageId
): ControlApiConfig {
  const selectedPackageId = packageId;
  return parseHttpApiAdapterConfig(selectedApiAdapterPackageConfig(config, selectedPackageId));
}
