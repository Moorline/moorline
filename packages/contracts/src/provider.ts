import type { JsonSchemaLike, PackageDependency, PackageManifestBase } from './package.js';
import { validateJsonSchemaLike, validatePackageActivationRule, validatePackageDependencies, validatePackageId } from './package.js';
import type { EventEmitter } from 'node:events';
import type {
  ProviderPackageId,
  ProviderInputImage,
  ProviderRuntimeEvent,
  ProviderSessionRecord,
  RuntimeCommandRunner,
  RuntimeModeName
} from './runtime.js';

export interface ProviderPackageManifest extends PackageManifestBase {
  type: 'provider';
  entrypoint?: string;
  dependencies?: PackageDependency[];
  configSchema?: JsonSchemaLike;
  displayCategory?: string;
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
  workspacePath: string;
  resumeThreadId: string | null;
  lifecycleStatus: string;
  providerAutoStartEnabled?: boolean;
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
  sendTurn(threadId: string, input: { text: string; images?: ProviderInputImage[] }, model?: string): Promise<{ turnId: string }>;
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
  const activation = validatePackageActivationRule(record.activation, 'provider package manifest');
  return {
    ...manifest,
    ...(activation !== undefined ? { activation } : {})
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
