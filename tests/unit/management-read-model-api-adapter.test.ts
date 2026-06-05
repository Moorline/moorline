import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PackageInventoryStore } from '../../packages/core/src/core/extension/packages/packageInventoryStore.js';
import { ManagementReadModelService } from '../../packages/core/src/core/system/projection/managementReadModelService.js';
import {
  defaultAdminConfig,
  defaultMainProcessConfig,
  defaultSurfaceNames,
  type MoorlineConfig
} from '../../packages/core/src/types/config.js';
import type { PackageInstallRecord } from '../../packages/core/src/types/package.js';
import { createTempRoot } from '../helpers/temp.js';

function freshInitConfig(runtimeRoot: string): MoorlineConfig {
  const surface = defaultSurfaceNames();
  return {
    version: 4,
    runtimeRoot,
    admin: defaultAdminConfig(),
    main: defaultMainProcessConfig(),
    defaults: {
      runtimeMode: 'full-access',
      model: 'latest'
    },
    surface: surface,
    setup: {
      completed: false
    },
    surfaces: {
      apiAdapter: {
        activePackageId: 'moorline/http',
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

function buildReadModel(input: {
  root: string;
  runtimeRoot: string;
  config: MoorlineConfig;
  sidecars?: unknown[];
}) {
  return new ManagementReadModelService({
    homeRoot: input.root,
    runtimeRoot: input.runtimeRoot,
    config: input.config,
    snapshots: {
      listSessions: () => [],
      overview: () => ({ openRequests: [] }),
      listRecentActivities: () => []
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
      listSidecars: () => input.sidecars ?? []
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
    getSurfaceState: () => null,
    getManagementSurface: () => ({
      enabled: true,
      host: '127.0.0.1',
      port: 45173,
      url: null
    })
  }).build();
}

function installedPackage(input: {
  runtimeRoot: string;
  kind: PackageInstallRecord['kind'];
  packageId: string;
  installPath?: string;
}): PackageInstallRecord {
  const family = input.kind === 'api-adapter' ? 'api-adapters' : input.kind === 'bundle' ? 'bundles' : `${input.kind}s`;
  const installPath = input.installPath ?? join(input.runtimeRoot, 'packages', family, ...input.packageId.split('/'));
  return {
    family,
    kind: input.kind,
    surface: input.kind,
    packageId: input.packageId,
    name: input.packageId,
    version: '1.0.0',
    installedAt: '2026-05-20T00:00:00.000Z',
    installPath,
    source: { kind: 'local_dir', path: installPath },
    manifestPath: join(installPath, 'manifest.json'),
    manifestHash: `${input.packageId}-hash`,
    dependencies: []
  };
}

describe('management read model api-adapter config', () => {
  it('projects fresh-init moorline/http config for configure state', () => {
    const root = createTempRoot('moorline-read-model-http-config-');
    const runtimeRoot = join(root, 'runtime');
    const httpInstallPath = join(runtimeRoot, 'packages', 'api-adapters', 'moorline', 'http');
    mkdirSync(httpInstallPath, { recursive: true });
    writeFileSync(
      join(httpInstallPath, 'manifest.json'),
      JSON.stringify(
        {
          id: 'moorline/http',
          name: 'moorline/http',
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
        packageId: 'moorline/http',
        name: 'moorline/http',
        version: '0.0.1',
        installedAt: '2026-05-20T00:00:00.000Z',
        installPath: httpInstallPath,
        source: { kind: 'local_dir', path: httpInstallPath },
        manifestPath: join(httpInstallPath, 'manifest.json'),
        manifestHash: 'moorline-http-hash',
        dependencies: []
      }],
      applied: { activated: [] }
    });
    const config = freshInitConfig(runtimeRoot);
    const readModel = buildReadModel({ root, runtimeRoot, config });

    const record = readModel.packages.config.find((entry) => entry.surface === 'api-adapter' && entry.packageId === 'moorline/http');
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

  it('projects package source from inventory instead of inferring from Moorline-looking ids or paths', () => {
    const root = createTempRoot('moorline-read-model-source-');
    const runtimeRoot = join(root, 'runtime');
    const config = freshInitConfig(runtimeRoot);
    config.surfaces.transport.activePackageId = 'rync/transportish';
    config.surfaces.provider.activePackageId = 'acme/provider';
    config.surfaces.plugins.enabledPackageIds = ['rync/status'];

    const pluginPath = join(runtimeRoot, 'packages', 'plugins', 'rync', 'status');
    mkdirSync(pluginPath, { recursive: true });
    writeFileSync(
      join(pluginPath, 'manifest.json'),
      JSON.stringify(
        {
          id: 'rync/status',
          name: 'Status',
          version: '1.0.0',
          type: 'plugin',
          capabilities: ['session.inspect']
        },
        null,
        2
      ),
      'utf8'
    );

    new PackageInventoryStore(runtimeRoot).save({
      version: 1,
      installed: [
        installedPackage({ runtimeRoot, kind: 'transport', packageId: 'rync/transportish' }),
        installedPackage({ runtimeRoot, kind: 'provider', packageId: 'acme/provider' }),
        installedPackage({ runtimeRoot, kind: 'plugin', packageId: 'rync/status', installPath: pluginPath })
      ],
      applied: { activated: [] }
    });

    const readModel = buildReadModel({
      root,
      runtimeRoot,
      config,
      sidecars: [{
        sidecarId: 'sidecar-1',
        pluginId: 'rync/status',
        name: 'Status sidecar',
        status: 'running',
        scopeKind: 'global',
        scopeKey: 'global',
        command: 'node',
        args: [],
        restartPolicy: 'never',
        restartCount: 0,
        pid: 123,
        startedAt: '2026-05-20T00:00:00.000Z',
        readyAt: null,
        stoppedAt: null,
        lastError: null,
        updatedAt: '2026-05-20T00:00:00.000Z'
      }]
    });

    expect(readModel.objects.services.find((entry) => entry.id === 'transport-rync/transportish')?.trust).toMatchObject({
      level: 'local',
      source: join(runtimeRoot, 'packages', 'transports', 'rync', 'transportish')
    });
    expect(readModel.objects.services.find((entry) => entry.id === 'provider-acme/provider')?.trust).toMatchObject({
      level: 'local',
      source: join(runtimeRoot, 'packages', 'providers', 'acme', 'provider')
    });
    expect(readModel.objects.plugins.find((entry) => entry.pluginId === 'rync/status')).toMatchObject({
      trust: {
        level: 'local',
        source: pluginPath
      }
    });
    expect(readModel.objects.sidecars[0]?.trust).toMatchObject({
      level: 'local',
      source: pluginPath
    });
  });
});
