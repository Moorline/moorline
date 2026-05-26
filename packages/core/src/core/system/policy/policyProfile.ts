import { readFileSync } from 'node:fs';
import { isCapability, type Capability } from '../../extension/capabilities/capabilities.js';
import type { NetworkPolicyProfile } from './networkPolicy.js';

interface PolicyProfile {
  profile: string;
  network: NetworkPolicyProfile;
  denyUnknownCapabilities: boolean;
  allowCapabilities: Capability[];
  actorRules: Array<{
    actorPrefix: string;
    allowCapabilities: Capability[];
    denyCapabilities: Capability[];
    targetPrefixes: string[];
  }>;
}

function parseNetworkPolicy(raw: Record<string, unknown>): NetworkPolicyProfile {
  const value = raw.network;
  if (value === undefined) {
    return { mode: 'none', allowlist: [] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Policy network must be an object with mode and allowlist.');
  }

  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (mode !== 'none' && mode !== 'allowlist') {
    throw new Error(`Unsupported network policy mode: ${String(mode)}`);
  }
  const allowlist = Array.isArray(record.allowlist)
    ? record.allowlist.map((entry) => {
        if (typeof entry !== 'string' || !entry.trim()) {
          throw new Error(`Invalid network allowlist entry: ${String(entry)}`);
        }
        return entry.trim();
      })
    : [];
  return { mode, allowlist };
}

export function loadPolicyProfile(path: string): PolicyProfile {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const capabilitiesRaw = Array.isArray(raw.allowCapabilities) ? raw.allowCapabilities : [];
  const allowCapabilities: Capability[] = [];

  for (const value of capabilitiesRaw) {
    if (typeof value !== 'string' || !isCapability(value)) {
      throw new Error(`Invalid capability in policy profile: ${String(value)}`);
    }
    allowCapabilities.push(value);
  }

  const actorRulesRaw = Array.isArray(raw.actorRules) ? raw.actorRules : [];
  const actorRules = actorRulesRaw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Policy actorRules entries must be objects');
    }
    const rule = entry as Record<string, unknown>;
    const actorPrefix = typeof rule.actorPrefix === 'string' && rule.actorPrefix.trim() ? rule.actorPrefix : null;
    if (!actorPrefix) {
      throw new Error('Policy actorRules entries require actorPrefix');
    }

    const parseCapabilities = (value: unknown, label: string): Capability[] => {
      const rawItems = Array.isArray(value) ? value : [];
      return rawItems.map((capability) => {
        if (typeof capability !== 'string' || !isCapability(capability)) {
          throw new Error(`Invalid capability in ${label}: ${String(capability)}`);
        }
        return capability;
      });
    };

    const targetPrefixes = Array.isArray(rule.targetPrefixes)
      ? rule.targetPrefixes.map((value) => {
          if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`Invalid target prefix in actor rule ${actorPrefix}`);
          }
          return value;
        })
      : [];

    return {
      actorPrefix,
      allowCapabilities: parseCapabilities(rule.allowCapabilities, `actor rule ${actorPrefix}`),
      denyCapabilities: parseCapabilities(rule.denyCapabilities, `actor rule ${actorPrefix}`),
      targetPrefixes
    };
  });

  return {
    profile: typeof raw.profile === 'string' ? raw.profile : 'unknown',
    network: parseNetworkPolicy(raw),
    denyUnknownCapabilities: raw.denyUnknownCapabilities !== false,
    allowCapabilities,
    actorRules
  };
}
