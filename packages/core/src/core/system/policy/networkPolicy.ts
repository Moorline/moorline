import type { PolicyHook, PolicyInput } from './policyEngine.js';

export interface NetworkPolicyProfile {
  mode: 'none' | 'allowlist';
  allowlist: string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternMatches(pattern: string, candidate: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (!pattern.includes('*')) {
    return candidate === pattern;
  }
  const expression = `^${pattern.split('*').map((segment) => escapeRegex(segment)).join('.*')}$`;
  return new RegExp(expression, 'u').test(candidate);
}

function payloadTarget(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const direct =
    (typeof record.networkTarget === 'string' && record.networkTarget.trim()) ||
    (typeof record.url === 'string' && record.url.trim()) ||
    (typeof record.host === 'string' && record.host.trim()) ||
    (typeof record.target === 'string' && record.target.trim());
  return direct || null;
}

function networkTargets(input: PolicyInput): string[] {
  const result = new Set<string>();
  if (typeof input.target === 'string' && input.target.trim()) {
    result.add(input.target.trim());
  }
  const fromPayload = payloadTarget(input.payload);
  if (fromPayload) {
    result.add(fromPayload);
  }
  return [...result];
}

export function createNetworkPolicyHook(profile: NetworkPolicyProfile): PolicyHook {
  return async (input: PolicyInput) => {
    if (input.action !== 'net.connect') {
      return {
        allowed: true,
        reason: 'Allowed by network policy'
      };
    }

    if (profile.mode === 'none') {
      return {
        allowed: false,
        reason: 'Denied by network policy: network mode is none'
      };
    }

    const targets = networkTargets(input);
    if (targets.length === 0) {
      return {
        allowed: false,
        reason: 'Denied by network policy: no network target provided for allowlist mode'
      };
    }

    for (const candidate of targets) {
      if (profile.allowlist.some((pattern) => patternMatches(pattern, candidate))) {
        return {
          allowed: true,
          reason: 'Allowed by network policy'
        };
      }
    }

    return {
      allowed: false,
      reason: `Denied by network policy: ${targets[0]} is not allowlisted`
    };
  };
}
