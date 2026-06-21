import type { JsonSchemaLike, PackageDependency, PackageManifestBase } from './package.js';
import { validateJsonSchemaLike, validatePackageActivationRule, validatePackageDependencies, validatePackageId } from './package.js';
import type { RuntimeCommandRunner, RuntimeModeName } from './runtime.js';
import type { RuntimeExternalResourceRef } from './external.js';

export type RuntimeScopeId = string;
export type RuntimeTransportResourceId = string;
export type RuntimeThreadId = string;

export interface ManagedAdminAccessGroupConfig {
  enabled: boolean;
  name: string;
}

export interface ManagedMemberAccessGroupConfig {
  enabled: boolean;
  name: string;
}

export type RuntimeAccessGroupKind = 'admin' | 'member';

export interface RuntimeAccessGroupRecord {
  id: string;
  kind: RuntimeAccessGroupKind;
  name: string;
  syncedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeAccessGroupInput {
  scopeId: RuntimeScopeId;
  kind: RuntimeAccessGroupKind;
  name: string;
  previousId?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSurfaceState {
  scopeId?: string;
  surfaceId: string;
  statusResourceId?: string;
  coordinationResourceId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSurfaceBootstrapInput {
  scopeId?: RuntimeScopeId;
  actorId?: string;
  managedAdminAccessGroup?: ManagedAdminAccessGroupConfig;
  managedMemberAccessGroup?: ManagedMemberAccessGroupConfig;
  explicitAdminRoleIds?: string[];
  explicitAdminUserIds?: string[];
  previousState: RuntimeSurfaceState | null;
  nowIso: string;
  config?: Record<string, unknown>;
}

export interface RuntimeActorIdentity {
  actorId: string;
  displayName?: string;
  accessGroupIds?: string[];
  isSurfaceAdmin?: boolean;
  transportMetadata?: Record<string, unknown>;
}

export interface RuntimeTransportResourceRecord {
  id: RuntimeTransportResourceId;
  name: string;
  kind: 'root' | 'collection' | 'conversation' | 'item' | 'direct' | 'external';
  parentId: RuntimeTransportResourceId | null;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTransportSessionOwner {
  kind: 'run' | 'work_item' | 'external_resource' | 'operator';
  id: string;
  label?: string;
}

export interface RuntimeAttachmentPayload {
  kind: 'file' | 'image' | 'link';
  path?: string;
  url?: string;
  name?: string;
  description?: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeMessageBlock {
  kind: 'text' | 'section' | 'fields' | 'notice';
  text?: string;
  title?: string;
  fields?: Array<{ label: string; value: string; inline?: boolean }>;
  tone?: 'default' | 'info' | 'success' | 'warning' | 'danger';
  metadata?: Record<string, unknown>;
}

export interface RuntimeActionReference {
  actionId: string;
  label: string;
  style?: 'primary' | 'secondary' | 'success' | 'danger';
  input?: Record<string, unknown>;
  disabled?: boolean;
}

export interface RuntimeMessagePayload {
  text?: string;
  blocks?: RuntimeMessageBlock[];
  attachments?: RuntimeAttachmentPayload[];
  actions?: RuntimeActionReference[];
  metadata?: Record<string, unknown>;
}

export interface RuntimeMessageReceipt {
  id: string;
  nativeId?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeInboundMessage {
  id?: string;
  text: string;
  attachments?: RuntimeAttachmentPayload[];
  metadata?: Record<string, unknown>;
}

export interface RuntimeNativeInteraction {
  kind: string;
  id?: string;
  payload?: unknown;
}

export interface RuntimeTransportIntentBase {
  intentId: string;
  scopeId: RuntimeScopeId;
  transportPackageId?: string;
  occurredAt: string;
  native?: RuntimeNativeInteraction;
  metadata?: Record<string, unknown>;
}

export type RuntimeTransportIntent =
  | {
      type: 'transport.message.received';
      transportResourceId: RuntimeTransportResourceId;
      actor: RuntimeActorIdentity;
      message: RuntimeInboundMessage;
    } & RuntimeTransportIntentBase
  | {
      type: 'transport.action.invoked';
      transportResourceId?: RuntimeTransportResourceId;
      actor: RuntimeActorIdentity;
      actionId: string;
      input: Record<string, unknown>;
    } & RuntimeTransportIntentBase
  | {
      type: 'transport.session.ensure';
      transportResourceId: RuntimeTransportResourceId;
      requestedName: string;
      actor?: RuntimeActorIdentity;
      runtimeMode?: RuntimeModeName;
      initialMessage?: RuntimeInboundMessage;
      owner?: RuntimeTransportSessionOwner;
    } & RuntimeTransportIntentBase
  | {
      type: 'transport.session.delete';
      transportResourceId: RuntimeTransportResourceId;
      actor?: RuntimeActorIdentity;
      reason: string;
      deleteWorkspace: boolean;
    } & RuntimeTransportIntentBase
  | {
      type: 'transport.session.archive';
      transportResourceId: RuntimeTransportResourceId;
      actor?: RuntimeActorIdentity;
      reason: string;
    } & RuntimeTransportIntentBase
  | {
      type: 'transport.session.resume';
      transportResourceId: RuntimeTransportResourceId;
      actor?: RuntimeActorIdentity;
      reason: string;
    } & RuntimeTransportIntentBase
  | {
      type: 'transport.resource.observed';
      resource: RuntimeTransportResourceRecord;
      action: 'created' | 'updated' | 'deleted';
      previous?: Partial<RuntimeTransportResourceRecord>;
    } & RuntimeTransportIntentBase
  | {
      type: 'transport.external.received';
      actor?: RuntimeActorIdentity;
      source: string;
      eventName: string;
      resource?: RuntimeExternalResourceRef;
      payload: unknown;
      receivedAt: string;
      idempotencyKey?: string;
    } & RuntimeTransportIntentBase;

export interface RuntimeTransportAccessInput {
  authToken?: string;
  scopeId: RuntimeScopeId;
  applicationId?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTransportVerification {
  scopeId: RuntimeScopeId;
  scopeName: string;
  actorId: string;
  actorName: string;
  applicationId?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTransportAuth {
  token?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeMessageTarget {
  scopeId?: RuntimeScopeId;
  transportResourceId: RuntimeTransportResourceId;
  threadId?: RuntimeThreadId;
}

export interface RuntimeTransportCapabilities {
  nativeActions: boolean;
  resources: {
    list: boolean;
    create: boolean;
    update: boolean;
    delete: boolean;
  };
  presence: boolean;
  maxMessageTextLength?: number;
  maxAttachmentBytes?: number;
  metadata?: Record<string, unknown>;
}

export interface RuntimeCreateTransportResourceInput {
  scopeId: RuntimeScopeId;
  name: string;
  kind: RuntimeTransportResourceRecord['kind'];
  parentId?: RuntimeTransportResourceId | null;
  metadata?: Record<string, unknown>;
}

export interface RuntimeUpdateTransportResourceInput {
  scopeId: RuntimeScopeId;
  transportResourceId: RuntimeTransportResourceId;
  name?: string;
  parentId?: RuntimeTransportResourceId | null;
  metadata?: Record<string, unknown>;
}

export interface RuntimeDeleteTransportResourceInput {
  scopeId: RuntimeScopeId;
  transportResourceId: RuntimeTransportResourceId;
}

export interface RuntimePresenceInput {
  scopeId?: RuntimeScopeId;
  transportResourceId?: RuntimeTransportResourceId;
  status: 'online' | 'idle' | 'busy' | 'offline';
  text?: string;
}

export interface RuntimeNativeActionRegistration {
  scopeId: RuntimeScopeId;
  actions: RuntimeActionDefinition[];
}

export type RuntimeTransportEffect =
  | {
      type: 'transport.message.send';
      target: RuntimeMessageTarget;
      payload: RuntimeMessagePayload;
    } & RuntimeTransportEffectBase
  | {
      type: 'transport.resource.create';
      input: RuntimeCreateTransportResourceInput;
    } & RuntimeTransportEffectBase
  | {
      type: 'transport.resource.update';
      input: RuntimeUpdateTransportResourceInput;
    } & RuntimeTransportEffectBase
  | {
      type: 'transport.resource.delete';
      input: RuntimeDeleteTransportResourceInput;
    } & RuntimeTransportEffectBase
  | {
      type: 'transport.presence.set';
      input: RuntimePresenceInput;
    } & RuntimeTransportEffectBase
  | {
      type: 'transport.actions.register';
      input: RuntimeNativeActionRegistration;
    } & RuntimeTransportEffectBase;

export interface RuntimeTransportEffectBase {
  effectId: string;
  scopeId?: RuntimeScopeId;
  createdAt: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTransportEffectReceipt {
  effectId: string;
  appliedAt: string;
  nativeId?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeActionDefinition {
  id: string;
  title: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  requiredCapability?: string;
  policy?: {
    allowedWhileDraining?: boolean;
    bypassQueue?: boolean;
  };
  metadata?: Record<string, unknown>;
}

export interface RuntimeTransport {
  verifyAccess(input: RuntimeTransportAccessInput): Promise<RuntimeTransportVerification>;
  start(auth: RuntimeTransportAuth): Promise<void>;
  stop(): Promise<void>;
  capabilities(): RuntimeTransportCapabilities;
  onIntent?(handler: (intent: RuntimeTransportIntent) => Promise<void>): void;
  applyEffect(effect: RuntimeTransportEffect): Promise<RuntimeTransportEffectReceipt>;
}

export interface TransportPackageManifest extends PackageManifestBase {
  type: 'transport';
  entrypoint?: string;
  dependencies?: PackageDependency[];
  configSchema?: JsonSchemaLike;
  displayCategory?: string;
}

export interface RuntimeTransportPackageContext {
  config: Record<string, unknown>;
  commandRunner?: RuntimeCommandRunner;
}

export interface RuntimeTransportConfigCompletionInput {
  config: Record<string, unknown>;
}

export interface RuntimeTransportConfigCompletionResult {
  config: Record<string, unknown>;
  warnings?: string[];
}

export interface RuntimeTransportPackage {
  manifest: TransportPackageManifest;
  createTransport(input: RuntimeTransportPackageContext): RuntimeTransport;
  completeConfig?(
    input: RuntimeTransportConfigCompletionInput
  ): RuntimeTransportConfigCompletionResult | Promise<RuntimeTransportConfigCompletionResult>;
}

export function validateTransportPackageManifest(manifest: TransportPackageManifest): TransportPackageManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Transport package manifest must be an object');
  }
  const record = manifest as unknown as Record<string, unknown>;
  validatePackageId(record.id, 'Transport package manifest id');
  if (typeof record.name !== 'string' || !record.name.trim()) {
    throw new Error('Transport package manifest name is required');
  }
  if (typeof record.version !== 'string' || !record.version.trim()) {
    throw new Error('Transport package manifest version is required');
  }
  if (record.type !== 'transport') {
    throw new Error('Transport package manifest type must be "transport"');
  }
  if (record.description !== undefined && (typeof record.description !== 'string' || !record.description.trim())) {
    throw new Error('Transport package manifest description must be non-empty when provided');
  }
  if (record.entrypoint !== undefined && (typeof record.entrypoint !== 'string' || !record.entrypoint.trim())) {
    throw new Error('Transport package manifest entrypoint must be non-empty when provided');
  }
  if (
    record.displayCategory !== undefined &&
    (typeof record.displayCategory !== 'string' || !record.displayCategory.trim())
  ) {
    throw new Error('Transport package manifest displayCategory must be non-empty when provided');
  }
  validatePackageDependencies(record.dependencies, 'transport package manifest');
  validateJsonSchemaLike(record.configSchema, 'transport package manifest');
  const activation = validatePackageActivationRule(record.activation, 'transport package manifest');
  return {
    ...manifest,
    ...(activation !== undefined ? { activation } : {})
  };
}

export function validateTransportPackageRuntimeContract(pkg: RuntimeTransportPackage): void {
  if (typeof pkg.createTransport !== 'function') {
    throw new Error(`Transport package ${pkg.manifest.id} must implement createTransport`);
  }
  if (pkg.completeConfig !== undefined && typeof pkg.completeConfig !== 'function') {
    throw new Error(`Transport package ${pkg.manifest.id} completeConfig must be a function when provided`);
  }
}
