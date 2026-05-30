export type PackageRuntimeKind = 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill';
export type PackageSurface = PackageRuntimeKind;
export type PackageKind = PackageRuntimeKind | 'bundle';
export type PackageFamily = 'installable' | 'addon' | 'bundle';

export type PackageRequirementState = 'installed' | 'active';
export type PackageRuntimeState = 'not_installed' | 'deactivated' | 'activated';

export interface PackageRef {
  surface: PackageSurface;
  packageId: string;
}

export interface PackageActivationRule {
  uniqueKey?: string;
}

export interface JsonSchemaLike {
  type: 'object';
  properties?: Record<
    string,
    {
      type?: 'string' | 'boolean' | 'number';
      title?: string;
      description?: string;
      default?: string | boolean | number;
      enum?: Array<string | boolean | number>;
      secret?: boolean;
    }
  >;
  required?: string[];
}

export interface PackageDependency {
  kind?: PackageRuntimeKind;
  surface: PackageSurface;
  packageId: string;
  versionRange?: string;
  requiredState: PackageRequirementState;
  reason?: string;
}

export type BundleMemberActivation = 'install' | 'select' | 'enable';

export interface PackageBundleMember {
  kind: PackageRuntimeKind;
  surface?: PackageSurface;
  packageId: string;
  version: string;
  activation: BundleMemberActivation;
  source?: PackageSourceDescriptor;
  optional?: boolean;
  reason?: string;
}

export type PackageSourceProvenance =
  | {
      type: 'github_release';
      repository?: string;
      releaseRef?: string;
      assetName?: string;
    }
  | {
      type: 'npm';
      registryUrl: string;
      packageName: string;
      version: string;
      integrity?: string;
    }
  | {
      type: 'direct_url';
    };

export type PackageSourceDescriptor =
  | {
      kind: 'local_dir';
      path: string;
    }
  | {
      kind: 'local_archive';
      path: string;
    }
  | {
      kind: 'remote_archive';
      url: string;
      sha256?: string;
      integrity?: string;
      provenance?: PackageSourceProvenance;
    };

export interface PackageManifestBase {
  id: string;
  name: string;
  version: string;
  description?: string;
  dependencies?: PackageDependency[];
  configSchema?: JsonSchemaLike;
  displayCategory?: string;
  activation?: PackageActivationRule;
}

export function packageFamilyForKind(kind: PackageKind): PackageFamily {
  if (kind === 'bundle') {
    return 'bundle';
  }
  return kind === 'skill' ? 'addon' : 'installable';
}

export function packageFamilyForSurface(surface: PackageSurface): PackageFamily {
  return packageFamilyForKind(surface);
}

const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62})\/[a-z0-9](?:[a-z0-9._-]{0,62})$/u;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string when provided`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be non-empty when provided`);
  }
  return normalized;
}

function isJsonSchemaType(value: unknown): value is 'string' | 'boolean' | 'number' {
  return value === 'string' || value === 'boolean' || value === 'number';
}

export function validatePackageId(packageId: unknown, label: string): string {
  if (typeof packageId !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  const normalized = packageId.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  if (!PACKAGE_ID_PATTERN.test(normalized)) {
    throw new Error(
      `${label} must match <namespace>/<name> using lowercase letters, numbers, ".", "_" or "-". Received: ${packageId}`
    );
  }
  return normalized;
}

export function validatePackageActivationRule(rule: unknown, label: string): PackageActivationRule | undefined {
  if (rule === undefined) {
    return undefined;
  }
  const record = asRecord(rule);
  if (!record) {
    throw new Error(`${label}.activation must be an object when provided`);
  }
  const uniqueKey = optionalNonEmptyString(record.uniqueKey, `${label}.activation.uniqueKey`);
  return {
    ...(uniqueKey !== undefined ? { uniqueKey } : {})
  };
}

export function validatePackageDependencies(
  dependencies: unknown,
  label: string
): PackageDependency[] {
  if (dependencies === undefined) {
    return [];
  }
  if (!Array.isArray(dependencies)) {
    throw new Error(`${label}.dependencies must be an array when provided`);
  }
  return dependencies.map((entry, index) => {
    const dependency = asRecord(entry);
    if (!dependency) {
      throw new Error(`${label}.dependencies[${index}] must be an object`);
    }
    const packageId = validatePackageId(dependency.packageId, `${label}.dependencies[${index}].packageId`);
    const rawKind = dependency.kind ?? dependency.surface;
    if (
      rawKind !== 'api-adapter' &&
      rawKind !== 'transport' &&
      rawKind !== 'provider' &&
      rawKind !== 'plugin' &&
      rawKind !== 'skill'
    ) {
      throw new Error(`${label}.dependencies[${index}].kind must be one of: api-adapter, transport, provider, plugin, skill`);
    }
    if (dependency.requiredState !== 'installed' && dependency.requiredState !== 'active') {
      throw new Error(`${label}.dependencies[${index}].requiredState must be "installed" or "active"`);
    }
    const versionRange = optionalNonEmptyString(dependency.versionRange, `${label}.dependencies[${index}].versionRange`);
    const reason = optionalNonEmptyString(dependency.reason, `${label}.dependencies[${index}].reason`);
    return {
      kind: rawKind,
      surface: rawKind,
      packageId,
      requiredState: dependency.requiredState,
      ...(versionRange !== undefined ? { versionRange } : {}),
      ...(reason !== undefined ? { reason } : {})
    };
  });
}

function validatePackageRuntimeKind(value: unknown, label: string): PackageRuntimeKind {
  if (value === 'api-adapter' || value === 'transport' || value === 'provider' || value === 'plugin' || value === 'skill') {
    return value;
  }
  throw new Error(`${label} must be one of: api-adapter, transport, provider, plugin, skill`);
}

function validatePackageSourceDescriptor(value: unknown, label: string): PackageSourceDescriptor | undefined {
  if (value === undefined) {
    return undefined;
  }
  const source = asRecord(value);
  if (!source) {
    throw new Error(`${label} must be an object when provided`);
  }
  if (source.kind === 'local_dir') {
    return {
      kind: 'local_dir',
      path: requireNonEmptyString(source.path, `${label}.path`)
    };
  }
  if (source.kind === 'local_archive') {
    return {
      kind: 'local_archive',
      path: requireNonEmptyString(source.path, `${label}.path`)
    };
  }
  if (source.kind === 'remote_archive') {
    const provenance = source.provenance;
    return {
      kind: 'remote_archive',
      url: requireNonEmptyString(source.url, `${label}.url`),
      ...(optionalNonEmptyString(source.sha256, `${label}.sha256`) ? { sha256: optionalNonEmptyString(source.sha256, `${label}.sha256`) } : {}),
      ...(optionalNonEmptyString(source.integrity, `${label}.integrity`) ? { integrity: optionalNonEmptyString(source.integrity, `${label}.integrity`) } : {}),
      ...(provenance && typeof provenance === 'object' && !Array.isArray(provenance)
        ? { provenance: provenance as PackageSourceProvenance }
        : {})
    };
  }
  throw new Error(`${label}.kind must be one of: local_dir, local_archive, remote_archive`);
}

export function validatePackageBundleMembers(members: unknown, label: string): PackageBundleMember[] {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error(`${label}.members must declare at least one package`);
  }
  return members.map((entry, index) => {
    const member = asRecord(entry);
    if (!member) {
      throw new Error(`${label}.members[${index}] must be an object`);
    }
    const kind = validatePackageRuntimeKind(member.kind ?? member.surface, `${label}.members[${index}].kind`);
    const packageId = validatePackageId(member.packageId, `${label}.members[${index}].packageId`);
    const version = optionalNonEmptyString(member.version, `${label}.members[${index}].version`) ?? '*';
    const activation = member.activation;
    if (activation !== 'install' && activation !== 'select' && activation !== 'enable') {
      throw new Error(`${label}.members[${index}].activation must be one of: install, select, enable`);
    }
    if (activation === 'select' && kind !== 'api-adapter' && kind !== 'transport' && kind !== 'provider') {
      throw new Error(`${label}.members[${index}].activation select is only valid for api-adapter, transport, or provider packages`);
    }
    if (activation === 'enable' && kind !== 'plugin' && kind !== 'skill') {
      throw new Error(`${label}.members[${index}].activation enable is only valid for plugin or skill packages`);
    }
    if (member.optional !== undefined && typeof member.optional !== 'boolean') {
      throw new Error(`${label}.members[${index}].optional must be a boolean when provided`);
    }
    const reason = optionalNonEmptyString(member.reason, `${label}.members[${index}].reason`);
    const source = validatePackageSourceDescriptor(member.source, `${label}.members[${index}].source`);
    return {
      kind,
      surface: kind,
      packageId,
      version,
      activation,
      ...(source ? { source } : {}),
      ...(member.optional !== undefined ? { optional: member.optional } : {}),
      ...(reason !== undefined ? { reason } : {})
    };
  });
}

export function validateJsonSchemaLike(schema: unknown, label: string): JsonSchemaLike | undefined {
  if (schema === undefined) {
    return undefined;
  }
  const schemaRecord = asRecord(schema);
  if (!schemaRecord || schemaRecord.type !== 'object') {
    throw new Error(`${label}.configSchema must be an object schema when provided`);
  }
  if (schemaRecord.required !== undefined && !Array.isArray(schemaRecord.required)) {
    throw new Error(`${label}.configSchema.required must be an array when provided`);
  }
  if (Array.isArray(schemaRecord.required)) {
    for (const [index, required] of schemaRecord.required.entries()) {
      requireNonEmptyString(required, `${label}.configSchema.required[${index}]`);
    }
  }
  const properties = schemaRecord.properties;
  const normalizedProperties: JsonSchemaLike['properties'] = {};
  if (properties !== undefined) {
    const propertiesRecord = asRecord(properties);
    if (!propertiesRecord) {
      throw new Error(`${label}.configSchema.properties must be an object when provided`);
    }
    for (const [key, value] of Object.entries(propertiesRecord)) {
      const property = asRecord(value);
      if (!property) {
        throw new Error(`${label}.configSchema.properties.${key} must be an object`);
      }
      if (property.type !== undefined && !isJsonSchemaType(property.type)) {
        throw new Error(`${label}.configSchema.properties.${key}.type is invalid`);
      }
      const title = optionalNonEmptyString(property.title, `${label}.configSchema.properties.${key}.title`);
      const description = optionalNonEmptyString(property.description, `${label}.configSchema.properties.${key}.description`);
      if (property.enum !== undefined) {
        if (!Array.isArray(property.enum)) {
          throw new Error(`${label}.configSchema.properties.${key}.enum must be an array`);
        }
        for (const enumValue of property.enum) {
          if (typeof enumValue !== 'string' && typeof enumValue !== 'boolean' && typeof enumValue !== 'number') {
            throw new Error(`${label}.configSchema.properties.${key}.enum must contain string, boolean, or number values`);
          }
        }
      }
      if (property.secret !== undefined && typeof property.secret !== 'boolean') {
        throw new Error(`${label}.configSchema.properties.${key}.secret must be a boolean when provided`);
      }
      if (property.default !== undefined && typeof property.default !== 'string' && typeof property.default !== 'boolean' && typeof property.default !== 'number') {
        throw new Error(`${label}.configSchema.properties.${key}.default must be a string, boolean, or number when provided`);
      }
      normalizedProperties[key] = {
        ...(property.type !== undefined ? { type: property.type } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(property.default !== undefined ? { default: property.default } : {}),
        ...(property.enum !== undefined ? { enum: property.enum as Array<string | boolean | number> } : {}),
        ...(property.secret !== undefined ? { secret: property.secret } : {})
      };
    }
  }
  return {
    type: 'object',
    ...(Object.keys(normalizedProperties).length > 0 ? { properties: normalizedProperties } : {}),
    ...(Array.isArray(schemaRecord.required)
      ? {
          required: schemaRecord.required.map((value) => String(value).trim())
        }
      : {})
  };
}
