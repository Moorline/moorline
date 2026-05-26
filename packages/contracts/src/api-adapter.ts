import type { JsonSchemaLike, PackageDependency, PackageManifestBase } from './package.js';
import { validateJsonSchemaLike, validatePackageActivationRule, validatePackageDependencies, validatePackageId } from './package.js';

export interface ApiAdapterPackageManifest extends PackageManifestBase {
  type: 'api-adapter';
  entrypoint?: string;
  dependencies?: PackageDependency[];
  configSchema?: JsonSchemaLike;
  displayCategory?: string;
}

export interface RuntimeApiEndpoint {
  protocol: string;
  url: string;
  token?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeApiAdapterContext {
  configPath?: string;
  entrypoint: string;
  host: string;
  port: number;
  config: Record<string, unknown>;
}

export interface RuntimeApiAdapter {
  start(): Promise<{ endpoints: RuntimeApiEndpoint[] }>;
  stop(): Promise<void>;
}

export interface RuntimeApiAdapterPackage {
  manifest: ApiAdapterPackageManifest;
  createAdapter(input: RuntimeApiAdapterContext): RuntimeApiAdapter;
}

export function validateApiAdapterPackageManifest(manifest: ApiAdapterPackageManifest): ApiAdapterPackageManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('API adapter package manifest must be an object');
  }
  const record = manifest as unknown as Record<string, unknown>;
  validatePackageId(record.id, 'API adapter package manifest id');
  if (typeof record.name !== 'string' || !record.name.trim()) {
    throw new Error('API adapter package manifest name is required');
  }
  if (typeof record.version !== 'string' || !record.version.trim()) {
    throw new Error('API adapter package manifest version is required');
  }
  if (record.type !== 'api-adapter') {
    throw new Error('API adapter package manifest type must be "api-adapter"');
  }
  if (record.description !== undefined && (typeof record.description !== 'string' || !record.description.trim())) {
    throw new Error('API adapter package manifest description must be non-empty when provided');
  }
  if (record.entrypoint !== undefined && (typeof record.entrypoint !== 'string' || !record.entrypoint.trim())) {
    throw new Error('API adapter package manifest entrypoint must be non-empty when provided');
  }
  if (
    record.displayCategory !== undefined &&
    (typeof record.displayCategory !== 'string' || !record.displayCategory.trim())
  ) {
    throw new Error('API adapter package manifest displayCategory must be non-empty when provided');
  }
  validatePackageDependencies(record.dependencies, 'api adapter package manifest');
  validateJsonSchemaLike(record.configSchema, 'api adapter package manifest');
  const activation = validatePackageActivationRule(record.activation, 'api adapter package manifest');
  return {
    ...manifest,
    ...(activation !== undefined ? { activation } : {})
  };
}

export function validateApiAdapterPackageRuntimeContract(pkg: RuntimeApiAdapterPackage): void {
  if (typeof pkg.createAdapter !== 'function') {
    throw new Error(`API adapter package ${pkg.manifest.id} must implement createAdapter`);
  }
}
