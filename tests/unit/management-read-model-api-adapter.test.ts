import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PackageInventoryStore } from '../../packages/core/src/core/extension/packages/packageInventoryStore.js';
import { ManagementReadModelService } from '../../packages/core/src/core/system/projection/managementReadModelService.js';
import {
  defaultAdminConfig,
  defaultMainProcessConfig,
  defaultNamespaceNames,
  type MoorlineConfig
} from '../../packages/core/src/types/config.js';
import { createTempRoot } from '../helpers/temp.js';

function freshInitConfig(runtimeRoot: string): MoorlineConfig {
  const namespace = defaultNamespaceNames();
  return {
    version: 4,
    runtimeRoot,
    admin: defaultAdminConfig(),
    main: defaultMainProcessConfig(),
    defaults: {
      runtimeMode: 'full-access',
      model: 'latest'
    },
    surface: namespace,
    setup: {
      completed: false
    },
    surfaces: {
      apiAdapter: {
        activePackageId: 'official/http',
        config: {
          host: '0.0.0.0',
          port: 49000,
          exposure: 'remote',
          auth: {
            mode: 'bearer'
          },
          tls: {
            enabled: false
          }
        },
        configByPackageId: {}
      },
      transport: {
        activePackageId: null,
        config: {},
        configByPackageId: {}
      },
      provider: {
        activePackageId: null,
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
    }
  };
}

describe('management read model api-adapter config', () => {
  it('projects fresh-init official/http config for configure state', () => {
    const root = createTempRoot('moorline-read-model-http-config-');
    const runtimeRoot = join(root, 'runtime');
    const httpInstallPath = join(runtimeRoot, 'packages', 'api-adapters', 'official', 'http');
    mkdirSync(httpInstallPath, { recursive: true });
    writeFileSync(
      join(httpInstallPath, 'manifest.json'),
      JSON.stringify(
        {
          id: 'official/http',
          name: 'official/http',
          version: '0.0.1',
          type: 'api-adapter',
          entrypoint: 'index.mjs',
          configSchema: {
            type: 'object',
            properties: {
              host: { type: 'string' },
              port: { type: 'number' },
              exposure: { type: 'string', enum: ['loopback', 'remote'] }
            }
          }
        },
        null,
        2
      ),
      'utf8'
    );
    new PackageInventoryStore(runtimeRoot).save({
      version: 1,
      installed: [{
        family: 'api-adapters',
        kind: 'api-adapter',
        surface: 'api-adapter',
        packageId: 'official/http',
        name: 'official/http',
        version: '0.0.1',
        installedAt: '2026-05-20T00:00:00.000Z',
        installPath: httpInstallPath,
        source: { kind: 'local_dir', path: httpInstallPath },
        manifestPath: join(httpInstallPath, 'manifest.json'),
        manifestHash: 'official-http-hash',
        dependencies: []
      }],
      applied: { activated: [] }
    });
    const config = freshInitConfig(runtimeRoot);
    const readModel = new ManagementReadModelService({
      homeRoot: root,
      runtimeRoot,
      config,
      snapshots: {
        listSessions: () => [],
        overview: () => ({ openRequests: [] }),
        listRecentActivities: () => []
      } as never,
      missions: {
        list: () => [],
        listRuns: () => []
      } as never,
      skills: {
        list: () => []
      } as never,
      provider: {
        listSessions: () => [],
        getDiagnostics: () => ({
          accountLabel: null,
          availableModels: [],
          connectedSessions: 0,
          statusCounts: {},
          capabilityMetadata: {}
        })
      } as never,
      sidecars: {
        listSidecars: () => []
      } as never,
      now: () => '2026-05-20T00:00:00.000Z',
      getRuntimeControlStatus: () => ({
        acceptingNewWork: true,
        supervised: false
      }),
      getRuntimeStatus: () => ({
        status: 'stopped',
        startedAt: null,
        activeSessions: 0
      }) as never,
      getNamespaceState: () => null,
      getManagementSurface: () => ({
        enabled: true,
        host: '127.0.0.1',
        port: 45173,
        url: null
      })
    }).build();

    const record = readModel.packages.config.find((entry) => entry.surface === 'api-adapter' && entry.packageId === 'official/http');
    expect(record).toMatchObject({
      selected: true,
      active: true
    });
    expect(Object.fromEntries(record?.fields.map((field) => [field.key, { configured: field.configured, value: field.value }]) ?? [])).toMatchObject({
      host: {
        configured: true,
        value: '0.0.0.0'
      },
      port: {
        configured: true,
        value: 49000
      },
      exposure: {
        configured: true,
        value: 'remote'
      }
    });
  });
});
