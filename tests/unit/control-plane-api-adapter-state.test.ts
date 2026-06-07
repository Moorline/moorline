import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlPlane } from '../../packages/core/src/app/control-api/services/controlPlane.js';
import { saveMoorlineConfig } from '../../packages/core/src/core/system/config/configStore.js';
import {
  defaultAdminConfig,
  defaultMainProcessConfig,
  defaultSurfaceNames,
  type MoorlineConfig
} from '../../packages/core/src/types/config.js';
import { createTempRoot } from '../helpers/temp.js';

describe('ControlPlane API adapter state projection', () => {
  it('does not validate custom API adapter config as moorline/http while building state', async () => {
    const root = createTempRoot('moorline-control-plane-custom-api-adapter-');
    const runtimeRoot = join(root, 'runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    const config: MoorlineConfig = {
      version: 4,
      runtimeRoot,
      admin: defaultAdminConfig(),
      main: defaultMainProcessConfig(),
      defaults: {
        runtimeMode: 'full-access',
        model: 'latest'
      },
      surface: defaultSurfaceNames(),
      setup: {
        completed: false
      },
      surfaces: {
        apiAdapter: {
          activePackageId: 'acme/control',
          config: {},
          configByPackageId: {
            'acme/control': {
              host: 'api.example.internal'
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

    const controlPlane = new ControlPlane({
      configPath,
      entrypoint: process.execPath
    });
    await controlPlane.start();
    const readModel = controlPlane.readModel();
    await controlPlane.stop();

    expect(readModel.runtime.managementSurface).toMatchObject({
      enabled: true,
      host: 'api.example.internal',
      port: 0,
      url: null
    });
  });
});
