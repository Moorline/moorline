import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlApiActionsService } from '../../packages/core/src/app/control-api/services/actions.js';
import { saveMoorlineConfig } from '../../packages/core/src/core/system/config/configStore.js';
import {
  defaultAdminConfig,
  defaultMainProcessConfig,
  defaultSurfaceNames,
  type MoorlineConfig
} from '../../packages/core/src/types/config.js';
import { createTempRoot } from '../helpers/temp.js';

function config(runtimeRoot: string): MoorlineConfig {
  return {
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
        activePackageId: null,
        config: {},
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

describe('Control API package mutations', () => {
  it('stops a running main process before mutating package state', async () => {
    const root = createTempRoot('moorline-control-api-package-mutation-stop-');
    const runtimeRoot = join(root, 'runtime');
    const configPath = join(root, 'config.json');
    mkdirSync(runtimeRoot, { recursive: true });
    saveMoorlineConfig(config(runtimeRoot), configPath);

    let running = true;
    let stopCalls = 0;
    const actions = new ControlApiActionsService({
      configPath,
      runtimeHost: {
        isRunning: () => running,
        stop: async () => {
          stopCalls += 1;
          running = false;
        },
        noteAcceptingNewWork() {}
      } as never,
      buildReadModel: () => ({
        objects: {
          pendingRequests: []
        }
      }) as never
    });

    await expect(actions.removePackage({
      kind: 'bundle',
      packageId: 'missing/package',
      cascade: true
    })).resolves.toBeUndefined();

    expect(stopCalls).toBe(1);
    expect(running).toBe(false);
  });

  it('serializes concurrent package mutations', async () => {
    const root = createTempRoot('moorline-control-api-package-mutation-queue-');
    const runtimeRoot = join(root, 'runtime');
    const configPath = join(root, 'config.json');
    mkdirSync(runtimeRoot, { recursive: true });
    saveMoorlineConfig(config(runtimeRoot), configPath);

    const actions = new ControlApiActionsService({
      configPath,
      runtimeHost: {
        isRunning: () => false,
        stop: async () => {},
        noteAcceptingNewWork() {}
      } as never,
      buildReadModel: () => ({
        objects: {
          pendingRequests: []
        }
      }) as never
    });

    let active = 0;
    let overlapped = false;
    const calls: string[] = [];
    (actions as unknown as {
      packageService: () => {
        installPackage(input: { packageId?: string }): Promise<{ kind: 'plugin'; surface: 'plugin'; packageId: string }>;
      };
    }).packageService = () => ({
      async installPackage(input: { packageId?: string }) {
        active += 1;
        overlapped ||= active > 1;
        calls.push(input.packageId ?? 'unknown');
        await new Promise((resolve) => {
          globalThis.setTimeout(resolve, 20);
        });
        active -= 1;
        return {
          kind: 'plugin',
          surface: 'plugin',
          packageId: input.packageId ?? 'unknown'
        };
      }
    });

    await Promise.all([
      actions.installPackage({ kind: 'plugin', packageId: 'rync/one' }),
      actions.installPackage({ kind: 'plugin', packageId: 'rync/two' })
    ]);

    expect(overlapped).toBe(false);
    expect(calls).toEqual(['rync/one', 'rync/two']);
  });
});
