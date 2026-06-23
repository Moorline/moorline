import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActorRulePolicyHook } from '../../packages/core/src/core/system/policy/actorRulePolicy.js';
import { loadPolicyProfile } from '../../packages/core/src/core/system/policy/policyProfile.js';

const root = process.cwd();

describe('default actor policy boundaries', () => {
  it('does not grant removed local-management capabilities or third-party plugin actors', async () => {
    const policyPath = join(root, 'packages', 'core', 'resources', 'policies', 'default-secure.json');
    const rawPolicy = readFileSync(policyPath, 'utf8');
    expect(rawPolicy).not.toContain('plugin:rync/');

    const profile = loadPolicyProfile(policyPath);
    const hook = createActorRulePolicyHook({ rules: profile.actorRules });

    await expect(
      hook({
        actor: 'plugin:acme/local-management',
        action: 'session.create'
      })
    ).resolves.toMatchObject({
      allowed: false
    });

    await expect(
      hook({
        actor: 'plugin:rync/retired-session-plugin',
        action: 'session.create'
      })
    ).resolves.toMatchObject({
      allowed: false
    });

    await expect(
      hook({
        actor: 'plugin:acme/session-plugin',
        action: 'session.create'
      })
    ).resolves.toMatchObject({
      allowed: false
    });
  });

  it('allows transport actors to register native actions with the runtime effect capability', async () => {
    const policyPath = join(root, 'packages', 'core', 'resources', 'policies', 'default-secure.json');
    const rawPolicy = readFileSync(policyPath, 'utf8');
    expect(rawPolicy).toContain('transport.actions.register');
    expect(rawPolicy).not.toContain('transport.action.register');

    const profile = loadPolicyProfile(policyPath);
    const hook = createActorRulePolicyHook({ rules: profile.actorRules });

    await expect(
      hook({
        actor: 'runtime:transport/register-commands',
        action: 'transport.actions.register'
      })
    ).resolves.toMatchObject({
      allowed: true
    });
  });

  it('allows active plugin actors only through manifest-derived capability rules', async () => {
    const policyPath = join(root, 'packages', 'core', 'resources', 'policies', 'default-secure.json');
    const profile = loadPolicyProfile(policyPath);
    const hook = createActorRulePolicyHook({
      rules: [
        ...profile.actorRules,
        {
          actorPrefix: 'plugin:rync/example-session-plugin',
          allowCapabilities: ['session.create'],
          denyCapabilities: [],
          targetPrefixes: []
        }
      ]
    });

    await expect(
      hook({
        actor: 'plugin:rync/example-session-plugin',
        action: 'session.create'
      })
    ).resolves.toMatchObject({
      allowed: true
    });

    await expect(
      hook({
        actor: 'plugin:rync/example-session-plugin',
        action: 'session.delete'
      })
    ).resolves.toMatchObject({
      allowed: false
    });
  });

  it('unions equal-specificity plugin allow rules while keeping denies authoritative', async () => {
    const hook = createActorRulePolicyHook({
      rules: [
        {
          actorPrefix: 'plugin:rync/discord-runtime',
          allowCapabilities: ['transport.message.send'],
          denyCapabilities: [],
          targetPrefixes: []
        },
        {
          actorPrefix: 'plugin:rync/discord-runtime',
          allowCapabilities: ['net.connect'],
          denyCapabilities: [],
          targetPrefixes: []
        },
        {
          actorPrefix: 'plugin:rync/discord-runtime',
          allowCapabilities: [],
          denyCapabilities: ['fs.write'],
          targetPrefixes: []
        }
      ]
    });

    await expect(
      hook({
        actor: 'plugin:rync/discord-runtime',
        action: 'transport.message.send'
      })
    ).resolves.toMatchObject({ allowed: true });

    await expect(
      hook({
        actor: 'plugin:rync/discord-runtime',
        action: 'net.connect'
      })
    ).resolves.toMatchObject({ allowed: true });

    await expect(
      hook({
        actor: 'plugin:rync/discord-runtime',
        action: 'fs.write'
      })
    ).resolves.toMatchObject({ allowed: false });
  });

  it('allows runtime supervisor control to reach provider-local network surfaces', async () => {
    const policyPath = join(root, 'packages', 'core', 'resources', 'policies', 'default-secure.json');
    const profile = loadPolicyProfile(policyPath);
    const hook = createActorRulePolicyHook({ rules: profile.actorRules });

    await expect(
      hook({
        actor: 'runtime:supervisor/control',
        action: 'net.connect',
        target: 'provider:rync/pi'
      })
    ).resolves.toMatchObject({
      allowed: true
    });
  });
});
