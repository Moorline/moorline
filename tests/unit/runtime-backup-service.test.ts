import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntimeBackup, importRuntimeBackup } from '../../packages/core/src/core/system/backup/runtimeBackupService.js';
import { runtimePaths } from '../../packages/core/src/core/system/config/configStore.js';
import { runMigrations } from '../../packages/core/src/core/system/state/migrationRunner.js';
import { SqliteSessionStore } from '../../packages/core/src/core/system/state/sqliteSessionStore.js';
import { defaultAdminConfig, defaultMainProcessConfig, defaultSurfaceNames, type MoorlineConfig } from '../../packages/core/src/types/config.js';
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
      completed: true
    },
    surfaces: {
      apiAdapter: {
        activePackageId: 'moorline/http',
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
    }
  };
}

describe('runtime backup import', () => {
  it('rewrites restored session workspace paths into the target runtime root', async () => {
    const root = createTempRoot('moorline-runtime-backup-');
    const sourceRuntimeRoot = join(root, 'source.runtime');
    const sourceConfigPath = join(root, 'source.json');
    const sourceConfig = config(sourceRuntimeRoot);
    const sourcePaths = runtimePaths(sourceRuntimeRoot);
    mkdirSync(sourcePaths.stateDir, { recursive: true });
    mkdirSync(sourcePaths.workspacesDir, { recursive: true });
    runMigrations(sourcePaths.sqlitePath, join(process.cwd(), 'packages', 'core', 'resources', 'migrations'));
    writeFileSync(sourceConfigPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, 'utf8');
    writeFileSync(join(sourcePaths.stateDir, 'control-api-bootstrap.json'), `${JSON.stringify({
      version: 1,
      protocol: 'http',
      adapterPackageId: 'moorline/http',
      pid: 123,
      url: 'http://127.0.0.1:45173',
      token: 'source-token',
      startedAt: '2026-06-08T00:00:00.000Z',
      configPath: sourceConfigPath
    }, null, 2)}\n`, 'utf8');
    writeFileSync(sourcePaths.packageInventoryPath, `${JSON.stringify({
      version: 1,
      installed: [{
        family: 'installable',
        kind: 'transport',
        surface: 'transport',
        packageId: 'rync/discord',
        name: 'rync/discord',
        version: '0.0.2',
        installedAt: '2026-06-08T00:00:00.000Z',
        installPath: join(sourceRuntimeRoot, 'packages', 'transports', 'rync', 'discord'),
        source: {
          kind: 'local_dir',
          path: join(sourceRuntimeRoot, 'packages', 'bundles', 'rync', 'discord-default', 'packages', 'transports', 'rync', 'discord')
        },
        manifestPath: join(sourceRuntimeRoot, 'packages', 'transports', 'rync', 'discord', 'manifest.json'),
        manifestHash: 'hash',
        dependencies: []
      }],
      applied: {
        activated: []
      }
    }, null, 2)}\n`, 'utf8');

    const sourceStore = new SqliteSessionStore(sourcePaths.sqlitePath);
    try {
      sourceStore.upsertSession({
        sessionId: 'session-imported',
        scopeId: 'local',
        transportResourceId: 'session-imported-1',
        threadId: 'session:session-imported',
        transportResourceName: 'session-imported',
        workspacePath: join(sourcePaths.workspacesDir, 'session-imported'),
        runtimeMode: 'full-access',
        lifecycleStatus: 'archived',
        summary: null,
        provider: 'rync/pi',
        providerThreadId: null,
        providerStatus: 'closed',
        providerAutoStartEnabled: true,
        activeTurnId: null,
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z',
        lastActivityAt: '2026-06-08T00:00:00.000Z',
        archivedAt: '2026-06-08T00:00:00.000Z',
        lastError: null,
        ownerKind: 'orchestrator',
        ownerId: 'app:control-api',
        ownerLabel: 'app:control-api',
        objective: 'Import workspace rewrite',
        tags: [],
        createdBy: 'app:control-api',
        lastDirectedAt: null,
        lastDirectedBy: null
      });
    } finally {
      sourceStore.close();
    }

    const archivePath = join(root, 'backup.tgz');
    await createRuntimeBackup({
      config: sourceConfig,
      configPath: sourceConfigPath,
      includeWorkspaces: false,
      outputPath: archivePath,
      nowIso: '2026-06-08T00:01:00.000Z'
    });

    const targetRuntimeRoot = join(root, 'target.runtime');
    const targetConfigPath = join(root, 'target.json');
    await importRuntimeBackup({
      archivePath,
      targetConfigPath,
      targetRuntimeRoot,
      force: false
    });

    const targetPaths = runtimePaths(targetRuntimeRoot);
    const targetStore = new SqliteSessionStore(targetPaths.sqlitePath);
    try {
      const session = targetStore.getSession('session-imported');
      expect(session?.workspacePath).toBe(join(targetPaths.workspacesDir, 'session-imported'));
      expect(existsSync(join(targetPaths.workspacesDir, 'session-imported'))).toBe(true);
    } finally {
      targetStore.close();
    }
    expect(existsSync(join(targetPaths.stateDir, 'control-api-bootstrap.json'))).toBe(false);
    const inventory = JSON.parse(readFileSync(targetPaths.packageInventoryPath, 'utf8')) as {
      installed: Array<{
        installPath: string;
        manifestPath: string;
        source: { kind: string; path?: string };
      }>;
    };
    expect(inventory.installed[0]?.installPath).toBe(join(targetRuntimeRoot, 'packages', 'transports', 'rync', 'discord'));
    expect(inventory.installed[0]?.manifestPath).toBe(join(targetRuntimeRoot, 'packages', 'transports', 'rync', 'discord', 'manifest.json'));
    expect(inventory.installed[0]?.source.path).toBe(join(targetRuntimeRoot, 'packages', 'bundles', 'rync', 'discord-default', 'packages', 'transports', 'rync', 'discord'));
  });
});
