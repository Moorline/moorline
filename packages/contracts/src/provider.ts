import type { JsonSchemaLike, PackageDependency, PackageManifestBase } from './package.js';
import { validateJsonSchemaLike, validatePackageActivationRule, validatePackageDependencies, validatePackageId } from './package.js';
import type { EventEmitter } from 'node:events';
import type {
  ProviderPackageId,
  ProviderInputImage,
  ProviderResumeCursor,
  ProviderRuntimeEvent,
  ProviderSessionRecord,
  RuntimeCommandRunner,
  RuntimeAgentKind,
  RuntimeModeName
} from './runtime.js';
import { parseRuntimeAgentKind, parseRuntimeModeName } from './runtime.js';
import type { Capability } from './capabilities.js';
import type { RuntimeToolResult } from './plugin-runtime.js';

export interface ProviderPackageManifest extends PackageManifestBase {
  type: 'provider';
  entrypoint?: string;
  dependencies?: PackageDependency[];
  configSchema?: JsonSchemaLike;
  displayCategory?: string;
  toolPolicy?: ProviderToolPolicyConfig;
  nativeToolDocumentation?: ProviderNativeToolDocumentation;
}

export interface RuntimeProviderPackageContext {
  config: Record<string, unknown>;
  commandRunner?: RuntimeCommandRunner;
}

export interface RuntimeProviderDiagnostics {
  accountLabel: string | null;
  availableModels: string[];
  connectedSessions: number;
  statusCounts: Record<string, number>;
  capabilityMetadata: Record<string, unknown>;
}

export interface RuntimeProviderTestResult {
  ok: boolean;
  message: string;
  remediation?: string;
  accountLabel: string | null;
  availableModels: string[];
  sentTurn: boolean;
  error?: string;
}

export interface RuntimeProviderSessionInput {
  sessionId: string;
  threadId: string;
  transportResourceId: string;
  runtimeMode: RuntimeModeName;
  agentKind: RuntimeAgentKind;
  workspacePath: string | null;
  providerCwd: string | null;
  resumeCursor: ProviderResumeCursor | null;
  lifecycleStatus: string;
  providerAutoStartEnabled?: boolean;
  toolGrantIds: string[];
  toolPolicy: ProviderToolPolicyConfig;
}

export interface ProviderToolPolicyProfileConfig {
  nativePreset: string;
  allowNativeTools?: string[];
  denyNativeTools?: string[];
  grants?: string[];
}

export interface ProviderToolPolicyConfig {
  workspace: ProviderToolPolicyProfileConfig;
  ephemeral: ProviderToolPolicyProfileConfig;
}

export interface ProviderNativeToolDocumentation {
  nativeToolNames: string[];
  defaultWorkspacePreset: string;
  defaultEphemeralPreset: string;
  grantMapping: string;
}

export const DEFAULT_PROVIDER_TOOL_POLICY: ProviderToolPolicyConfig = {
  workspace: {
    nativePreset: 'provider-default'
  },
  ephemeral: {
    nativePreset: 'none',
    grants: ['core.moorline_session']
  }
};

export interface ProviderSkillResource {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  content?: string;
  metadata: Record<string, unknown>;
}

export interface ProviderPromptTemplateResource {
  name: string;
  description?: string;
  content: string;
  source: string;
}

export interface ProviderResourceBundle {
  systemPromptSections: string[];
  contextFiles: Array<{ path: string; content: string; source: string }>;
  skills: ProviderSkillResource[];
  promptTemplates: ProviderPromptTemplateResource[];
}

export interface ProviderToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredCapability?: Capability;
  source: 'core' | 'plugin';
  ownerPackageId?: string;
}

export interface ProviderToolExecutor {
  executeProviderTool(input: {
    threadId: string;
    toolId: string;
    arguments: Record<string, unknown>;
    actor: string;
  }): Promise<RuntimeToolResult>;
}

export interface ProviderTurnContextItem {
  title: string;
  content: string;
  source: string;
}

export interface ProviderTurnInput {
  text: string;
  images?: ProviderInputImage[];
  context?: ProviderTurnContextItem[];
}

export interface RuntimeProvider extends EventEmitter<{
  providerEvent: [event: ProviderRuntimeEvent];
}> {
  listSessions(): ProviderSessionRecord[];
  getDiagnostics(): RuntimeProviderDiagnostics;
  startOrResumeSession(input: {
    session: RuntimeProviderSessionInput;
    runtimeRoot: string;
    actor: string;
    model?: string;
    resources?: ProviderResourceBundle;
    tools?: ProviderToolDefinition[];
    toolExecutor?: ProviderToolExecutor;
  }): Promise<ProviderSessionRecord>;
  recoverSessions(input: {
    sessions: RuntimeProviderSessionInput[];
    runtimeRoot: string;
    model?: string;
  }): Promise<void>;
  testConnection?(input: {
    runtimeRoot: string;
    actor: string;
    model?: string;
    sendTurn?: boolean;
    prompt?: string;
  }): Promise<RuntimeProviderTestResult>;
  sendTurn(threadId: string, input: ProviderTurnInput, model?: string): Promise<{ turnId: string }>;
  compactThread(threadId: string): Promise<void>;
  respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
  ): Promise<void>;
  respondToUserInput(threadId: string, requestId: string, answers: Record<string, string | string[]>): Promise<void>;
  interruptTurn(threadId: string): Promise<void>;
  drain(): Promise<void>;
  stopSession(threadId: string): void;
  stopAll(): void;
}

export interface RuntimeProviderFactoryContext {
  providerPackageId: ProviderPackageId;
}

export type RuntimeProviderFactory = (input: RuntimeProviderFactoryContext) => RuntimeProvider;
export type RuntimeEnvironmentVerifier = () => Promise<void>;

export interface RuntimeProviderPackage {
  manifest: ProviderPackageManifest;
  createProviderFactory(input: RuntimeProviderPackageContext): RuntimeProviderFactory;
  createEnvironmentVerifier?(input: RuntimeProviderPackageContext): RuntimeEnvironmentVerifier | null;
}

export function validateProviderPackageManifest(manifest: ProviderPackageManifest): ProviderPackageManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Provider package manifest must be an object');
  }
  const record = manifest as unknown as Record<string, unknown>;
  validatePackageId(record.id, 'Provider package manifest id');
  if (typeof record.name !== 'string' || !record.name.trim()) {
    throw new Error('Provider package manifest name is required');
  }
  if (typeof record.version !== 'string' || !record.version.trim()) {
    throw new Error('Provider package manifest version is required');
  }
  if (record.type !== 'provider') {
    throw new Error('Provider package manifest type must be "provider"');
  }
  if (record.description !== undefined && (typeof record.description !== 'string' || !record.description.trim())) {
    throw new Error('Provider package manifest description must be non-empty when provided');
  }
  if (record.entrypoint !== undefined && (typeof record.entrypoint !== 'string' || !record.entrypoint.trim())) {
    throw new Error('Provider package manifest entrypoint must be non-empty when provided');
  }
  if (
    record.displayCategory !== undefined &&
    (typeof record.displayCategory !== 'string' || !record.displayCategory.trim())
  ) {
    throw new Error('Provider package manifest displayCategory must be non-empty when provided');
  }
  validatePackageDependencies(record.dependencies, 'provider package manifest');
  validateJsonSchemaLike(record.configSchema, 'provider package manifest');
  const toolPolicy = validateProviderToolPolicyConfig(record.toolPolicy, 'provider package manifest.toolPolicy');
  const nativeToolDocumentation = validateProviderNativeToolDocumentation(
    record.nativeToolDocumentation,
    'provider package manifest.nativeToolDocumentation'
  );
  const activation = validatePackageActivationRule(record.activation, 'provider package manifest');
  return {
    ...manifest,
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(nativeToolDocumentation ? { nativeToolDocumentation } : {}),
    ...(activation !== undefined ? { activation } : {})
  };
}

function validateNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function validateOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided`);
  }
  return value.map((entry, index) => validateNonEmptyString(entry, `${label}[${index}]`));
}

function validateProviderToolPolicyProfileConfig(value: unknown, label: string): ProviderToolPolicyProfileConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  return {
    nativePreset: validateNonEmptyString(record.nativePreset, `${label}.nativePreset`),
    ...(validateOptionalStringArray(record.allowNativeTools, `${label}.allowNativeTools`)
      ? { allowNativeTools: validateOptionalStringArray(record.allowNativeTools, `${label}.allowNativeTools`) }
      : {}),
    ...(validateOptionalStringArray(record.denyNativeTools, `${label}.denyNativeTools`)
      ? { denyNativeTools: validateOptionalStringArray(record.denyNativeTools, `${label}.denyNativeTools`) }
      : {}),
    ...(validateOptionalStringArray(record.grants, `${label}.grants`)
      ? { grants: validateOptionalStringArray(record.grants, `${label}.grants`) }
      : {})
  };
}

export function validateProviderToolPolicyConfig(value: unknown, label = 'provider tool policy'): ProviderToolPolicyConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object when provided`);
  }
  const record = value as Record<string, unknown>;
  return {
    workspace: validateProviderToolPolicyProfileConfig(record.workspace, `${label}.workspace`),
    ephemeral: validateProviderToolPolicyProfileConfig(record.ephemeral, `${label}.ephemeral`)
  };
}

export function validateProviderResumeCursor(value: unknown, label = 'provider resume cursor'): ProviderResumeCursor | null {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object or null`);
  }
  const record = value as Record<string, unknown>;
  return {
    provider: validatePackageId(record.provider, `${label}.provider`),
    value: record.value
  };
}

export function validateRuntimeProviderSessionInput(value: unknown, label = 'provider session input'): RuntimeProviderSessionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const agentKind = parseRuntimeAgentKind(record.agentKind, `${label}.agentKind`);
  const workspacePath = record.workspacePath;
  if (workspacePath !== null && typeof workspacePath !== 'string') {
    throw new Error(`${label}.workspacePath must be a string or null`);
  }
  if (agentKind === 'workspace' && !workspacePath) {
    throw new Error(`${label}.workspacePath is required for workspace agents`);
  }
  if (agentKind === 'ephemeral' && workspacePath !== null) {
    throw new Error(`${label}.workspacePath must be null for ephemeral agents`);
  }
  const providerCwd = record.providerCwd;
  if (providerCwd !== null && typeof providerCwd !== 'string') {
    throw new Error(`${label}.providerCwd must be a string or null`);
  }
  return {
    sessionId: validateNonEmptyString(record.sessionId, `${label}.sessionId`),
    threadId: validateNonEmptyString(record.threadId, `${label}.threadId`),
    transportResourceId: validateNonEmptyString(record.transportResourceId, `${label}.transportResourceId`),
    runtimeMode: parseRuntimeModeName(record.runtimeMode, `${label}.runtimeMode`),
    agentKind,
    workspacePath,
    providerCwd,
    resumeCursor: validateProviderResumeCursor(record.resumeCursor, `${label}.resumeCursor`),
    lifecycleStatus: validateNonEmptyString(record.lifecycleStatus, `${label}.lifecycleStatus`),
    ...(record.providerAutoStartEnabled !== undefined ? { providerAutoStartEnabled: record.providerAutoStartEnabled !== false } : {}),
    toolGrantIds: validateOptionalStringArray(record.toolGrantIds, `${label}.toolGrantIds`) ?? [],
    toolPolicy: validateProviderToolPolicyConfig(record.toolPolicy, `${label}.toolPolicy`) ?? DEFAULT_PROVIDER_TOOL_POLICY
  };
}

export function validateProviderResourceBundle(value: unknown, label = 'provider resource bundle'): ProviderResourceBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const contextFiles = Array.isArray(record.contextFiles) ? record.contextFiles : [];
  const skills = Array.isArray(record.skills) ? record.skills : [];
  const promptTemplates = Array.isArray(record.promptTemplates) ? record.promptTemplates : [];
  return {
    systemPromptSections: validateOptionalStringArray(record.systemPromptSections, `${label}.systemPromptSections`) ?? [],
    contextFiles: contextFiles.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`${label}.contextFiles[${index}] must be an object`);
      }
      const file = entry as Record<string, unknown>;
      return {
        path: validateNonEmptyString(file.path, `${label}.contextFiles[${index}].path`),
        content: typeof file.content === 'string' ? file.content : validateNonEmptyString(file.content, `${label}.contextFiles[${index}].content`),
        source: validateNonEmptyString(file.source, `${label}.contextFiles[${index}].source`)
      };
    }),
    skills: skills.map((entry, index) => validateProviderSkillResource(entry, `${label}.skills[${index}]`)),
    promptTemplates: promptTemplates.map((entry, index) => validateProviderPromptTemplateResource(entry, `${label}.promptTemplates[${index}]`))
  };
}

function validateProviderSkillResource(value: unknown, label: string): ProviderSkillResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`${label}.metadata must be an object`);
  }
  return {
    name: validateNonEmptyString(record.name, `${label}.name`),
    description: validateNonEmptyString(record.description, `${label}.description`),
    filePath: validateNonEmptyString(record.filePath, `${label}.filePath`),
    baseDir: validateNonEmptyString(record.baseDir, `${label}.baseDir`),
    ...(record.content !== undefined ? { content: typeof record.content === 'string' ? record.content : validateNonEmptyString(record.content, `${label}.content`) } : {}),
    metadata: metadata as Record<string, unknown>
  };
}

function validateProviderPromptTemplateResource(value: unknown, label: string): ProviderPromptTemplateResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  return {
    name: validateNonEmptyString(record.name, `${label}.name`),
    ...(record.description !== undefined ? { description: validateNonEmptyString(record.description, `${label}.description`) } : {}),
    content: typeof record.content === 'string' ? record.content : validateNonEmptyString(record.content, `${label}.content`),
    source: validateNonEmptyString(record.source, `${label}.source`)
  };
}

export function validateProviderToolDefinition(value: unknown, label = 'provider tool definition'): ProviderToolDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const inputSchema = record.inputSchema;
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new Error(`${label}.inputSchema must be an object`);
  }
  if (record.source !== 'core' && record.source !== 'plugin') {
    throw new Error(`${label}.source must be "core" or "plugin"`);
  }
  return {
    id: validateNonEmptyString(record.id, `${label}.id`),
    name: validateNonEmptyString(record.name, `${label}.name`),
    description: validateNonEmptyString(record.description, `${label}.description`),
    inputSchema: inputSchema as Record<string, unknown>,
    ...(record.requiredCapability !== undefined ? { requiredCapability: record.requiredCapability as Capability } : {}),
    source: record.source,
    ...(record.ownerPackageId !== undefined ? { ownerPackageId: validatePackageId(record.ownerPackageId, `${label}.ownerPackageId`) } : {})
  };
}

function validateProviderNativeToolDocumentation(value: unknown, label: string): ProviderNativeToolDocumentation | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object when provided`);
  }
  const record = value as Record<string, unknown>;
  return {
    nativeToolNames: validateOptionalStringArray(record.nativeToolNames, `${label}.nativeToolNames`) ?? [],
    defaultWorkspacePreset: validateNonEmptyString(record.defaultWorkspacePreset, `${label}.defaultWorkspacePreset`),
    defaultEphemeralPreset: validateNonEmptyString(record.defaultEphemeralPreset, `${label}.defaultEphemeralPreset`),
    grantMapping: validateNonEmptyString(record.grantMapping, `${label}.grantMapping`)
  };
}

export function validateProviderPackageRuntimeContract(pkg: RuntimeProviderPackage): void {
  if (typeof pkg.createProviderFactory !== 'function') {
    throw new Error(`Provider package ${pkg.manifest.id} must implement createProviderFactory`);
  }
  if (pkg.createEnvironmentVerifier !== undefined && typeof pkg.createEnvironmentVerifier !== 'function') {
    throw new Error(`Provider package ${pkg.manifest.id} exported invalid createEnvironmentVerifier`);
  }
}
