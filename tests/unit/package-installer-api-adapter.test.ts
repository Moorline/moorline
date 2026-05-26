import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OperatorPackageService } from '../../packages/core/src/app/bootstrap/operatorPackageService.js';
import { PackageInstaller } from '../../packages/core/src/core/extension/packages/packageInstaller.js';
import { PackageInventoryStore } from '../../packages/core/src/core/extension/packages/packageInventoryStore.js';
import { evaluateRuntimeStartability } from '../../packages/core/src/core/extension/packages/runtimeStartability.js';
import { saveMoorlineConfig } from '../../packages/core/src/core/system/config/configStore.js';
import {
  configuredApiAdapterConfig,
  defaultAdminConfig,
  defaultHttpApiAdapterConfig,
  defaultMainProcessConfig,
  defaultNamespaceNames,
  type MoorlineConfig
} from '../../packages/core/src/types/config.js';
import { createTempRoot } from '../helpers/temp.js';

function writeApiAdapterPackage(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify(
      {
        id: 'acme/http-alt',
        name: 'acme/http-alt',
        version: '1.2.3',
        type: 'api-adapter',
        description: 'Alternate HTTP adapter.',
        entrypoint: 'index.mjs',
        configSchema: {
          type: 'object'
        }
      },
      null,
      2
    ),
    'utf8'
  );
  writeFileSync(
    join(root, 'moorline.dist.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        display: {
          name: 'Acme HTTP Adapter',
          description: 'Alternate HTTP adapter.',
          version: '1.2.3',
          tags: ['http']
        }
      },
      null,
      2
    ),
    'utf8'
  );
  writeFileSync(
    join(root, 'index.mjs'),
    [
      "import manifest from './manifest.json' with { type: 'json' };",
      'export default {',
      '  manifest,',
      '  createAdapter() {',
      '    return {',
      '      async start() { return { endpoints: [] }; },',
      '      async stop() {}',
      '    };',
      '  }',
      '};'
    ].join('\n'),
    'utf8'
  );
}

function writeTransportPackage(root: string): void {
  mkdirSync(root, { recursive: true });
  const manifest = {
    id: 'official/discord',
    name: 'official/discord',
    version: '1.0.0',
    type: 'transport',
    entrypoint: 'index.mjs'
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(root, 'moorline.dist.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        display: {
          name: 'Discord Transport',
          description: 'Fake transport package.',
          version: '1.0.0',
          tags: ['transport']
        }
      },
      null,
      2
    ),
    'utf8'
  );
  writeFileSync(
    join(root, 'index.mjs'),
    `export default { manifest: ${JSON.stringify(manifest)}, createTransport() { return {}; } };\n`,
    'utf8'
  );
}

function writeRequiredApiAdapterPackage(root: string): void {
  mkdirSync(root, { recursive: true });
  const manifest = {
    id: 'acme/required-http',
    name: 'acme/required-http',
    version: '1.0.0',
    type: 'api-adapter',
    entrypoint: 'index.mjs',
    configSchema: {
      type: 'object',
      required: ['token'],
      properties: {
        token: {
          type: 'string'
        }
      }
    }
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(root, 'moorline.dist.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        display: {
          name: 'Required HTTP Adapter',
          description: 'Requires config.',
          version: '1.0.0',
          tags: ['http']
        }
      },
      null,
      2
    ),
    'utf8'
  );
  writeFileSync(
    join(root, 'index.mjs'),
    `export default { manifest: ${JSON.stringify(manifest)}, createAdapter() { return { async start() { return { endpoints: [] }; }, async stop() {} }; } };\n`,
    'utf8'
  );
}

describe('api-adapter package installation', () => {
  it('installs api-adapters under runtime/packages/api-adapters', async () => {
    const root = createTempRoot('moorline-api-adapter-install-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'source');
    writeApiAdapterPackage(sourceDir);

    const record = await new PackageInstaller(runtimeRoot, () => '2026-05-20T00:00:00.000Z').install({
      surface: 'api-adapter',
      source: {
        kind: 'local_dir',
        path: sourceDir
      }
    });

    expect(record).toMatchObject({
      family: 'installable',
      kind: 'api-adapter',
      surface: 'api-adapter',
      packageId: 'acme/http-alt',
      version: '1.2.3',
      installPath: join(runtimeRoot, 'packages', 'api-adapters', 'acme', 'http-alt')
    });
  });

  it('keeps api-adapter inventory records when reloaded', () => {
    const root = createTempRoot('moorline-api-adapter-inventory-');
    const runtimeRoot = join(root, 'runtime');
    const store = new PackageInventoryStore(runtimeRoot);
    store.ensureInitialized();
    store.save({
      version: 1,
      installed: [{
        family: 'installable',
        kind: 'api-adapter',
        surface: 'api-adapter',
        packageId: 'acme/http-alt',
        name: 'Acme HTTP Adapter',
        version: '1.2.3',
        installPath: join(runtimeRoot, 'packages', 'api-adapters', 'acme', 'http-alt'),
        source: {
          kind: 'local_dir',
          path: join(root, 'source')
        },
        installedAt: '2026-05-20T00:00:00.000Z',
        manifestPath: join(runtimeRoot, 'packages', 'api-adapters', 'acme', 'http-alt', 'manifest.json'),
        manifestHash: 'abc123',
        dependencies: []
      }],
      applied: {
        activated: []
      }
    });

    expect(store.load().installed).toHaveLength(1);
    expect(store.load().installed[0]).toMatchObject({
      kind: 'api-adapter',
      surface: 'api-adapter',
      packageId: 'acme/http-alt'
    });
  });

  it('allows built-in official/http configuration and selection before inventory installation', () => {
    const root = createTempRoot('moorline-builtin-http-config-');
    const runtimeRoot = join(root, 'runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    const namespace = defaultNamespaceNames();
    const config: MoorlineConfig = {
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
          config: defaultHttpApiAdapterConfig(),
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
          enabledPackageIds: ['official/status'],
          configByPackageId: {}
        },
        skills: {
          enabledPackageIds: [],
          configByPackageId: {}
        }
      }
    };
    const configPath = join(root, 'config.json');
    saveMoorlineConfig(config, configPath);
    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);

    expect(() => service.setPackageConfigValues({
      surface: 'api-adapter',
      packageId: 'official/http',
      values: {
        host: '127.0.0.1',
        port: '45678',
        exposure: 'remote'
      }
    })).not.toThrow();

    expect(configuredApiAdapterConfig(config)).toMatchObject({
      port: 45678,
      exposure: 'remote'
    });
    expect(config.surfaces.apiAdapter.config).not.toHaveProperty('official/http');
  });

  it('does not copy custom api-adapter config back into official/http when reselected', () => {
    const root = createTempRoot('moorline-api-adapter-reselect-http-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'source');
    writeApiAdapterPackage(sourceDir);
    const namespace = defaultNamespaceNames();
    const config: MoorlineConfig = {
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
          activePackageId: 'acme/http-alt',
          config: {
            host: '0.0.0.0',
            port: 49999,
            exposure: 'remote',
            token: 'custom-secret'
          },
          configByPackageId: {
            'acme/http-alt': {
              host: '0.0.0.0',
              port: 49999,
              exposure: 'remote',
              token: 'custom-secret'
            }
          }
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
    const configPath = join(root, 'config.json');
    saveMoorlineConfig(config, configPath);
    const store = new PackageInventoryStore(runtimeRoot);
    store.save({
      version: 1,
      installed: [{
        family: 'installable',
        kind: 'api-adapter',
        surface: 'api-adapter',
        packageId: 'acme/http-alt',
        name: 'Acme HTTP Adapter',
        version: '1.2.3',
        installPath: join(runtimeRoot, 'packages', 'api-adapters', 'acme', 'http-alt'),
        source: { kind: 'local_dir', path: sourceDir },
        installedAt: '2026-05-20T00:00:00.000Z',
        manifestPath: join(sourceDir, 'manifest.json'),
        manifestHash: 'api-adapter-hash',
        dependencies: []
      }],
      applied: {
        activated: []
      }
    });

    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);
    service.setSelectedPackage('api-adapter', 'official/http');

    expect(config.surfaces.apiAdapter.activePackageId).toBe('official/http');
    expect(config.surfaces.apiAdapter.config).toMatchObject(defaultHttpApiAdapterConfig());
    expect(config.surfaces.apiAdapter.config).not.toMatchObject({
      host: '0.0.0.0',
      port: 49999,
      exposure: 'remote',
      token: 'custom-secret'
    });
  });

  it('preserves saved built-in official/http config while a custom api-adapter is selected', async () => {
    const root = createTempRoot('moorline-api-adapter-preserve-http-config-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'source');
    writeApiAdapterPackage(sourceDir);
    const namespace = defaultNamespaceNames();
    const config: MoorlineConfig = {
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
          activePackageId: 'acme/http-alt',
          config: {
            host: '0.0.0.0',
            port: 49999,
            exposure: 'remote',
            token: 'custom-secret'
          },
          configByPackageId: {
            'official/http': {
              host: '127.0.0.1',
              port: 49000,
              exposure: 'remote',
              auth: { mode: 'bearer' },
              tls: { enabled: false }
            },
            'acme/http-alt': {
              host: '0.0.0.0',
              port: 49999,
              exposure: 'remote',
              token: 'custom-secret'
            }
          }
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
    const configPath = join(root, 'config.json');
    saveMoorlineConfig(config, configPath);
    const store = new PackageInventoryStore(runtimeRoot);
    store.save({
      version: 1,
      installed: [{
        family: 'installable',
        kind: 'api-adapter',
        surface: 'api-adapter',
        packageId: 'acme/http-alt',
        name: 'Acme HTTP Adapter',
        version: '1.2.3',
        installPath: join(runtimeRoot, 'packages', 'api-adapters', 'acme', 'http-alt'),
        source: { kind: 'local_dir', path: sourceDir },
        installedAt: '2026-05-20T00:00:00.000Z',
        manifestPath: join(sourceDir, 'manifest.json'),
        manifestHash: 'api-adapter-hash',
        dependencies: []
      }],
      applied: {
        activated: []
      }
    });

    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);
    await expect(service.apply()).rejects.toThrow();
    service.setSelectedPackage('api-adapter', 'official/http');

    expect(config.surfaces.apiAdapter.configByPackageId['official/http']).toMatchObject({
      port: 49000,
      exposure: 'remote'
    });
    expect(configuredApiAdapterConfig(config)).toMatchObject({
      port: 49000,
      exposure: 'remote'
    });
  });

  it('preserves remote archive integrity and provenance when inventory reloads', () => {
    const root = createTempRoot('moorline-package-inventory-source-');
    const runtimeRoot = join(root, 'runtime');
    const store = new PackageInventoryStore(runtimeRoot);
    store.save({
      version: 1,
      installed: [{
        family: 'installable',
        kind: 'api-adapter',
        surface: 'api-adapter',
        packageId: 'acme/http-alt',
        name: 'Acme HTTP Adapter',
        version: '1.2.3',
        installPath: join(runtimeRoot, 'packages', 'api-adapters', 'acme', 'http-alt'),
        source: {
          kind: 'remote_archive',
          url: 'https://registry.example.test/acme-http-alt.tgz',
          integrity: 'sha512-test',
          provenance: {
            type: 'npm',
            registryUrl: 'https://registry.example.test',
            packageName: '@acme/http-alt',
            version: '1.2.3',
            integrity: 'sha512-test'
          }
        },
        installedAt: '2026-05-20T00:00:00.000Z',
        manifestPath: join(runtimeRoot, 'packages', 'api-adapters', 'acme', 'http-alt', 'manifest.json'),
        manifestHash: 'api-adapter-hash',
        dependencies: []
      }],
      applied: {
        activated: []
      }
    });

    expect(store.load().installed[0]?.source).toMatchObject({
      kind: 'remote_archive',
      integrity: 'sha512-test',
      provenance: {
        type: 'npm',
        packageName: '@acme/http-alt',
        integrity: 'sha512-test'
      }
    });
  });

  it('applies a fresh setup with the built-in official/http adapter absent from inventory', async () => {
    const root = createTempRoot('moorline-builtin-http-apply-');
    const runtimeRoot = join(root, 'runtime');
    const transportPath = join(runtimeRoot, 'packages', 'transports', 'official', 'discord');
    writeTransportPackage(transportPath);
    const namespace = defaultNamespaceNames();
    const config: MoorlineConfig = {
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
          config: defaultHttpApiAdapterConfig(),
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'official/discord',
          config: {
            authToken: 'token',
            scopeId: 'scope',
            applicationId: 'app',
            actorId: 'actor',
            invitePermissions: '0'
          },
          configByPackageId: {}
        },
        provider: {
          activePackageId: 'official/codex',
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
    const configPath = join(root, 'config.json');
    saveMoorlineConfig(config, configPath);
    const store = new PackageInventoryStore(runtimeRoot);
    store.save({
      version: 1,
      installed: [
        {
          family: 'installable',
          kind: 'transport',
          surface: 'transport',
          packageId: 'official/discord',
          name: 'official/discord',
          version: '1.0.0',
          installPath: transportPath,
          source: { kind: 'local_dir', path: transportPath },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(transportPath, 'manifest.json'),
          manifestHash: 'transport-hash',
          dependencies: []
        },
        {
          family: 'installable',
          kind: 'provider',
          surface: 'provider',
          packageId: 'official/codex',
          name: 'official/codex',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'providers', 'official', 'codex'),
          source: { kind: 'local_dir', path: join(root, 'codex') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'codex', 'manifest.json'),
          manifestHash: 'provider-hash',
          dependencies: []
        },
        {
          family: 'installable',
          kind: 'plugin',
          surface: 'plugin',
          packageId: 'official/status',
          name: 'official/status',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'plugins', 'official', 'status'),
          source: { kind: 'local_dir', path: join(root, 'status') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'status', 'manifest.json'),
          manifestHash: 'plugin-hash',
          dependencies: [{
            surface: 'api-adapter',
            packageId: 'official/http',
            requiredState: 'active'
          }]
        }
      ],
      applied: {
        activated: []
      }
    });

    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);
    await expect(service.apply()).resolves.toMatchObject({
      errors: []
    });

    expect(store.load().applied.activated).toContainEqual({
      surface: 'api-adapter',
      packageId: 'official/http'
    });
  });

  it('rejects selected api-adapters with missing required config before apply completes', async () => {
    const root = createTempRoot('moorline-api-adapter-schema-');
    const runtimeRoot = join(root, 'runtime');
    const transportPath = join(runtimeRoot, 'packages', 'transports', 'official', 'discord');
    const adapterSourcePath = join(root, 'adapter-source');
    writeTransportPackage(transportPath);
    writeRequiredApiAdapterPackage(adapterSourcePath);
    await new PackageInstaller(runtimeRoot, () => '2026-05-20T00:00:00.000Z').install({
      surface: 'api-adapter',
      source: {
        kind: 'local_dir',
        path: adapterSourcePath
      }
    });
    const namespace = defaultNamespaceNames();
    const config: MoorlineConfig = {
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
          activePackageId: 'acme/required-http',
          config: {},
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'official/discord',
          config: {
            authToken: 'token',
            scopeId: 'scope',
            applicationId: 'app',
            actorId: 'actor',
            invitePermissions: '0'
          },
          configByPackageId: {}
        },
        provider: {
          activePackageId: 'official/codex',
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
    const configPath = join(root, 'config.json');
    saveMoorlineConfig(config, configPath);
    const store = new PackageInventoryStore(runtimeRoot);
    const state = store.load();
    state.installed.push(
      {
        family: 'installable',
        kind: 'transport',
        surface: 'transport',
        packageId: 'official/discord',
        name: 'official/discord',
        version: '1.0.0',
        installPath: transportPath,
        source: { kind: 'local_dir', path: transportPath },
        installedAt: '2026-05-20T00:00:00.000Z',
        manifestPath: join(transportPath, 'manifest.json'),
        manifestHash: 'transport-hash',
        dependencies: []
      },
      {
        family: 'installable',
        kind: 'provider',
        surface: 'provider',
        packageId: 'official/codex',
        name: 'official/codex',
        version: '1.0.0',
        installPath: join(runtimeRoot, 'packages', 'providers', 'official', 'codex'),
        source: { kind: 'local_dir', path: join(root, 'codex') },
        installedAt: '2026-05-20T00:00:00.000Z',
        manifestPath: join(root, 'codex', 'manifest.json'),
        manifestHash: 'provider-hash',
        dependencies: []
      }
    );
    store.save(state);

    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);
    await expect(service.apply()).rejects.toThrow(/api-adapter config key token is required for acme\/required-http/);
    expect(config.setup.completed).toBe(false);
  });

  it('does not consider the runtime startable when no api-adapter is selected', () => {
    const root = createTempRoot('moorline-api-adapter-required-');
    const runtimeRoot = join(root, 'runtime');
    const namespace = defaultNamespaceNames();
    const config: MoorlineConfig = {
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
          activePackageId: null,
          config: {},
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'official/discord',
          config: {},
          configByPackageId: {}
        },
        provider: {
          activePackageId: 'official/codex',
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

    const result = evaluateRuntimeStartability(config, {
      version: 1,
      installed: [
        {
          family: 'installable',
          kind: 'transport',
          surface: 'transport',
          packageId: 'official/discord',
          name: 'official/discord',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'transports', 'official', 'discord'),
          source: { kind: 'local_dir', path: join(root, 'discord') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'discord', 'manifest.json'),
          manifestHash: 'transport-hash',
          dependencies: []
        },
        {
          family: 'installable',
          kind: 'provider',
          surface: 'provider',
          packageId: 'official/codex',
          name: 'official/codex',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'providers', 'official', 'codex'),
          source: { kind: 'local_dir', path: join(root, 'codex') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'codex', 'manifest.json'),
          manifestHash: 'provider-hash',
          dependencies: []
        }
      ],
      applied: {
        activated: []
      }
    });

    expect(result.startable).toBe(false);
    expect(result.issues).toContain('No API adapter package is activated.');
  });

  it('rejects invalid official/http adapter config during startability checks', () => {
    const root = createTempRoot('moorline-http-startability-config-');
    const runtimeRoot = join(root, 'runtime');
    const namespace = defaultNamespaceNames();
    const config: MoorlineConfig = {
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
            port: 45173,
            exposure: 'loopback'
          },
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'official/discord',
          config: {},
          configByPackageId: {}
        },
        provider: {
          activePackageId: 'official/codex',
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

    const result = evaluateRuntimeStartability(config, {
      version: 1,
      installed: [
        {
          family: 'installable',
          kind: 'transport',
          surface: 'transport',
          packageId: 'official/discord',
          name: 'official/discord',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'transports', 'official', 'discord'),
          source: { kind: 'local_dir', path: join(root, 'discord') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'discord', 'manifest.json'),
          manifestHash: 'transport-hash',
          dependencies: []
        },
        {
          family: 'installable',
          kind: 'provider',
          surface: 'provider',
          packageId: 'official/codex',
          name: 'official/codex',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'providers', 'official', 'codex'),
          source: { kind: 'local_dir', path: join(root, 'codex') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'codex', 'manifest.json'),
          manifestHash: 'provider-hash',
          dependencies: []
        }
      ],
      applied: {
        activated: []
      }
    });

    expect(result.startable).toBe(false);
    expect(result.issues.join('\n')).toMatch(/loopback IP address/i);
  });

  it('does not carry stale official/http config when selecting and configuring a custom api-adapter from fresh defaults', async () => {
    const root = createTempRoot('moorline-api-adapter-switch-');
    const runtimeRoot = join(root, 'runtime');
    const transportPath = join(runtimeRoot, 'packages', 'transports', 'official', 'discord');
    const adapterSourcePath = join(root, 'adapter-source');
    writeTransportPackage(transportPath);
    writeRequiredApiAdapterPackage(adapterSourcePath);
    await new PackageInstaller(runtimeRoot, () => '2026-05-20T00:00:00.000Z').install({
      surface: 'api-adapter',
      source: {
        kind: 'local_dir',
        path: adapterSourcePath
      }
    });
    const namespace = defaultNamespaceNames();
    const config: MoorlineConfig = {
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
          config: defaultHttpApiAdapterConfig(),
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'official/discord',
          config: {
            authToken: 'token',
            scopeId: 'scope',
            applicationId: 'app',
            actorId: 'actor',
            invitePermissions: '0'
          },
          configByPackageId: {}
        },
        provider: {
          activePackageId: 'official/codex',
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
    const configPath = join(root, 'config.json');
    saveMoorlineConfig(config, configPath);
    const store = new PackageInventoryStore(runtimeRoot);
    const state = store.load();
    state.installed.push(
      {
        family: 'installable',
        kind: 'transport',
        surface: 'transport',
        packageId: 'official/discord',
        name: 'official/discord',
        version: '1.0.0',
        installPath: transportPath,
        source: { kind: 'local_dir', path: transportPath },
        installedAt: '2026-05-20T00:00:00.000Z',
        manifestPath: join(transportPath, 'manifest.json'),
        manifestHash: 'transport-hash',
        dependencies: []
      },
      {
        family: 'installable',
        kind: 'provider',
        surface: 'provider',
        packageId: 'official/codex',
        name: 'official/codex',
        version: '1.0.0',
        installPath: join(runtimeRoot, 'packages', 'providers', 'official', 'codex'),
        source: { kind: 'local_dir', path: join(root, 'codex') },
        installedAt: '2026-05-20T00:00:00.000Z',
        manifestPath: join(root, 'codex', 'manifest.json'),
        manifestHash: 'provider-hash',
        dependencies: []
      }
    );
    store.save(state);

    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);
    service.setSelectedPackage('api-adapter', 'acme/required-http');
    service.setPackageConfigValues({
      surface: 'api-adapter',
      packageId: 'acme/required-http',
      values: {
        token: 'secret'
      }
    });

    expect(config.surfaces.apiAdapter.config).toEqual({
      token: 'secret'
    });
    expect(config.surfaces.apiAdapter.config).not.toHaveProperty('official/http');
    await expect(service.apply()).resolves.toMatchObject({
      errors: []
    });
  });

  it('includes the selected api-adapter in setup share bundle package summaries', () => {
    const root = createTempRoot('moorline-api-adapter-share-');
    const runtimeRoot = join(root, 'runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    const namespace = defaultNamespaceNames();
    const config: MoorlineConfig = {
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
          config: defaultHttpApiAdapterConfig(),
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
    const configPath = join(root, 'config.json');
    saveMoorlineConfig(config, configPath);
    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);

    expect(service.exportShareBundle().packages).toMatchObject({
      selectedApiAdapterPackageId: 'official/http',
      selectedTransportPackageId: null,
      selectedProviderPackageId: null
    });
  });
});
