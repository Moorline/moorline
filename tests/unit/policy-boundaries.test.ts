import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActorRulePolicyHook } from '../../packages/core/src/core/system/policy/actorRulePolicy.js';
import { loadPolicyProfile } from '../../packages/core/src/core/system/policy/policyProfile.js';

const root = process.cwd();

describe('default actor policy boundaries', () => {
  it('does not grant removed local-management capabilities or prefix-spoofed plugin actors', async () => {
    const policyPath = join(root, 'packages', 'core', 'resources', 'policies', 'default-secure.json');
    const rawPolicy = readFileSync(policyPath, 'utf8');
    expect(rawPolicy).not.toContain('plugin:official/local-management');

    const profile = loadPolicyProfile(policyPath);
    const hook = createActorRulePolicyHook({ rules: profile.actorRules });

    await expect(
      hook({
        actor: 'plugin:official/local-management-evil',
        action: 'session.create'
      })
    ).resolves.toMatchObject({
      allowed: false
    });

    await expect(
      hook({
        actor: 'plugin:official/session-orchestration',
        action: 'session.create'
      })
    ).resolves.toMatchObject({
      allowed: true
    });

    await expect(
      hook({
        actor: 'plugin:official/session-orchestration-evil',
        action: 'session.create'
      })
    ).resolves.toMatchObject({
      allowed: false
    });
  });
});
