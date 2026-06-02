import type { JsonSchemaLike, PackageDependency, PackageManifestBase } from './package.js';
import { validateJsonSchemaLike, validatePackageActivationRule, validatePackageDependencies, validatePackageId } from './package.js';
import { isCapability, packageOwnsCapability, type Capability } from './capabilities.js';
import type { RuntimeActionDefinition } from './transport.js';

export interface PluginManifest extends PackageManifestBase {
  type: 'plugin';
  entrypoint?: string;
  priority?: number;
  capabilities: Capability[];
  hooks?: string[];
  defaultEnabled?: boolean;
  dependencies?: PackageDependency[];
  configSchema?: JsonSchemaLike;
  displayCategory?: string;
}

export interface RuntimeManagementContribution {
  id: string;
  title: string;
  surface: 'cli';
  packageId: string;
  placement: 'overview' | 'control' | 'work' | 'packages' | 'health' | 'settings';
  kind: 'action' | 'form' | 'status_card' | 'table' | 'link';
  requiredCapability?: Capability;
  inputSchema?: Record<string, unknown>;
  executeActionId?: string;
  readModelSelector?: string;
}

export type { RuntimeActionDefinition };

export * from './plugin-runtime.js';

export const KNOWN_PLUGIN_HOOKS = [
  'onRuntimeStarted',
  'onTransportEvent',
  'onExternalEvent',
  'onAction',
  'onRuntimeEvent',
  'beforeAgentPrompt',
  'afterAgentResponse',
  'onDomainEvent',
  'onRuntimeReceipt',
  'onRuntimeActivity'
] as const;

const KNOWN_PLUGIN_HOOK_SET = new Set<string>(KNOWN_PLUGIN_HOOKS);
export function validatePluginManifest(manifest: PluginManifest): PluginManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Plugin manifest must be an object');
  }
  const record = manifest as unknown as Record<string, unknown>;
  validatePackageId(record.id, 'Plugin manifest id');
  if (typeof record.name !== 'string' || !record.name.trim()) {
    throw new Error('Plugin manifest name is required');
  }
  if (typeof record.version !== 'string' || !record.version.trim()) {
    throw new Error('Plugin manifest version is required');
  }
  if (record.type !== 'plugin') {
    throw new Error('Plugin manifest type must be "plugin"');
  }
  if (record.description !== undefined && (typeof record.description !== 'string' || !record.description.trim())) {
    throw new Error('Plugin manifest description must be non-empty when provided');
  }
  if (record.entrypoint !== undefined && (typeof record.entrypoint !== 'string' || !record.entrypoint.trim())) {
    throw new Error('Plugin manifest entrypoint must be non-empty when provided');
  }
  if (record.priority !== undefined && (!Number.isInteger(record.priority) || (record.priority as number) < 0)) {
    throw new Error('Plugin manifest priority must be a non-negative integer when provided');
  }
  if (record.defaultEnabled !== undefined && typeof record.defaultEnabled !== 'boolean') {
    throw new Error('Plugin manifest defaultEnabled must be a boolean when provided');
  }
  if (
    record.displayCategory !== undefined &&
    (typeof record.displayCategory !== 'string' || !record.displayCategory.trim())
  ) {
    throw new Error('Plugin manifest displayCategory must be a non-empty string when provided');
  }
  if (!Array.isArray(record.capabilities) || record.capabilities.length === 0) {
    throw new Error('Plugin manifest capabilities must declare at least one capability');
  }
  validatePackageDependencies(record.dependencies, 'plugin manifest');
  validateJsonSchemaLike(record.configSchema, 'plugin manifest');
  const activation = validatePackageActivationRule(record.activation, 'plugin manifest');
  for (const capability of record.capabilities) {
    if (!isCapability(capability)) {
      throw new Error(`Unknown capability: ${capability}`);
    }
    if (!packageOwnsCapability(record.id as string, capability)) {
      throw new Error(`Package-local capability ${capability} is not owned by plugin ${record.id as string}`);
    }
  }
  if (record.hooks !== undefined && !Array.isArray(record.hooks)) {
    throw new Error('Plugin manifest hooks must be an array when provided');
  }
  for (const hook of (record.hooks as unknown[] | undefined) ?? []) {
    if (typeof hook !== 'string' || !hook.trim()) {
      throw new Error('Plugin manifest hooks must be non-empty');
    }
    if (!KNOWN_PLUGIN_HOOK_SET.has(hook)) {
      throw new Error(`Unknown plugin hook: ${hook}`);
    }
  }
  return {
    ...manifest,
    ...(activation !== undefined ? { activation } : {})
  };
}
