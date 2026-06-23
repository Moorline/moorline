import { randomUUID } from 'node:crypto';
import type { RuntimeActionGuard } from '../../system/policy/runtimeActionGuard.js';
import type {
  RuntimeMessagePayload,
  RuntimeMessageTarget,
  RuntimeNativeActionRegistration,
  RuntimePresenceInput,
  RuntimeTransportActivityInput,
  RuntimeTransport,
  RuntimeTransportEffect,
  RuntimeTransportEffectReceipt,
  RuntimeCreateTransportResourceInput,
  RuntimeTransportResourceRecord,
  RuntimeUpdateTransportResourceInput,
  RuntimeDeleteTransportResourceInput
} from '../../../types/transport.js';

interface RuntimeTransportEffectServiceDeps {
  queue<T>(key: string, work: () => Promise<T>): Promise<T>;
  guard(): RuntimeActionGuard;
  transport(): RuntimeTransport;
  now(): string;
  appendAuditEvent(event: string, payload: Record<string, unknown>): void;
}

export class RuntimeTransportEffectService {
  constructor(private readonly deps: RuntimeTransportEffectServiceDeps) {}

  async sendMessage(actor: string, target: RuntimeMessageTarget, payload: RuntimeMessagePayload): Promise<RuntimeTransportEffectReceipt> {
    return await this.applyQueued(actor, target.transportResourceId, {
      type: 'transport.message.send',
      effectId: randomUUID(),
      scopeId: target.scopeId,
      target,
      payload,
      createdAt: this.deps.now()
    });
  }

  async createResource(actor: string, input: RuntimeCreateTransportResourceInput): Promise<RuntimeTransportResourceRecord> {
    const receipt = await this.applyQueued(actor, `${input.scopeId}:${input.name}`, {
      type: 'transport.resource.create',
      effectId: randomUUID(),
      scopeId: input.scopeId,
      input,
      createdAt: this.deps.now()
    });
    const resource = receipt.metadata?.resource;
    if (resource && typeof resource === 'object') {
      return resource as RuntimeTransportResourceRecord;
    }
    throw new Error('Transport resource create effect did not return resource metadata.');
  }

  async updateResource(actor: string, input: RuntimeUpdateTransportResourceInput): Promise<RuntimeTransportEffectReceipt> {
    return await this.applyQueued(actor, input.transportResourceId, {
      type: 'transport.resource.update',
      effectId: randomUUID(),
      scopeId: input.scopeId,
      input,
      createdAt: this.deps.now()
    });
  }

  async deleteResource(actor: string, input: RuntimeDeleteTransportResourceInput): Promise<RuntimeTransportEffectReceipt> {
    return await this.applyQueued(actor, input.transportResourceId, {
      type: 'transport.resource.delete',
      effectId: randomUUID(),
      scopeId: input.scopeId,
      input,
      createdAt: this.deps.now()
    });
  }

  async setPresence(actor: string, input: RuntimePresenceInput): Promise<RuntimeTransportEffectReceipt> {
    return await this.applyQueued(actor, input.transportResourceId ?? input.scopeId ?? 'transport:presence', {
      type: 'transport.presence.set',
      effectId: randomUUID(),
      scopeId: input.scopeId,
      input,
      createdAt: this.deps.now()
    });
  }

  async setActivity(actor: string, input: RuntimeTransportActivityInput): Promise<RuntimeTransportEffectReceipt> {
    return await this.applyQueued(actor, `${input.transportResourceId}:activity:${input.kind}:${input.activityId}`, {
      type: 'transport.activity.set',
      effectId: randomUUID(),
      input,
      createdAt: this.deps.now()
    });
  }

  async registerActions(actor: string, input: RuntimeNativeActionRegistration): Promise<RuntimeTransportEffectReceipt> {
    return await this.applyQueued(actor, `${input.scopeId}:actions`, {
      type: 'transport.actions.register',
      effectId: randomUUID(),
      scopeId: input.scopeId,
      input,
      createdAt: this.deps.now()
    });
  }

  private async applyQueued(actor: string, key: string, effect: RuntimeTransportEffect): Promise<RuntimeTransportEffectReceipt> {
    return await this.deps.queue(key, async () =>
      await this.deps.guard().run({
        action: effect.type,
        actor,
        target: key,
        execute: async () => await this.apply(effect)
      })
    );
  }

  private async apply(effect: RuntimeTransportEffect): Promise<RuntimeTransportEffectReceipt> {
    const transport = this.deps.transport();
    const receipt = await transport.applyEffect(effect);
    this.deps.appendAuditEvent('transport.effect.applied', {
      effectId: effect.effectId,
      type: effect.type,
      nativeId: receipt.nativeId ?? null
    });
    return receipt;
  }
}
