import {
  isCapability,
  isPackageLocalCapability,
  packageOwnsCapability,
  type Capability
} from '../../extension/capabilities/capabilities.js';

export interface PolicyInput {
  action: string;
  actor: string;
  target?: string;
  payload?: unknown;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  requiredRedactions?: string[];
}

export type PolicyHook = (input: PolicyInput) => Promise<PolicyDecision>;

interface PolicyEngineConfig {
  grantedCapabilities: Set<Capability>;
  hooks: PolicyHook[];
  denyUnknownCapabilities?: boolean;
}

export function createPolicyEngine(config: PolicyEngineConfig) {
  return {
    async evaluate(input: PolicyInput): Promise<PolicyDecision> {
      if (config.denyUnknownCapabilities !== false && !isCapability(input.action)) {
        return {
          allowed: false,
          reason: `Denied unknown capability: ${input.action}`
        };
      }

      const action = input.action as Capability;
      if (isPackageLocalCapability(action)) {
        const packageActorPrefix = 'plugin:';
        const actorPackageId = input.actor.startsWith(packageActorPrefix) ? input.actor.slice(packageActorPrefix.length) : null;
        if (!actorPackageId || !packageOwnsCapability(actorPackageId, action)) {
          return {
            allowed: false,
            reason: `Denied package-local capability ${input.action} for actor ${input.actor}`
          };
        }
      }

      if (!config.grantedCapabilities.has(action)) {
        return {
          allowed: false,
          reason: `Denied by capability policy: ${input.action}`
        };
      }

      for (const hook of config.hooks) {
        const decision = await hook(input);
        if (!decision.allowed) {
          return decision;
        }
      }

      return {
        allowed: true,
        reason: 'Allowed'
      };
    }
  };
}
