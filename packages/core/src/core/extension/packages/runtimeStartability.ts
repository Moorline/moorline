import { configuredApiAdapterConfig, type MoorlineConfig } from '../../../types/config.js';
import type { JsonSchemaLike, PackageDesiredState } from '../../../types/package.js';
import { activatedPackageForUniqueKey, desiredPackageRefsFromConfig, isBuiltInActivatedPackage } from './packageActivation.js';
import { resolvePackageConfigSchema } from './packageConfigSchema.js';
import { resolvePackageDependencyErrors } from './packageDependencyResolver.js';
import type { PackageInventoryState } from './packageInventoryStore.js';

interface RuntimeStartabilityCheck {
  startable: boolean;
  issues: string[];
}

function desiredStateFromConfig(config: MoorlineConfig): PackageDesiredState {
  return {
    activated: desiredPackageRefsFromConfig(config)
  };
}

function buildInstalledLookup(inventory: PackageInventoryState): {
  'api-adapter': Set<string>;
  transport: Set<string>;
  provider: Set<string>;
  plugin: Set<string>;
  skill: Set<string>;
} {
  const lookup = {
    'api-adapter': new Set<string>(),
    transport: new Set<string>(),
    provider: new Set<string>(),
    plugin: new Set<string>(),
    skill: new Set<string>()
  };
  for (const entry of inventory.installed) {
    const kind = entry.kind ?? entry.surface;
    if (kind !== 'bundle') {
      lookup[kind].add(entry.packageId);
    }
  }
  return lookup;
}

type SchemaProperty = NonNullable<JsonSchemaLike['properties']>[string];

function schemaTypeMatches(type: SchemaProperty['type'], value: unknown): boolean {
  if (type === 'boolean') {
    return typeof value === 'boolean';
  }
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (type === 'string') {
    return typeof value === 'string';
  }
  return true;
}

function isMissingValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0);
}

function effectiveSurfaceConfig(
  config: MoorlineConfig,
  surface: 'api-adapter' | 'transport' | 'provider',
  packageId: string
): Record<string, unknown> {
  if (surface === 'api-adapter') {
    const legacyNested = config.surfaces.apiAdapter.config[packageId];
    const root = legacyNested && typeof legacyNested === 'object' && !Array.isArray(legacyNested)
      ? legacyNested as Record<string, unknown>
      : config.surfaces.apiAdapter.config;
    return {
      ...root,
      ...(config.surfaces.apiAdapter.configByPackageId?.[packageId] ?? {})
    };
  }
  if (surface === 'transport') {
    return {
      ...config.surfaces.transport.config,
      ...(config.surfaces.transport.configByPackageId?.[packageId] ?? {})
    };
  }
  return {
    ...config.surfaces.provider.config,
    ...(config.surfaces.provider.configByPackageId?.[packageId] ?? {})
  };
}

function validateSurfaceConfigAgainstSchema(input: {
  surface: 'api-adapter' | 'transport' | 'provider';
  packageId: string;
  schema: JsonSchemaLike | undefined;
  config: Record<string, unknown>;
  allowUnknownConfigKeys?: boolean;
}): string[] {
  const { schema } = input;
  if (!schema?.properties) {
    return [];
  }

  const issues: string[] = [];
  const knownKeys = new Set(Object.keys(schema.properties));

  for (const key of Object.keys(input.config)) {
    if (!input.allowUnknownConfigKeys && !knownKeys.has(key)) {
      issues.push(`${input.surface} config key ${key} is not declared by ${input.packageId}.`);
    }
  }

  for (const key of schema.required ?? []) {
    if (isMissingValue(input.config[key])) {
      issues.push(`${input.surface} config key ${key} is required for ${input.packageId}.`);
    }
  }

  for (const [key, property] of Object.entries(schema.properties)) {
    const value = input.config[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (!schemaTypeMatches(property.type, value)) {
      const expectedType = property.type ?? 'declared schema type';
      issues.push(`${input.surface} config key ${key} must be a ${expectedType}.`);
      continue;
    }
    if (property.enum && !property.enum.some((entry) => entry === value)) {
      issues.push(
        `${input.surface} config key ${key} must be one of: ${property.enum.map((entry) => String(entry)).join(', ')}.`
      );
    }
  }

  return issues;
}

export function coerceSurfaceConfigInput(input: {
  surface: 'transport' | 'provider';
  packageId: string;
  schema: JsonSchemaLike | undefined;
  key: string;
  rawValue: string;
}): string | boolean | number {
  if (!input.schema?.properties) {
    return input.rawValue;
  }

  const property = input.schema.properties[input.key];
  if (!property) {
    throw new Error(`Unknown ${input.surface} config key ${input.key} for ${input.packageId}.`);
  }

  const required = new Set(input.schema.required ?? []);
  const trimmed = input.rawValue.trim();
  if (required.has(input.key) && trimmed.length === 0) {
    throw new Error(`${input.surface} config key ${input.key} is required.`);
  }

  let value: string | boolean | number = input.rawValue;

  if (property.type === 'boolean') {
    if (trimmed === 'true') {
      value = true;
    } else if (trimmed === 'false') {
      value = false;
    } else {
      throw new Error(`${input.surface} config key ${input.key} must be "true" or "false".`);
    }
  } else if (property.type === 'number') {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${input.surface} config key ${input.key} must be a finite number.`);
    }
    value = parsed;
  }

  if (property.enum && !property.enum.some((entry) => entry === value)) {
    throw new Error(
      `${input.surface} config key ${input.key} must be one of: ${property.enum.map((entry) => String(entry)).join(', ')}.`
    );
  }

  return value;
}

export function evaluateRuntimeStartability(config: MoorlineConfig, inventory: PackageInventoryState): RuntimeStartabilityCheck {
  const desired = desiredStateFromConfig(config);
  const installedLookup = buildInstalledLookup(inventory);
  const issueSet = new Set<string>();
  const issues: string[] = [];
  const addIssue = (issue: string) => {
    if (!issueSet.has(issue)) {
      issueSet.add(issue);
      issues.push(issue);
    }
  };

  const activeTransport = activatedPackageForUniqueKey(desired.activated, 'transport');
  const activeProvider = activatedPackageForUniqueKey(desired.activated, 'provider');
  const activeApiAdapter = activatedPackageForUniqueKey(desired.activated, 'api-adapter');

  if (!activeTransport) {
    addIssue('No transport package is activated.');
  } else if (!installedLookup.transport.has(activeTransport.packageId)) {
    addIssue(`Activated transport package ${activeTransport.packageId} is not installed.`);
  }

  if (!activeProvider) {
    addIssue('No provider package is activated.');
  } else if (!installedLookup.provider.has(activeProvider.packageId)) {
    addIssue(`Activated provider package ${activeProvider.packageId} is not installed.`);
  }

  if (!activeApiAdapter) {
    addIssue('No API adapter package is activated.');
  }

  const dependencyErrors = resolvePackageDependencyErrors({
    installed: inventory.installed,
    desired,
    applied: inventory.applied
  });
  for (const error of dependencyErrors) {
    addIssue(error.detail);
  }

  for (const ref of desired.activated) {
    if (isBuiltInActivatedPackage(ref)) {
      continue;
    }
    if (!installedLookup[ref.surface].has(ref.packageId)) {
      addIssue(`Activated ${ref.surface} package ${ref.packageId} is not installed.`);
    }
  }

  if (activeApiAdapter && (installedLookup['api-adapter'].has(activeApiAdapter.packageId) || isBuiltInActivatedPackage(activeApiAdapter))) {
    const schema = resolvePackageConfigSchema({
      runtimeRoot: config.runtimeRoot,
      surface: 'api-adapter',
      packageId: activeApiAdapter.packageId
    });
    for (const issue of validateSurfaceConfigAgainstSchema({
        surface: 'api-adapter',
        packageId: activeApiAdapter.packageId,
        schema,
        config: effectiveSurfaceConfig(config, 'api-adapter', activeApiAdapter.packageId),
        allowUnknownConfigKeys: isBuiltInActivatedPackage(activeApiAdapter)
      })) {
      addIssue(issue);
    }
    if (activeApiAdapter.packageId === 'official/http') {
      try {
        configuredApiAdapterConfig(config, activeApiAdapter.packageId);
      } catch (error) {
        addIssue(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (activeTransport && installedLookup.transport.has(activeTransport.packageId)) {
    const schema = resolvePackageConfigSchema({
      runtimeRoot: config.runtimeRoot,
      surface: 'transport',
      packageId: activeTransport.packageId
    });
    for (const issue of validateSurfaceConfigAgainstSchema({
        surface: 'transport',
        packageId: activeTransport.packageId,
        schema,
        config: effectiveSurfaceConfig(config, 'transport', activeTransport.packageId)
      })) {
      addIssue(issue);
    }
  }

  if (activeProvider && installedLookup.provider.has(activeProvider.packageId)) {
    const schema = resolvePackageConfigSchema({
      runtimeRoot: config.runtimeRoot,
      surface: 'provider',
      packageId: activeProvider.packageId
    });
    for (const issue of validateSurfaceConfigAgainstSchema({
        surface: 'provider',
        packageId: activeProvider.packageId,
        schema,
        config: effectiveSurfaceConfig(config, 'provider', activeProvider.packageId)
      })) {
      addIssue(issue);
    }
  }

  return {
    startable: issues.length === 0,
    issues
  };
}
