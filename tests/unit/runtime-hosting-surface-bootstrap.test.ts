import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeHostingService } from '../../packages/core/src/core/runtime/hosting/runtimeHostingService.js';
import { loadInstallationState, saveInstallationState } from '../../packages/core/src/core/system/config/configStore.js';
import type { AppliedMoorlineConfig } from '../../packages/core/src/types/config.js';
import type { RuntimeTransport, RuntimeTransportEffect, RuntimeTransportEffectReceipt } from '../../packages/core/src/types/transport.js';
import { createTempRoot } from '../helpers/temp.js';

function config(): AppliedMoorlineConfig {
  return {
    version: 4,
    runtimeRoot: '/tmp/moorline-test',
    model: 'latest',
    transport: {
      kind: 'package',
      packageId: 'rync/discord',
      scopeId: 'guild-1',
      config: {}
    },
    provider: {
      kind: 'package',
      packageId: 'rync/pi',
      config: {}
    },
    apiAdapter: {
      kind: 'package',
      packageId: '@moorline/http',
      config: {}
    },
    plugins: {
      enabledPackageIds: [],
      configByPackageId: {}
    },
    skills: {
      enabledPackageIds: [],
      configByPackageId: {}
    },
    surfaces: {
      apiAdapter: {
        activePackageId: '@moorline/http',
        config: {},
        configByPackageId: {}
      },
      transport: {
        activePackageId: 'rync/discord',
        config: {},
        configByPackageId: {}
      },
      provider: {
        activePackageId: 'rync/pi',
        config: {},
        configByPackageId: {}
      },
      plugins: {
        enabledPackageIds: [],
        configByPackageId: {}
      },
      skills: {
        enabledPackageIds: [],
        configByPackageId: {}
      }
    },
    surface: {
      mainCategoryName: 'Moorline',
      coordinationResourceName: 'moorline-coordination',
      statusResourceName: 'moorline-status',
      sessionsGroupName: 'Sessions',
      archiveGroupName: 'Archive'
    },
    admin: {
      accessGroupIds: [],
      userIds: [],
      managedRole: { enabled: false, name: 'Moorline Admin' },
      managedUserRole: { enabled: false, name: 'Moorline User' }
    },
    setup: {
      completed: true
    },
    mainProcess: {
      autostart: false,
      defaultLifecyclePolicy: 'detached'
    },
    policies: {
      activeProfilePath: null
    },
    memory: {
      globalMemoryRoots: []
    }
  };
}

function transport(): RuntimeTransport {
  return {
    verifyAccess: async () => ({
      scopeId: 'guild-1',
      scopeName: 'Guild 1',
      actorId: 'bot-1',
      actorName: 'Moorline'
    }),
    start: async () => {},
    bootstrapSurface: async () => ({
      surfaceId: 'guild-1',
      statusResourceId: '111111111111111111',
      coordinationResourceId: '111111111111111111',
      metadata: {
        startChannelName: 'moorline-start'
      }
    }),
    stop: async () => {},
    capabilities: () => ({
      nativeActions: false,
      resources: { list: false, create: false, update: false, delete: false },
      presence: false
    }),
    onIntent: () => {},
    applyEffect: async (effect: RuntimeTransportEffect): Promise<RuntimeTransportEffectReceipt> => ({
      effectId: effect.effectId,
      appliedAt: '2026-06-23T00:00:01.000Z'
    })
  };
}

describe('RuntimeHostingService surface bootstrap', () => {
  it('repairs fake persisted surface resource names with transport-provided ids', async () => {
    const root = createTempRoot('moorline-hosting-surface-');
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { recursive: true });
    const installationPath = join(stateDir, 'installation.json');
    saveInstallationState(installationPath, {
      scopeId: 'guild-1',
      surfaceId: 'guild-1',
      statusResourceId: 'moorline-status',
      coordinationResourceId: 'moorline-coordination',
      createdAt: '2026-06-23T00:00:00.000Z',
      updatedAt: '2026-06-23T00:00:00.000Z'
    });

    const service = new RuntimeHostingService({
      config: config(),
      transport: transport(),
      effects: {
        registerActions: async () => {}
      } as never,
      managementSurface: {
        start: async () => {},
        stop: async () => {}
      },
      installationPath,
      now: () => '2026-06-23T00:00:01.000Z',
      authorizeTransportSetup: async ({ execute }) => await execute()
    });

    const state = await service.start({ actions: [], onTransportIntent: async () => {} });

    expect(state.statusResourceId).toBe('111111111111111111');
    expect(state.coordinationResourceId).toBe('111111111111111111');
    expect(loadInstallationState(installationPath)).toMatchObject({
      statusResourceId: '111111111111111111',
      coordinationResourceId: '111111111111111111',
      metadata: {
        startChannelName: 'moorline-start'
      }
    });
  });
});
