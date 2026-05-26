import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configuredApiAdapterConfig,
  defaultAdminConfig,
  defaultMainProcessConfig,
  defaultNamespaceNames,
  parseMoorlineConfig
} from '../../packages/core/src/types/config.js';
import { resolveSecretsPathForConfigPath, saveMoorlineConfig } from '../../packages/core/src/core/system/config/configStore.js';
import { createTempRoot } from '../helpers/temp.js';

function v4Config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const namespace = defaultNamespaceNames();
  return {
    version: 4,
    runtimeRoot: '/tmp/moorline-runtime',
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
          enabled: true,
          host: '127.0.0.1',
          port: 45173,
          exposure: 'loopback',
          auth: {
            mode: 'bearer'
          },
          tls: {
            enabled: false
          }
        }
      },
      transport: {
        activePackageId: null,
        config: {}
      },
      provider: {
        activePackageId: null,
        config: {}
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
    ...overrides
  };
}

describe('config v4 api adapter state', () => {
  it('parses v4 defaults with official/http as the selected HTTP api-adapter', () => {
    const parsed = parseMoorlineConfig(v4Config());
    expect(parsed.version).toBe(4);
    expect(parsed.surfaces.apiAdapter.activePackageId).toBe('official/http');
    expect(parsed).not.toHaveProperty('clients');
    expect(parsed).not.toHaveProperty('api');
    expect(parsed).not.toHaveProperty('namespace');
    expect(configuredApiAdapterConfig(parsed)).toMatchObject({
      enabled: true,
      host: '127.0.0.1',
      port: 45173,
      exposure: 'loopback',
      auth: {
        mode: 'bearer'
      },
      tls: {
        enabled: false
      }
    });
  });

  it('uses direct active api-adapter config for v4 defaults', () => {
    const parsed = parseMoorlineConfig(v4Config({
      surfaces: {
        apiAdapter: {
          activePackageId: 'official/http',
          config: {
            port: 45174,
            exposure: 'remote',
            host: '0.0.0.0'
          }
        },
        transport: {
          activePackageId: null,
          config: {}
        },
        provider: {
          activePackageId: null,
          config: {}
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
    }));

    expect(configuredApiAdapterConfig(parsed)).toMatchObject({
      host: '0.0.0.0',
      port: 45174,
      exposure: 'remote'
    });
  });

  it('rejects v3 and removed top-level api/client blocks', () => {
    expect(() => parseMoorlineConfig(v4Config({ version: 3 }))).toThrow(/version must be 4/i);
    expect(() => parseMoorlineConfig(v4Config({ api: { enabled: true } }))).toThrow(/removed/i);
    expect(() => parseMoorlineConfig(v4Config({ clients: {} }))).toThrow(/removed/i);
    expect(() => parseMoorlineConfig(v4Config({ namespace: defaultNamespaceNames() }))).toThrow(/namespace has been removed/i);
  });

  it('enforces loopback-only HTTP config unless remote exposure is explicit', () => {
    const remoteHost = {
      apiAdapter: {
        activePackageId: 'official/http',
        config: {
          host: '0.0.0.0',
          port: 45173,
          exposure: 'loopback'
        }
      },
      transport: {
        activePackageId: null,
        config: {}
      },
      provider: {
        activePackageId: null,
        config: {}
      },
      plugins: {
        enabledPackageIds: [],
        configByPackageId: {}
      },
      skills: {
        enabledPackageIds: [],
        configByPackageId: {}
      }
    };
    const parsed = parseMoorlineConfig(v4Config({ surfaces: remoteHost }));
    expect(() => configuredApiAdapterConfig(parsed)).toThrow(/loopback/i);

    const explicitRemote = parseMoorlineConfig(
      v4Config({
        surfaces: {
          ...remoteHost,
          apiAdapter: {
            ...remoteHost.apiAdapter,
            config: {
              host: '0.0.0.0',
              port: 45173,
              exposure: 'remote'
            }
          }
        }
      })
    );
    expect(configuredApiAdapterConfig(explicitRemote)).toMatchObject({
      host: '0.0.0.0',
      exposure: 'remote'
    });
  });

  it('persists api-adapter secrets when they are the only secret values', () => {
    const root = createTempRoot('moorline-config-api-adapter-secrets-');
    const configPath = join(root, 'config.json');
    const parsed = parseMoorlineConfig(
      v4Config({
        runtimeRoot: join(root, 'runtime'),
        surfaces: {
          apiAdapter: {
            activePackageId: 'official/http',
            config: {},
            configByPackageId: {
              'official/http': {
                host: '127.0.0.1',
                port: 45173,
                token: 'secret-token'
              }
            }
          },
          transport: {
            activePackageId: null,
            config: {}
          },
          provider: {
            activePackageId: null,
            config: {}
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
      })
    );

    saveMoorlineConfig(parsed, configPath);

    const publicConfig = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const secretsPath = resolveSecretsPathForConfigPath(configPath);
    expect(existsSync(secretsPath)).toBe(true);
    expect(JSON.stringify(publicConfig)).not.toContain('secret-token');
    expect(readFileSync(secretsPath, 'utf8')).toContain('secret-token');
  });
});
