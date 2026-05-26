import type { Capability } from '../../extension/capabilities/capabilities.js';
import type { JsonAuditLogger } from '../audit/auditLogger.js';
import type { PolicyDecision } from './policyEngine.js';

interface GuardDeps {
  evaluate(input: {
    action: Capability;
    actor: string;
    target?: string;
    payload?: unknown;
  }): Promise<PolicyDecision>;
  audit: JsonAuditLogger;
}

export class RuntimeActionGuard {
  constructor(private readonly deps: GuardDeps) {}

  async run<T>(input: {
    action: Capability;
    actor: string;
    target?: string;
    payload?: unknown;
    execute: () => Promise<T>;
  }): Promise<T> {
    const decision = await this.deps.evaluate({
      action: input.action,
      actor: input.actor,
      target: input.target,
      payload: input.payload
    });

    await this.deps.audit.log({
      eventType: 'policy.decision',
      actor: input.actor,
      action: input.action,
      status: decision.allowed ? 'allowed' : 'denied',
      metadata: {
        target: input.target ?? null,
        reason: decision.reason
      }
    });

    if (!decision.allowed) {
      await this.deps.audit.log({
        eventType: 'tool.execution',
        actor: input.actor,
        action: input.action,
        status: 'failed',
        metadata: {
          target: input.target ?? null,
          reason: `blocked: ${decision.reason}`
        }
      });
      throw new Error(`Action blocked by policy: ${decision.reason}`);
    }

    try {
      const result = await input.execute();
      await this.deps.audit.log({
        eventType: 'tool.execution',
        actor: input.actor,
        action: input.action,
        status: 'success',
        metadata: {
          target: input.target ?? null
        }
      });
      return result;
    } catch (error) {
      await this.deps.audit.log({
        eventType: 'tool.execution',
        actor: input.actor,
        action: input.action,
        status: 'failed',
        metadata: {
          target: input.target ?? null,
          reason: error instanceof Error ? error.message : 'unknown failure'
        }
      });
      throw error;
    }
  }
}
