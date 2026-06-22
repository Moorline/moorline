import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { create } from 'tar';
import { describe, expect, it, vi } from 'vitest';
import { OperatorPackageService } from '../../packages/core/src/app/bootstrap/operatorPackageService.js';
import { PackageInstaller } from '../../packages/core/src/core/extension/packages/packageInstaller.js';
import { PackageInventoryStore } from '../../packages/core/src/core/extension/packages/packageInventoryStore.js';
import { coerceSurfaceConfigInput, evaluateRuntimeStartability } from '../../packages/core/src/core/extension/packages/runtimeStartability.js';
import { saveMoorlineConfig } from '../../packages/core/src/core/system/config/configStore.js';
import {
  configuredApiAdapterConfig,
  defaultAdminConfig,
  defaultHttpApiAdapterConfig,
  defaultMainProcessConfig,
  defaultSurfaceNames,
  type MoorlineConfig
} from '../../packages/core/src/types/config.js';
import { createTempRoot } from '../helpers/temp.js';

function writeApiAdapterPackage(root: string, id = 'acme/http-alt'): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify(
      {
        id,
        name: id,
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

function installedApiAdapterRecord(input: { runtimeRoot: string; packageId: string; sourceDir: string }) {
  return {
    family: 'installable' as const,
    kind: 'api-adapter' as const,
    surface: 'api-adapter' as const,
    packageId: input.packageId,
    name: input.packageId,
    version: '1.2.3',
    installPath: join(input.runtimeRoot, 'packages', 'api-adapters', ...input.packageId.split('/')),
    source: { kind: 'local_dir' as const, path: input.sourceDir },
    installedAt: '2026-05-20T00:00:00.000Z',
    manifestPath: join(input.sourceDir, 'manifest.json'),
    manifestHash: `${input.packageId}-hash`,
    dependencies: []
  };
}

function writeTransportPackage(root: string): void {
  mkdirSync(root, { recursive: true });
  const manifest = {
    id: 'rync/transport',
    name: 'rync/transport',
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
          name: 'Example Transport',
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

function writeProviderPackage(root: string): void {
  mkdirSync(root, { recursive: true });
  const manifest = {
    id: 'acme/provider',
    name: 'acme/provider',
    version: '1.0.0',
    type: 'provider',
    entrypoint: 'index.mjs'
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(root, 'moorline.dist.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        display: {
          name: 'Example Provider',
          description: 'Fake provider package.',
          version: '1.0.0',
          tags: ['provider']
        }
      },
      null,
      2
    ),
    'utf8'
  );
  writeFileSync(
    join(root, 'index.mjs'),
    `export default { manifest: ${JSON.stringify(manifest)}, createProviderFactory() { return () => ({}); } };\n`,
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

function writePluginPackage(root: string, input: { packageId: string; version?: string }): void {
  mkdirSync(root, { recursive: true });
  const manifest = {
    id: input.packageId,
    name: input.packageId,
    version: input.version ?? '1.0.0',
    type: 'plugin',
    entrypoint: 'index.mjs',
    capabilities: ['fs.read'],
    hooks: []
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(root, 'moorline.dist.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        display: {
          name: input.packageId,
          description: 'Fake plugin package.',
          version: input.version ?? '1.0.0',
          tags: ['plugin']
        }
      },
      null,
      2
    ),
    'utf8'
  );
  writeFileSync(join(root, 'index.mjs'), `export default { id: '${input.packageId}', manifest: ${JSON.stringify(manifest)} };\n`, 'utf8');
}

function writeBundlePackage(root: string, id = 'rync/basic-essentials'): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify(
      {
        id,
        name: id,
        version: '1.0.0',
        type: 'bundle',
        description: 'Basic essentials.',
        members: [{
          kind: 'plugin',
          packageId: 'rync/status',
          version: '~1.0.0',
          activation: 'enable'
        }]
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
          name: 'Basic Essentials',
          description: 'Basic essentials.',
          version: '1.0.0',
          tags: ['bundle']
        }
      },
      null,
      2
    ),
    'utf8'
  );
  writePluginPackage(join(root, 'packages', 'plugins', 'rync', 'status'), {
    packageId: 'rync/status'
  });
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

  it('skips workspace node_modules when installing local package directories', async () => {
    const root = createTempRoot('moorline-local-package-node-modules-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'source');
    writeApiAdapterPackage(sourceDir);
    const dependencyTarget = join(root, 'workspace-dependency');
    mkdirSync(join(sourceDir, 'node_modules', '@moorline'), { recursive: true });
    mkdirSync(dependencyTarget, { recursive: true });
    symlinkSync(dependencyTarget, join(sourceDir, 'node_modules', '@moorline', 'contracts'), 'dir');

    const record = await new PackageInstaller(runtimeRoot, () => '2026-05-20T00:00:00.000Z').install({
      surface: 'api-adapter',
      source: {
        kind: 'local_dir',
        path: sourceDir
      }
    });

    expect(record.packageId).toBe('acme/http-alt');
    expect(existsSync(join(record.installPath, 'node_modules'))).toBe(false);
  });

  it('skips source-checkout TypeScript baggage while preserving runtime JavaScript', async () => {
    const root = createTempRoot('moorline-local-package-source-checkout-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'source');
    writeApiAdapterPackage(sourceDir);
    mkdirSync(join(sourceDir, 'src'), { recursive: true });
    mkdirSync(join(sourceDir, 'dist'), { recursive: true });
    writeFileSync(join(sourceDir, 'src', 'http.ts'), 'export const sourceOnly = true;\n', 'utf8');
    writeFileSync(join(sourceDir, 'src', 'runtime.mjs'), 'export const runtime = true;\n', 'utf8');
    writeFileSync(join(sourceDir, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
    writeFileSync(join(sourceDir, 'dist', 'index.js'), 'export {};\n', 'utf8');
    writeFileSync(join(sourceDir, 'dist', 'index.js.map'), '{}\n', 'utf8');

    const record = await new PackageInstaller(runtimeRoot, () => '2026-05-20T00:00:00.000Z').install({
      surface: 'api-adapter',
      source: {
        kind: 'local_dir',
        path: sourceDir
      }
    });

    expect(record.packageId).toBe('acme/http-alt');
    expect(existsSync(join(record.installPath, 'src', 'http.ts'))).toBe(false);
    expect(existsSync(join(record.installPath, 'src', 'runtime.mjs'))).toBe(true);
    expect(existsSync(join(record.installPath, 'tsconfig.json'))).toBe(false);
    expect(existsSync(join(record.installPath, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(record.installPath, 'dist', 'index.js.map'))).toBe(false);
  });

  it('allows local packages to use a JavaScript entrypoint under src', async () => {
    const root = createTempRoot('moorline-local-package-src-entrypoint-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'source');
    writeApiAdapterPackage(sourceDir);
    const manifestPath = join(sourceDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.entrypoint = 'src/index.mjs';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    mkdirSync(join(sourceDir, 'src'), { recursive: true });
    writeFileSync(join(sourceDir, 'src', 'index.mjs'), "export default { createAdapter() { return {}; } };\n", 'utf8');
    writeFileSync(join(sourceDir, 'src', 'index.ts'), 'export const sourceOnly = true;\n', 'utf8');

    const record = await new PackageInstaller(runtimeRoot, () => '2026-05-20T00:00:00.000Z').install({
      surface: 'api-adapter',
      source: {
        kind: 'local_dir',
        path: sourceDir
      }
    });

    expect(record.packageId).toBe('acme/http-alt');
    expect(existsSync(join(record.installPath, 'src', 'index.mjs'))).toBe(true);
    expect(existsSync(join(record.installPath, 'src', 'index.ts'))).toBe(false);
  });

  it('copies declared Moorline workspace dependencies for local package directories', async () => {
    const root = createTempRoot('moorline-local-package-workspace-deps-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'source');
    const contractsDir = join(root, 'contracts');
    const transitiveDir = join(root, 'transitive');
    writeApiAdapterPackage(sourceDir);
    writeFileSync(
      join(sourceDir, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: {
          '@moorline/contracts': '0.0.2'
        }
      }, null, 2),
      'utf8'
    );
    mkdirSync(join(sourceDir, 'node_modules', '@moorline'), { recursive: true });
    mkdirSync(join(contractsDir, 'dist'), { recursive: true });
    writeFileSync(
      join(contractsDir, 'package.json'),
      JSON.stringify({
        name: '@moorline/contracts',
        type: 'module',
        dependencies: {
          'moorline-transitive-test': '1.0.0'
        },
        exports: {
          '.': './dist/index.js'
        }
      }, null, 2),
      'utf8'
    );
    writeFileSync(join(contractsDir, 'dist', 'index.js'), 'export const ok = true;\n', 'utf8');
    writeFileSync(join(contractsDir, 'dist', 'index.js.map'), '{}\n', 'utf8');
    mkdirSync(join(contractsDir, 'src'), { recursive: true });
    writeFileSync(join(contractsDir, 'src', 'index.ts'), 'export const sourceOnly = true;\n', 'utf8');
    mkdirSync(join(contractsDir, 'node_modules'), { recursive: true });
    mkdirSync(join(transitiveDir, 'dist'), { recursive: true });
    writeFileSync(
      join(transitiveDir, 'package.json'),
      JSON.stringify({
        name: 'moorline-transitive-test',
        type: 'module',
        exports: {
          '.': './dist/index.js'
        }
      }, null, 2),
      'utf8'
    );
    writeFileSync(join(transitiveDir, 'dist', 'index.js'), 'export const transitive = true;\n', 'utf8');
    symlinkSync(transitiveDir, join(contractsDir, 'node_modules', 'moorline-transitive-test'), 'dir');
    symlinkSync(contractsDir, join(sourceDir, 'node_modules', '@moorline', 'contracts'), 'dir');

    const record = await new PackageInstaller(runtimeRoot, () => '2026-05-20T00:00:00.000Z').install({
      surface: 'api-adapter',
      source: {
        kind: 'local_dir',
        path: sourceDir
      }
    });

    const installedDependency = join(record.installPath, 'node_modules', '@moorline', 'contracts');
    expect(record.packageId).toBe('acme/http-alt');
    expect(existsSync(join(installedDependency, 'package.json'))).toBe(true);
    expect(existsSync(join(installedDependency, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(installedDependency, 'dist', 'index.js.map'))).toBe(false);
    expect(existsSync(join(installedDependency, 'src', 'index.ts'))).toBe(false);
    expect(existsSync(join(record.installPath, 'node_modules', 'moorline-transitive-test', 'dist', 'index.js'))).toBe(true);
  });

  it('hydrates production dependencies when installing archived npm-style packages', async () => {
    const root = createTempRoot('moorline-archive-package-deps-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'source');
    const dependencyDir = join(root, 'runtime-dep');
    const archivePath = join(root, 'package.tgz');
    writeApiAdapterPackage(sourceDir);
    mkdirSync(dependencyDir, { recursive: true });
    writeFileSync(
      join(dependencyDir, 'package.json'),
      JSON.stringify({
        name: 'moorline-test-runtime-dep',
        version: '1.0.0',
        type: 'module',
        main: './index.mjs'
      }, null, 2),
      'utf8'
    );
    writeFileSync(join(dependencyDir, 'index.mjs'), 'export const hydrated = true;\n', 'utf8');
    writeFileSync(
      join(sourceDir, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: {
          'moorline-test-runtime-dep': `file:${dependencyDir}`
        }
      }, null, 2),
      'utf8'
    );
    await create({
      gzip: true,
      file: archivePath,
      cwd: sourceDir
    }, ['.']);

    const record = await new PackageInstaller(runtimeRoot, () => '2026-05-20T00:00:00.000Z').install({
      surface: 'api-adapter',
      source: {
        kind: 'local_archive',
        path: archivePath
      }
    });

    expect(record.packageId).toBe('acme/http-alt');
    expect(existsSync(join(record.installPath, 'node_modules', 'moorline-test-runtime-dep', 'index.mjs'))).toBe(true);
    expect(existsSync(join(record.installPath, 'package-lock.json'))).toBe(false);
  });

  it('verifies integrity before using bundled remote archive fallback', async () => {
    const root = createTempRoot('moorline-bundled-fallback-integrity-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'source');
    writeApiAdapterPackage(sourceDir);
    const archiveName = 'moorline-api-adapter-fallback-integrity-0.0.2.tar.gz';
    const archiveDir = join(process.cwd(), 'packages', 'core', 'dist', 'installable-archives', 'api-adapters');
    const archivePath = join(archiveDir, archiveName);
    mkdirSync(archiveDir, { recursive: true });
    try {
      await create({
        gzip: true,
        file: archivePath,
        cwd: sourceDir
      }, ['.']);
      const actualIntegrity = `sha512-${createHash('sha512').update(readFileSync(archivePath)).digest('base64')}`;
      expect(actualIntegrity).not.toBe('sha512-not-real');
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('simulated network failure'));

      await expect(new PackageInstaller(runtimeRoot, () => '2026-05-20T00:00:00.000Z').install({
        surface: 'api-adapter',
        source: {
          kind: 'remote_archive',
          url: `https://github.com/Moorline/moorline/releases/download/v0.0.2/${archiveName}`,
          integrity: 'sha512-not-real'
        }
      })).rejects.toThrow(/Bundled archive integrity mismatch/u);
      expect(existsSync(join(runtimeRoot, 'packages', 'api-adapters', 'acme', 'http-alt'))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      rmSync(archivePath, { force: true });
    }
  });

  it('installs bundle members from embedded package directories', async () => {
    const root = createTempRoot('moorline-embedded-bundle-install-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'bundle-source');
    writeBundlePackage(sourceDir);
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
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
    const record = await service.installPackage({
      kind: 'bundle',
      source: {
        kind: 'local_dir',
        path: sourceDir
      }
    });

    expect(record.packageId).toBe('rync/basic-essentials');
    const state = new PackageInventoryStore(runtimeRoot).load();
    expect(state.installed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'bundle',
        packageId: 'rync/basic-essentials'
      }),
      expect.objectContaining({
        kind: 'plugin',
        packageId: 'rync/status',
        installedByPackageIds: ['rync/basic-essentials'],
        activatedByPackageIds: ['rync/basic-essentials'],
        source: {
          kind: 'local_dir',
          path: join(runtimeRoot, 'packages', 'bundles', 'rync', 'basic-essentials', 'packages', 'plugins', 'rync', 'status')
        }
      })
    ]));
    expect(config.surfaces.plugins.enabledPackageIds).toContain('rync/status');
  });

  it('removes bundle-owned activation while keeping a manually installed member package', async () => {
    const root = createTempRoot('moorline-bundle-activation-owner-');
    const runtimeRoot = join(root, 'runtime');
    const pluginSourceDir = join(root, 'plugin-source');
    const bundleSourceDir = join(root, 'bundle-source');
    writePluginPackage(pluginSourceDir, {
      packageId: 'rync/status'
    });
    writeBundlePackage(bundleSourceDir);
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
      version: 4,
      runtimeRoot,
      admin: defaultAdminConfig(),
      main: defaultMainProcessConfig(),
      defaults: {
        runtimeMode: 'full-access',
        model: 'latest'
      },
      surface,
      setup: {
        completed: false
      },
      surfaces: {
        apiAdapter: {
          activePackageId: 'moorline/http',
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

    await service.installPackage({
      kind: 'plugin',
      source: {
        kind: 'local_dir',
        path: pluginSourceDir
      }
    });
    await service.installPackage({
      kind: 'bundle',
      source: {
        kind: 'local_dir',
        path: bundleSourceDir
      }
    });
    expect(config.surfaces.plugins.enabledPackageIds).toEqual(['rync/status']);
    expect(new PackageInventoryStore(runtimeRoot).load().installed.find((entry) => entry.kind === 'plugin')).toMatchObject({
      packageId: 'rync/status',
      activatedByPackageIds: ['rync/basic-essentials']
    });

    service.removePackage({
      kind: 'bundle',
      packageId: 'rync/basic-essentials'
    });

    expect(config.surfaces.plugins.enabledPackageIds).toEqual([]);
    const remainingPlugin = new PackageInventoryStore(runtimeRoot).load().installed[0];
    expect(remainingPlugin).toMatchObject({
      kind: 'plugin',
      packageId: 'rync/status'
    });
    expect(remainingPlugin).not.toHaveProperty('activatedByPackageIds');
    expect(remainingPlugin).not.toHaveProperty('installedByPackageIds');
  });

  it('preserves manual activation when removing a bundle that reused an active member package', async () => {
    const root = createTempRoot('moorline-bundle-manual-activation-');
    const runtimeRoot = join(root, 'runtime');
    const pluginSourceDir = join(root, 'plugin-source');
    const bundleSourceDir = join(root, 'bundle-source');
    writePluginPackage(pluginSourceDir, {
      packageId: 'rync/status'
    });
    writeBundlePackage(bundleSourceDir);
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
      version: 4,
      runtimeRoot,
      admin: defaultAdminConfig(),
      main: defaultMainProcessConfig(),
      defaults: {
        runtimeMode: 'full-access',
        model: 'latest'
      },
      surface,
      setup: {
        completed: false
      },
      surfaces: {
        apiAdapter: {
          activePackageId: 'moorline/http',
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

    await service.installPackage({
      kind: 'plugin',
      source: {
        kind: 'local_dir',
        path: pluginSourceDir
      }
    });
    service.enablePackage('plugin', 'rync/status');
    await service.installPackage({
      kind: 'bundle',
      source: {
        kind: 'local_dir',
        path: bundleSourceDir
      }
    });

    const activePlugin = new PackageInventoryStore(runtimeRoot).load().installed.find((entry) => entry.kind === 'plugin');
    expect(activePlugin).toMatchObject({
      packageId: 'rync/status'
    });
    expect(activePlugin).not.toHaveProperty('activatedByPackageIds');
    service.removePackage({
      kind: 'bundle',
      packageId: 'rync/basic-essentials'
    });

    expect(config.surfaces.plugins.enabledPackageIds).toEqual(['rync/status']);
    expect(new PackageInventoryStore(runtimeRoot).load().installed).toEqual([
      expect.objectContaining({
        kind: 'plugin',
        packageId: 'rync/status'
      })
    ]);
  });

  it('preserves bundle activation ownership when replacing an activated member package', async () => {
    const root = createTempRoot('moorline-bundle-activation-replace-');
    const runtimeRoot = join(root, 'runtime');
    const bundleSourceDir = join(root, 'bundle-source');
    const replacementSourceDir = join(root, 'replacement-source');
    writeBundlePackage(bundleSourceDir);
    writePluginPackage(replacementSourceDir, {
      packageId: 'rync/status'
    });
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
      version: 4,
      runtimeRoot,
      admin: defaultAdminConfig(),
      main: defaultMainProcessConfig(),
      defaults: {
        runtimeMode: 'full-access',
        model: 'latest'
      },
      surface,
      setup: {
        completed: false
      },
      surfaces: {
        apiAdapter: {
          activePackageId: 'moorline/http',
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

    await service.installPackage({
      kind: 'bundle',
      source: {
        kind: 'local_dir',
        path: bundleSourceDir
      }
    });
    await service.installPackage({
      kind: 'plugin',
      source: {
        kind: 'local_dir',
        path: replacementSourceDir
      }
    });

    expect(new PackageInventoryStore(runtimeRoot).load().installed.find((entry) => entry.kind === 'plugin')).toMatchObject({
      packageId: 'rync/status',
      installedByPackageIds: ['rync/basic-essentials'],
      activatedByPackageIds: ['rync/basic-essentials']
    });
    service.removePackage({
      kind: 'bundle',
      packageId: 'rync/basic-essentials',
      cascade: true
    });

    expect(config.surfaces.plugins.enabledPackageIds).toEqual([]);
    expect(new PackageInventoryStore(runtimeRoot).load().installed).toEqual([]);
  });

  it('keeps shared bundle-owned activation until the last owning bundle is removed', async () => {
    const root = createTempRoot('moorline-bundle-shared-activation-');
    const runtimeRoot = join(root, 'runtime');
    const firstBundleSourceDir = join(root, 'bundle-source-first');
    const secondBundleSourceDir = join(root, 'bundle-source-second');
    writeBundlePackage(firstBundleSourceDir, 'rync/basic-essentials');
    writeBundlePackage(secondBundleSourceDir, 'rync/extra-essentials');
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
      version: 4,
      runtimeRoot,
      admin: defaultAdminConfig(),
      main: defaultMainProcessConfig(),
      defaults: {
        runtimeMode: 'full-access',
        model: 'latest'
      },
      surface,
      setup: {
        completed: false
      },
      surfaces: {
        apiAdapter: {
          activePackageId: 'moorline/http',
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

    await service.installPackage({
      kind: 'bundle',
      source: {
        kind: 'local_dir',
        path: firstBundleSourceDir
      }
    });
    await service.installPackage({
      kind: 'bundle',
      source: {
        kind: 'local_dir',
        path: secondBundleSourceDir
      }
    });

    expect(new PackageInventoryStore(runtimeRoot).load().installed.find((entry) => entry.kind === 'plugin')).toMatchObject({
      packageId: 'rync/status',
      installedByPackageIds: ['rync/basic-essentials', 'rync/extra-essentials'],
      activatedByPackageIds: ['rync/basic-essentials', 'rync/extra-essentials']
    });
    service.removePackage({
      kind: 'bundle',
      packageId: 'rync/basic-essentials'
    });

    expect(config.surfaces.plugins.enabledPackageIds).toEqual(['rync/status']);
    expect(new PackageInventoryStore(runtimeRoot).load().installed.find((entry) => entry.kind === 'plugin')).toMatchObject({
      packageId: 'rync/status',
      installedByPackageIds: ['rync/extra-essentials'],
      activatedByPackageIds: ['rync/extra-essentials']
    });
    service.removePackage({
      kind: 'bundle',
      packageId: 'rync/extra-essentials',
      cascade: true
    });

    expect(config.surfaces.plugins.enabledPackageIds).toEqual([]);
    expect(new PackageInventoryStore(runtimeRoot).load().installed).toEqual([]);
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

  it('normalizes bundle owner package ids when inventory is reloaded', () => {
    const root = createTempRoot('moorline-owner-id-inventory-');
    const runtimeRoot = join(root, 'runtime');
    const store = new PackageInventoryStore(runtimeRoot);
    store.ensureInitialized();
    writeFileSync(
      store.path(),
      JSON.stringify(
        {
          version: 1,
          installed: [{
            family: 'installable',
            kind: 'plugin',
            surface: 'plugin',
            packageId: 'rync/status',
            name: 'rync/status',
            version: '1.0.0',
            installPath: join(runtimeRoot, 'packages', 'plugins', 'rync', 'status'),
            source: {
              kind: 'local_dir',
              path: join(root, 'source')
            },
            installedAt: '2026-05-20T00:00:00.000Z',
            manifestPath: join(runtimeRoot, 'packages', 'plugins', 'rync', 'status', 'manifest.json'),
            manifestHash: 'abc123',
            dependencies: [],
            installedByPackageIds: ['rync/basic-essentials', 'bad owner', 'rync/basic-essentials', 42],
            activatedByPackageIds: ['rync/basic-essentials', '../bad', 'rync/extra-essentials']
          }],
          applied: {
            activated: []
          }
        },
        null,
        2
      ),
      'utf8'
    );

    expect(store.load().installed[0]).toMatchObject({
      installedByPackageIds: ['rync/basic-essentials'],
      activatedByPackageIds: ['rync/basic-essentials', 'rync/extra-essentials']
    });
  });

  it('rejects moorline/http configuration before inventory installation', () => {
    const root = createTempRoot('moorline-http-package-config-');
    const runtimeRoot = join(root, 'runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
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
          enabledPackageIds: ['rync/status'],
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
      packageId: 'moorline/http',
      values: {
        host: '127.0.0.1',
        port: '45678',
        exposure: 'remote'
      }
    })).toThrow(/not installed/i);
  });

  it('does not copy custom api-adapter config back into moorline/http when reselected', () => {
    const root = createTempRoot('moorline-api-adapter-reselect-http-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'source');
    const httpSourceDir = join(root, 'http-source');
    writeApiAdapterPackage(sourceDir);
    writeApiAdapterPackage(httpSourceDir, 'moorline/http');
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
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
      installed: [
        installedApiAdapterRecord({ runtimeRoot, packageId: 'acme/http-alt', sourceDir }),
        installedApiAdapterRecord({ runtimeRoot, packageId: 'moorline/http', sourceDir: httpSourceDir })
      ],
      applied: {
        activated: []
      }
    });

    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);
    service.setSelectedPackage('api-adapter', 'moorline/http');

    expect(config.surfaces.apiAdapter.activePackageId).toBe('moorline/http');
    expect(config.surfaces.apiAdapter.config).toEqual({});
    expect(config.surfaces.apiAdapter.config).not.toMatchObject({
      host: '0.0.0.0',
      port: 49999,
      exposure: 'remote',
      token: 'custom-secret'
    });
  });

  it('preserves saved moorline/http package config while a custom api-adapter is selected', async () => {
    const root = createTempRoot('moorline-api-adapter-preserve-http-config-');
    const runtimeRoot = join(root, 'runtime');
    const sourceDir = join(root, 'source');
    const httpSourceDir = join(root, 'http-source');
    writeApiAdapterPackage(sourceDir);
    writeApiAdapterPackage(httpSourceDir, 'moorline/http');
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
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
          activePackageId: 'acme/http-alt',
          config: {
            host: '0.0.0.0',
            port: 49999,
            exposure: 'remote',
            token: 'custom-secret'
          },
          configByPackageId: {
            'moorline/http': {
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
      installed: [
        installedApiAdapterRecord({ runtimeRoot, packageId: 'acme/http-alt', sourceDir }),
        installedApiAdapterRecord({ runtimeRoot, packageId: 'moorline/http', sourceDir: httpSourceDir })
      ],
      applied: {
        activated: []
      }
    });

    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);
    service.setSelectedPackage('api-adapter', 'moorline/http');

    expect(config.surfaces.apiAdapter.configByPackageId['moorline/http']).toMatchObject({
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

  it('rejects a fresh setup with moorline/http absent from inventory', async () => {
    const root = createTempRoot('moorline-http-package-apply-');
    const runtimeRoot = join(root, 'runtime');
    const transportPath = join(runtimeRoot, 'packages', 'transports', 'rync', 'transport');
    writeTransportPackage(transportPath);
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
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
          config: defaultHttpApiAdapterConfig(),
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'rync/transport',
          config: {
            accessToken: 'token',
            scopeId: 'scope',
            transportClientId: 'app',
            actorId: 'actor',
            accessPermissions: '0'
          },
          configByPackageId: {}
        },
        provider: {
          activePackageId: 'acme/provider',
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
          packageId: 'rync/transport',
          name: 'rync/transport',
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
          packageId: 'acme/provider',
          name: 'acme/provider',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'providers', 'acme', 'provider'),
          source: { kind: 'local_dir', path: join(root, 'provider') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'provider', 'manifest.json'),
          manifestHash: 'provider-hash',
          dependencies: []
        },
        {
          family: 'installable',
          kind: 'plugin',
          surface: 'plugin',
          packageId: 'rync/status',
          name: 'rync/status',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'plugins', 'rync', 'status'),
          source: { kind: 'local_dir', path: join(root, 'status') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'status', 'manifest.json'),
          manifestHash: 'plugin-hash',
          dependencies: [{
            surface: 'api-adapter',
            packageId: 'moorline/http',
            requiredState: 'active'
          }]
        }
      ],
      applied: {
        activated: []
      }
    });

    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);
    await expect(service.apply()).rejects.toThrow(/No API adapter package is activated|not installed|not declared/i);
  });

  it('clears stale applied transport config when the active transport package is removed', () => {
    const root = createTempRoot('moorline-remove-active-transport-');
    const runtimeRoot = join(root, 'runtime');
    const apiPath = join(runtimeRoot, 'packages', 'api-adapters', 'moorline', 'http');
    const transportPath = join(runtimeRoot, 'packages', 'transports', 'rync', 'transport');
    const providerPath = join(runtimeRoot, 'packages', 'providers', 'acme', 'provider');
    writeApiAdapterPackage(apiPath, 'moorline/http');
    writeTransportPackage(transportPath);
    writeProviderPackage(providerPath);
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
      version: 4,
      runtimeRoot,
      transport: {
        kind: 'transport',
        packageId: 'rync/transport',
        config: {
          scopeId: 'scope'
        },
        scopeId: 'scope'
      },
      provider: {
        kind: 'provider',
        packageId: 'acme/provider',
        config: {}
      },
      admin: defaultAdminConfig(),
      main: defaultMainProcessConfig(),
      defaults: {
        runtimeMode: 'full-access',
        model: 'latest'
      },
      surface,
      setup: {
        completed: true,
        completedAt: '2026-05-20T00:00:00.000Z'
      },
      surfaces: {
        apiAdapter: {
          activePackageId: 'moorline/http',
          config: {},
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'rync/transport',
          config: {
            scopeId: 'scope'
          },
          configByPackageId: {
            'rync/transport': {
              scopeId: 'scope'
            }
          }
        },
        provider: {
          activePackageId: 'acme/provider',
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
        installedApiAdapterRecord({
          runtimeRoot,
          packageId: 'moorline/http',
          sourceDir: apiPath
        }),
        {
          family: 'installable',
          kind: 'transport',
          surface: 'transport',
          packageId: 'rync/transport',
          name: 'rync/transport',
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
          packageId: 'acme/provider',
          name: 'acme/provider',
          version: '1.0.0',
          installPath: providerPath,
          source: { kind: 'local_dir', path: providerPath },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(providerPath, 'manifest.json'),
          manifestHash: 'provider-hash',
          dependencies: []
        }
      ],
      applied: {
        activated: [
          { surface: 'api-adapter', packageId: 'moorline/http' },
          { surface: 'transport', packageId: 'rync/transport' },
          { surface: 'provider', packageId: 'acme/provider' }
        ]
      }
    });

    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);
    service.removePackage({ kind: 'transport', packageId: 'rync/transport', cascade: true });

    expect(config.surfaces.transport.activePackageId).toBeNull();
    expect(config.transport).toBeUndefined();
    expect(config.surfaces.transport.configByPackageId).not.toHaveProperty('rync/transport');
    expect(config.setup.completed).toBe(false);
    const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as MoorlineConfig;
    expect(persisted.transport).toBeUndefined();
    expect(persisted.setup.completed).toBe(false);
    expect(store.load().applied.activated).not.toContainEqual({ surface: 'transport', packageId: 'rync/transport' });
  });

  it('marks setup incomplete when apply fails while loading the selected transport package', async () => {
    const root = createTempRoot('moorline-apply-corrupt-transport-');
    const runtimeRoot = join(root, 'runtime');
    const apiPath = join(runtimeRoot, 'packages', 'api-adapters', 'moorline', 'http');
    const transportPath = join(runtimeRoot, 'packages', 'transports', 'rync', 'transport');
    const providerPath = join(runtimeRoot, 'packages', 'providers', 'acme', 'provider');
    writeApiAdapterPackage(apiPath, 'moorline/http');
    writeTransportPackage(transportPath);
    writeProviderPackage(providerPath);
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
      version: 4,
      runtimeRoot,
      transport: {
        kind: 'transport',
        packageId: 'rync/transport',
        config: {
          scopeId: 'scope'
        },
        scopeId: 'scope'
      },
      provider: {
        kind: 'provider',
        packageId: 'acme/provider',
        config: {}
      },
      admin: defaultAdminConfig(),
      main: defaultMainProcessConfig(),
      defaults: {
        runtimeMode: 'full-access',
        model: 'latest'
      },
      surface,
      setup: {
        completed: true,
        completedAt: '2026-05-20T00:00:00.000Z'
      },
      surfaces: {
        apiAdapter: {
          activePackageId: 'moorline/http',
          config: {},
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'rync/transport',
          config: {
            scopeId: 'scope'
          },
          configByPackageId: {
            'rync/transport': {
              scopeId: 'scope'
            }
          }
        },
        provider: {
          activePackageId: 'acme/provider',
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
    new PackageInventoryStore(runtimeRoot).save({
      version: 1,
      installed: [
        installedApiAdapterRecord({
          runtimeRoot,
          packageId: 'moorline/http',
          sourceDir: apiPath
        }),
        {
          family: 'installable',
          kind: 'transport',
          surface: 'transport',
          packageId: 'rync/transport',
          name: 'rync/transport',
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
          packageId: 'acme/provider',
          name: 'acme/provider',
          version: '1.0.0',
          installPath: providerPath,
          source: { kind: 'local_dir', path: providerPath },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(providerPath, 'manifest.json'),
          manifestHash: 'provider-hash',
          dependencies: []
        }
      ],
      applied: {
        activated: [
          { surface: 'api-adapter', packageId: 'moorline/http' },
          { surface: 'transport', packageId: 'rync/transport' },
          { surface: 'provider', packageId: 'acme/provider' }
        ]
      }
    });
    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);
    writeFileSync(join(transportPath, 'manifest.json'), '{bad json', 'utf8');

    await expect(service.apply()).rejects.toThrow(/JSON/);

    expect(config.setup.completed).toBe(false);
    const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as MoorlineConfig;
    expect(persisted.setup.completed).toBe(false);
  });

  it('keeps setup incomplete when selected transport completeConfig fails during apply', async () => {
    const root = createTempRoot('moorline-apply-transport-complete-fail-');
    const runtimeRoot = join(root, 'runtime');
    const apiPath = join(runtimeRoot, 'packages', 'api-adapters', 'moorline', 'http');
    const transportPath = join(runtimeRoot, 'packages', 'transports', 'rync', 'transport');
    const providerPath = join(runtimeRoot, 'packages', 'providers', 'acme', 'provider');
    writeApiAdapterPackage(apiPath, 'moorline/http');
    writeTransportPackage(transportPath);
    writeProviderPackage(providerPath);
    writeFileSync(
      join(transportPath, 'index.mjs'),
      [
        "import manifest from './manifest.json' with { type: 'json' };",
        'export default {',
        '  manifest,',
        "  completeConfig() { throw new Error('transport complete failed'); },",
        '  createTransport() { return {}; }',
        '};'
      ].join('\n'),
      'utf8'
    );
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
      version: 4,
      runtimeRoot,
      transport: {
        kind: 'transport',
        packageId: 'rync/transport',
        config: {
          scopeId: 'scope'
        },
        scopeId: 'scope'
      },
      provider: {
        kind: 'provider',
        packageId: 'acme/provider',
        config: {}
      },
      admin: defaultAdminConfig(),
      main: defaultMainProcessConfig(),
      defaults: {
        runtimeMode: 'full-access',
        model: 'latest'
      },
      surface,
      setup: {
        completed: true,
        completedAt: '2026-05-20T00:00:00.000Z'
      },
      surfaces: {
        apiAdapter: {
          activePackageId: 'moorline/http',
          config: {},
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'rync/transport',
          config: {
            scopeId: 'scope'
          },
          configByPackageId: {
            'rync/transport': {
              scopeId: 'scope'
            }
          }
        },
        provider: {
          activePackageId: 'acme/provider',
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
    new PackageInventoryStore(runtimeRoot).save({
      version: 1,
      installed: [
        installedApiAdapterRecord({
          runtimeRoot,
          packageId: 'moorline/http',
          sourceDir: apiPath
        }),
        {
          family: 'installable',
          kind: 'transport',
          surface: 'transport',
          packageId: 'rync/transport',
          name: 'rync/transport',
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
          packageId: 'acme/provider',
          name: 'acme/provider',
          version: '1.0.0',
          installPath: providerPath,
          source: { kind: 'local_dir', path: providerPath },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(providerPath, 'manifest.json'),
          manifestHash: 'provider-hash',
          dependencies: []
        }
      ],
      applied: {
        activated: [
          { surface: 'api-adapter', packageId: 'moorline/http' },
          { surface: 'transport', packageId: 'rync/transport' },
          { surface: 'provider', packageId: 'acme/provider' }
        ]
      }
    });
    const service = new OperatorPackageService(config, configPath, () => '2026-05-20T00:00:00.000Z', root);

    await expect(service.apply()).rejects.toThrow(/transport complete failed/u);

    expect(config.setup.completed).toBe(false);
    const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as MoorlineConfig;
    expect(persisted.setup.completed).toBe(false);
  });

  it('rejects selected api-adapters with missing required config before apply completes', async () => {
    const root = createTempRoot('moorline-api-adapter-schema-');
    const runtimeRoot = join(root, 'runtime');
    const transportPath = join(runtimeRoot, 'packages', 'transports', 'rync', 'transport');
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
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
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
          activePackageId: 'acme/required-http',
          config: {},
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'rync/transport',
          config: {
            accessToken: 'token',
            scopeId: 'scope',
            transportClientId: 'app',
            actorId: 'actor',
            accessPermissions: '0'
          },
          configByPackageId: {}
        },
        provider: {
          activePackageId: 'acme/provider',
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
        packageId: 'rync/transport',
        name: 'rync/transport',
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
        packageId: 'acme/provider',
        name: 'acme/provider',
        version: '1.0.0',
        installPath: join(runtimeRoot, 'packages', 'providers', 'acme', 'provider'),
        source: { kind: 'local_dir', path: join(root, 'provider') },
        installedAt: '2026-05-20T00:00:00.000Z',
        manifestPath: join(root, 'provider', 'manifest.json'),
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
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
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
          activePackageId: null,
          config: {},
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'rync/transport',
          config: {},
          configByPackageId: {}
        },
        provider: {
          activePackageId: 'acme/provider',
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
          packageId: 'rync/transport',
          name: 'rync/transport',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'transports', 'rync', 'transport'),
          source: { kind: 'local_dir', path: join(root, 'transport') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'transport', 'manifest.json'),
          manifestHash: 'transport-hash',
          dependencies: []
        },
        {
          family: 'installable',
          kind: 'provider',
          surface: 'provider',
          packageId: 'acme/provider',
          name: 'acme/provider',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'providers', 'acme', 'provider'),
          source: { kind: 'local_dir', path: join(root, 'provider') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'provider', 'manifest.json'),
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

  it('rejects schema-invalid moorline/http adapter config during startability checks', () => {
    const root = createTempRoot('moorline-http-startability-config-');
    const runtimeRoot = join(root, 'runtime');
    const httpInstallPath = join(runtimeRoot, 'packages', 'api-adapters', 'moorline', 'http');
    mkdirSync(httpInstallPath, { recursive: true });
    writeFileSync(
      join(httpInstallPath, 'manifest.json'),
      JSON.stringify(
        {
          id: 'moorline/http',
          name: 'moorline/http',
          version: '1.2.3',
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
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
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
            host: '127.0.0.1',
            port: '45173',
            exposure: 'private'
          },
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'rync/transport',
          config: {},
          configByPackageId: {}
        },
        provider: {
          activePackageId: 'acme/provider',
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
        installedApiAdapterRecord({ runtimeRoot, packageId: 'moorline/http', sourceDir: join(root, 'http') }),
        {
          family: 'installable',
          kind: 'transport',
          surface: 'transport',
          packageId: 'rync/transport',
          name: 'rync/transport',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'transports', 'rync', 'transport'),
          source: { kind: 'local_dir', path: join(root, 'transport') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'transport', 'manifest.json'),
          manifestHash: 'transport-hash',
          dependencies: []
        },
        {
          family: 'installable',
          kind: 'provider',
          surface: 'provider',
          packageId: 'acme/provider',
          name: 'acme/provider',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'providers', 'acme', 'provider'),
          source: { kind: 'local_dir', path: join(root, 'provider') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'provider', 'manifest.json'),
          manifestHash: 'provider-hash',
          dependencies: []
        }
      ],
      applied: {
        activated: []
      }
    });

    expect(result.startable).toBe(false);
    expect(result.issues.join('\n')).toMatch(/port must be a number|exposure must be one of/i);
  });

  it('accepts default moorline/http adapter config against the real package schema', () => {
    const root = createTempRoot('moorline-http-default-startability-config-');
    const runtimeRoot = join(root, 'runtime');
    const httpInstallPath = join(runtimeRoot, 'packages', 'api-adapters', 'moorline', 'http');
    mkdirSync(httpInstallPath, { recursive: true });
    writeFileSync(
      join(httpInstallPath, 'manifest.json'),
      readFileSync(join(process.cwd(), 'packages', 'http', 'manifest.json'), 'utf8'),
      'utf8'
    );
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
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
          config: defaultHttpApiAdapterConfig(),
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'rync/transport',
          config: {},
          configByPackageId: {}
        },
        provider: {
          activePackageId: 'acme/provider',
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
        installedApiAdapterRecord({ runtimeRoot, packageId: 'moorline/http', sourceDir: join(root, 'http') }),
        {
          family: 'installable',
          kind: 'transport',
          surface: 'transport',
          packageId: 'rync/transport',
          name: 'rync/transport',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'transports', 'rync', 'transport'),
          source: { kind: 'local_dir', path: join(root, 'transport') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'transport', 'manifest.json'),
          manifestHash: 'transport-hash',
          dependencies: []
        },
        {
          family: 'installable',
          kind: 'provider',
          surface: 'provider',
          packageId: 'acme/provider',
          name: 'acme/provider',
          version: '1.0.0',
          installPath: join(runtimeRoot, 'packages', 'providers', 'acme', 'provider'),
          source: { kind: 'local_dir', path: join(root, 'provider') },
          installedAt: '2026-05-20T00:00:00.000Z',
          manifestPath: join(root, 'provider', 'manifest.json'),
          manifestHash: 'provider-hash',
          dependencies: []
        }
      ],
      applied: {
        activated: []
      }
    });

    expect(result.startable).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('coerces JSON scalar package config input before schema validation', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        port: { type: 'number' as const },
        enabled: { type: 'boolean' as const },
        label: { type: 'string' as const }
      }
    };

    expect(coerceSurfaceConfigInput({
      surface: 'transport',
      packageId: 'rync/transport',
      schema,
      key: 'port',
      rawValue: 4536
    })).toBe(4536);
    expect(coerceSurfaceConfigInput({
      surface: 'transport',
      packageId: 'rync/transport',
      schema,
      key: 'enabled',
      rawValue: true
    })).toBe(true);
    expect(coerceSurfaceConfigInput({
      surface: 'transport',
      packageId: 'rync/transport',
      schema,
      key: 'label',
      rawValue: 123
    })).toBe('123');
    expect(() => coerceSurfaceConfigInput({
      surface: 'transport',
      packageId: 'rync/transport',
      schema,
      key: 'label',
      rawValue: { value: 'bad' }
    })).toThrow(/must be a string, number, or boolean/u);
  });

  it('does not carry stale moorline/http config when selecting and configuring a custom api-adapter from fresh defaults', async () => {
    const root = createTempRoot('moorline-api-adapter-switch-');
    const runtimeRoot = join(root, 'runtime');
    const transportPath = join(runtimeRoot, 'packages', 'transports', 'rync', 'transport');
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
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
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
          config: defaultHttpApiAdapterConfig(),
          configByPackageId: {}
        },
        transport: {
          activePackageId: 'rync/transport',
          config: {
            accessToken: 'token',
            scopeId: 'scope',
            transportClientId: 'app',
            actorId: 'actor',
            accessPermissions: '0'
          },
          configByPackageId: {}
        },
        provider: {
          activePackageId: 'acme/provider',
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
        packageId: 'rync/transport',
        name: 'rync/transport',
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
        packageId: 'acme/provider',
        name: 'acme/provider',
        version: '1.0.0',
        installPath: join(runtimeRoot, 'packages', 'providers', 'acme', 'provider'),
        source: { kind: 'local_dir', path: join(root, 'provider') },
        installedAt: '2026-05-20T00:00:00.000Z',
        manifestPath: join(root, 'provider', 'manifest.json'),
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
    expect(config.surfaces.apiAdapter.config).not.toHaveProperty('moorline/http');
    await expect(service.apply()).resolves.toMatchObject({
      errors: []
    });
  });

  it('includes the selected api-adapter in setup share bundle package summaries', () => {
    const root = createTempRoot('moorline-api-adapter-share-');
    const runtimeRoot = join(root, 'runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    const surface = defaultSurfaceNames();
    const config: MoorlineConfig = {
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
      selectedApiAdapterPackageId: 'moorline/http',
      selectedTransportPackageId: null,
      selectedProviderPackageId: null
    });
  });
});
