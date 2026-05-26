import type { AppliedMoorlineConfig } from '../../../../types/config.js';

export function providerPolicyTarget(config: AppliedMoorlineConfig, threadId: string, suffix: string): string {
  const providerId = config.provider.packageId ?? config.provider.kind;
  return `provider:${providerId}:${threadId}:${suffix}`;
}
