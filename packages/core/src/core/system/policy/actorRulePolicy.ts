import type { Capability } from '../../extension/capabilities/capabilities.js';
import type { PolicyDecision, PolicyHook, PolicyInput } from './policyEngine.js';

interface ActorPolicyRule {
  actorPrefix: string;
  allowCapabilities: Capability[];
  denyCapabilities: Capability[];
  targetPrefixes: string[];
}

interface MatchedActorRule {
  rule: ActorPolicyRule;
  matchedTargetPrefixLength: number;
}

const DEFAULT_DENY_UNMATCHED_RUNTIME_SENSITIVE_CAPABILITIES = new Set<Capability>([
  'command.exec',
  'fs.write',
  'net.connect',
  'runtime.control'
]);

function defaultAllowDecision(): PolicyDecision {
  return {
    allowed: true,
    reason: 'Allowed by actor policy'
  };
}

function actorMatchesPrefix(actor: string, prefix: string): boolean {
  if (actor === prefix) {
    return true;
  }
  if (!actor.startsWith(prefix)) {
    return false;
  }
  return prefix.endsWith('/') || actor[prefix.length] === '/' || actor[prefix.length] === ':';
}

export function createActorRulePolicyHook(input: {
  rules: ActorPolicyRule[];
  defaultDenyUnmatchedRuntimeCapabilities?: Set<Capability>;
}): PolicyHook {
  const defaultDeny = input.defaultDenyUnmatchedRuntimeCapabilities ?? DEFAULT_DENY_UNMATCHED_RUNTIME_SENSITIVE_CAPABILITIES;
  return async (request: PolicyInput): Promise<PolicyDecision> => {
    const matchingRules = input.rules.filter((rule) => actorMatchesPrefix(request.actor, rule.actorPrefix));
    if (matchingRules.length === 0) {
      if (request.actor.startsWith('plugin:')) {
        return {
          allowed: false,
          reason: `Denied by actor policy: no actor rule matched ${request.actor} for ${request.action}`
        };
      }
      if (request.actor.startsWith('runtime:') && defaultDeny.has(request.action as Capability)) {
        return {
          allowed: false,
          reason: `Denied by actor policy: no actor rule matched ${request.actor} for ${request.action}`
        };
      }
      return defaultAllowDecision();
    }

    const target = request.target ?? '';
    const applicableRules: MatchedActorRule[] = matchingRules.flatMap((rule) => {
      if (rule.targetPrefixes.length === 0) {
        return [{ rule, matchedTargetPrefixLength: 0 }];
      }
      const matchedPrefixLength = rule.targetPrefixes
        .filter((prefix) => target.startsWith(prefix))
        .reduce((longest, prefix) => Math.max(longest, prefix.length), 0);
      if (matchedPrefixLength === 0) {
        return [];
      }
      return [{ rule, matchedTargetPrefixLength: matchedPrefixLength }];
    });

    if (applicableRules.length === 0) {
      return {
        allowed: false,
        reason: `Denied by actor target policy: ${target || '(none)'}`
      };
    }

    const mostSpecificActorPrefix = applicableRules.reduce(
      (longest, entry) => Math.max(longest, entry.rule.actorPrefix.length),
      0
    );
    const actorSpecificRules = applicableRules.filter((entry) => entry.rule.actorPrefix.length === mostSpecificActorPrefix);
    const mostSpecificTargetPrefix = actorSpecificRules.reduce(
      (longest, entry) => Math.max(longest, entry.matchedTargetPrefixLength),
      0
    );
    const resolvedRules = actorSpecificRules.filter((entry) => entry.matchedTargetPrefixLength === mostSpecificTargetPrefix);

    if (resolvedRules.some((entry) => entry.rule.denyCapabilities.includes(request.action as Capability))) {
      return {
        allowed: false,
        reason: `Denied by actor policy: ${request.action}`
      };
    }

    if (
      resolvedRules.some(
        (entry) =>
          entry.rule.allowCapabilities.length === 0 ||
          entry.rule.allowCapabilities.includes(request.action as Capability)
      )
    ) {
      return defaultAllowDecision();
    }

    return {
      allowed: false,
      reason: `Denied by actor policy: ${request.action}`
    };
  };
}
