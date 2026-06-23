import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePackageId } from '../../packages/contracts/src/package.js';
import { parseRuntimeAgentKind } from '../../packages/contracts/src/runtime.js';
import {
  DEFAULT_PROVIDER_TOOL_POLICY,
  validateProviderPackageManifest,
  validateProviderResourceBundle,
  validateProviderResumeCursor,
  validateProviderToolDefinition,
  validateProviderToolPolicyConfig,
  validateRuntimeProviderSessionInput
} from '../../packages/contracts/src/provider.js';

const root = process.cwd();
const hostPackages = ['cli', 'contracts', 'control-api', 'core', 'http'];
const legacyRepoSlug = [`Ryz${'on3'}`, 'Moorline'].join('/');

function packageJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')) as Record<string, unknown>;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function readSourceTree(dir: string): string {
  return readdirSync(dir, { recursive: true })
    .filter((path) => String(path).endsWith('.ts') || String(path).endsWith('.js') || String(path).endsWith('.mjs'))
    .map((path) => readFileSync(join(dir, String(path)), 'utf8'))
    .join('\n');
}

describe('host repository split contract', () => {
  it('keeps the workspace root private and points at the host repo', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.private).toBe(true);
    expect(pkg.bin).toBeUndefined();
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.license).toBe('MIT');
    expect(pkg.repository).toMatchObject({
      url: 'git+ssh://git@github.com/Moorline/moorline.git'
    });
  });

  it('keeps only host packages in the workspace', () => {
    expect(readdirSync(join(root, 'packages')).sort()).toEqual(hostPackages);
  });

  it('separates core, control api, cli, contracts, and http into npm packages', () => {
    expect(packageJson('contracts').name).toBe('@moorline/contracts');
    expect(packageJson('core').name).toBe('@moorline/core');
    expect(packageJson('control-api').name).toBe('@moorline/control-api');
    expect(packageJson('cli').name).toBe('moorline');
    expect(packageJson('http').name).toBe('@moorline/http');
    expect((packageJson('cli').bin as Record<string, string>).moorline).toBe('dist/main.js');
  });

  it('keeps host package versions in lockstep', () => {
    const rootPackage = readJson(join(root, 'package.json'));
    const expectedVersion = rootPackage.version;

    for (const name of hostPackages) {
      const pkg = packageJson(name);
      expect(pkg.version).toBe(expectedVersion);
      for (const [dependencyName, dependencyVersion] of Object.entries((pkg.dependencies ?? {}) as Record<string, string>)) {
        if (dependencyName.startsWith('@moorline/')) {
          expect(dependencyVersion).toBe(expectedVersion);
        }
      }
    }
  });

  it('declares package entrypoints that match flattened build output', () => {
    for (const name of ['contracts', 'core', 'control-api', 'http']) {
      const pkg = packageJson(name);
      expect(pkg.main).toBe('./dist/index.js');
      expect(pkg.types).toBe('./dist/index.d.ts');
      expect(pkg.license).toBe('MIT');
    }
    expect(packageJson('cli').main).toBe('./dist/main.js');
    expect(packageJson('cli').license).toBe('MIT');
  });

  it('keeps control-api as an sdk contract without a core implementation dependency', () => {
    const controlApiPackage = packageJson('control-api');
    expect((controlApiPackage.dependencies as Record<string, string>)['@moorline/core']).toBeUndefined();
    const source = readSourceTree(join(root, 'packages', 'control-api', 'src'));
    expect(source).not.toContain('@moorline/core');
  });

  it('keeps core free of CLI, HTTP, and moved package implementation imports', () => {
    const source = readSourceTree(join(root, 'packages', 'core', 'src'));
    expect(source).not.toMatch(/@moorline\/(http|provider|transport)/);
    expect(source).not.toMatch(/from ['"][^'"]*packages\/(cli|http|provider|transport)/);
  });

  it('ships moorline/http as the default api-adapter package', () => {
    const manifest = readJson(join(root, 'packages', 'http', 'manifest.json'));
    expect(manifest.id).toBe('moorline/http');
    expect(manifest.type).toBe('api-adapter');
    expect(manifest.entrypoint).toBe('index.mjs');
    expect(existsSync(join(root, 'packages', 'http', 'index.mjs'))).toBe(true);
    expect(packageJson('http').files).toEqual(expect.arrayContaining(['index.mjs']));
    expect(packageJson('http').moorline).toMatchObject({
      packageId: 'moorline/http',
      kind: 'api-adapter'
    });
  });

  it('keeps moorline/http publish metadata aligned across package, manifest, and distro surfaces', () => {
    const pkg = packageJson('http');
    const manifest = readJson(join(root, 'packages', 'http', 'manifest.json'));
    const distro = readJson(join(root, 'packages', 'http', 'moorline.dist.json'));
    const display = distro.display as Record<string, unknown>;

    expect(manifest.id).toBe(pkg.moorline && (pkg.moorline as Record<string, unknown>).packageId);
    expect(distro.name).toBe(manifest.id);
    expect(manifest.version).toBe(pkg.version);
    expect(distro.version).toBe(pkg.version);
    expect(display.version).toBe(pkg.version);
  });

  it('does not allow the retired official package namespace', () => {
    expect(() => validatePackageId('official/http', 'package id')).toThrow(/retired official\/\*/u);
  });

  it('validates provider-native tool policy without provider-specific core types', () => {
    expect(DEFAULT_PROVIDER_TOOL_POLICY).toEqual({
      workspace: {
        nativePreset: 'provider-default'
      },
      ephemeral: {
        nativePreset: 'none',
        grants: ['core.moorline_session']
      }
    });
    expect(validateProviderToolPolicyConfig({
      workspace: {
        nativePreset: 'provider-default',
        denyNativeTools: ['bash']
      },
      ephemeral: {
        nativePreset: 'none',
        grants: ['core.moorline_session']
      }
    })).toMatchObject({
      workspace: {
        nativePreset: 'provider-default',
        denyNativeTools: ['bash']
      },
      ephemeral: {
        nativePreset: 'none',
        grants: ['core.moorline_session']
      }
    });
    expect(validateProviderPackageManifest({
      id: 'acme/provider',
      name: 'Acme Provider',
      version: '1.0.0',
      type: 'provider',
      toolPolicy: DEFAULT_PROVIDER_TOOL_POLICY,
      nativeToolDocumentation: {
        nativeToolNames: ['read', 'write'],
        defaultWorkspacePreset: 'provider-default',
        defaultEphemeralPreset: 'none',
        grantMapping: 'Moorline provider tools map to Acme custom tools.'
      }
    }).nativeToolDocumentation?.defaultEphemeralPreset).toBe('none');
    expect(() => validateProviderToolPolicyConfig({
      workspace: {
        nativePreset: ''
      },
      ephemeral: {
        nativePreset: 'none'
      }
    })).toThrow(/workspace\.nativePreset/u);
  });

  it('validates provider-native runtime session and resource contracts', () => {
    expect(parseRuntimeAgentKind('workspace')).toBe('workspace');
    expect(parseRuntimeAgentKind('ephemeral')).toBe('ephemeral');
    expect(() => parseRuntimeAgentKind('main')).toThrow(/agent_kind/u);

    expect(validateProviderResumeCursor({
      provider: 'rync/pi',
      value: { sessionFile: '/tmp/pi-session.json' }
    })).toEqual({
      provider: 'rync/pi',
      value: { sessionFile: '/tmp/pi-session.json' }
    });

    expect(validateRuntimeProviderSessionInput({
      sessionId: 'coordination-main',
      threadId: 'coordination:main',
      transportResourceId: 'discord:main',
      runtimeMode: 'approval-required',
      agentKind: 'ephemeral',
      workspacePath: null,
      providerCwd: null,
      resumeCursor: null,
      lifecycleStatus: 'hot',
      toolGrantIds: ['core.moorline_session'],
      toolPolicy: DEFAULT_PROVIDER_TOOL_POLICY
    })).toMatchObject({
      agentKind: 'ephemeral',
      workspacePath: null,
      toolGrantIds: ['core.moorline_session']
    });
    expect(() => validateRuntimeProviderSessionInput({
      sessionId: 'bad',
      threadId: 'bad',
      transportResourceId: 'bad',
      runtimeMode: 'approval-required',
      agentKind: 'workspace',
      workspacePath: null,
      providerCwd: null,
      resumeCursor: null,
      lifecycleStatus: 'hot',
      toolGrantIds: [],
      toolPolicy: DEFAULT_PROVIDER_TOOL_POLICY
    })).toThrow(/workspacePath is required/u);

    expect(validateProviderResourceBundle({
      systemPromptSections: ['Persona'],
      contextFiles: [{ path: 'AGENTS.md', content: 'rules', source: 'moorline' }],
      skills: [{
        name: 'proof',
        description: 'Proof skill',
        filePath: '/tmp/proof/SKILL.md',
        baseDir: '/tmp/proof',
        metadata: {}
      }],
      promptTemplates: [{ name: 'brief', content: 'hello', source: 'moorline' }]
    }).skills[0]?.name).toBe('proof');

    expect(validateProviderToolDefinition({
      id: 'core.moorline_session',
      name: 'moorline_session',
      description: 'Manage sessions',
      inputSchema: { type: 'object' },
      requiredCapability: 'session.inspect',
      source: 'core'
    })).toMatchObject({
      id: 'core.moorline_session',
      source: 'core'
    });
  });

  it('builds release CLI artifacts from the split CLI package entrypoint', () => {
    const script = readFileSync(join(root, 'scripts', 'build-cli-artifact.mjs'), 'utf8');
    expect(script).toContain("'packages', 'cli', 'src', 'main.ts'");
    expect(script).not.toMatch(/resolve\(projectRoot,\s*'src',\s*'main\.ts'\)/);
  });

  it('loads selected api-adapter packages instead of hard-coding the HTTP server in the CLI foreground path', () => {
    const source = readFileSync(join(root, 'packages', 'cli', 'src', 'app', 'cli', 'cliForegroundCommands.ts'), 'utf8');
    expect(source).toContain('loadConfiguredApiAdapterPackage');
    expect(source).toContain('adapterPackage.createAdapter');
    expect(source).not.toContain('new ControlApiServer');
    expect(source).not.toContain("adapterPackageId: 'moorline/http'");
    expect(source).not.toContain("selectedPackageId === 'moorline/http'");
    expect(source).not.toContain('@moorline/http');
  });

  it('keeps production host code free of first-party package special cases', () => {
    const productionSource = [
      readSourceTree(join(root, 'packages', 'core', 'src')),
      readSourceTree(join(root, 'packages', 'cli', 'src')),
      readSourceTree(join(root, 'packages', 'control-api', 'src')),
      readSourceTree(join(root, 'packages', 'http', 'src'))
    ].join('\n');
    const staticPolicy = readFileSync(join(root, 'packages', 'core', 'resources', 'policies', 'default-secure.json'), 'utf8');
    expect(staticPolicy).not.toContain('plugin:rync/');
    expect(productionSource).not.toContain('plugin:rync/');
    expect(productionSource).not.toContain("selectedPackageId === 'moorline/http'");
    expect(productionSource).not.toContain("activePackageId !== 'moorline/http'");
    expect(productionSource).not.toContain("input.packageId === 'moorline/http'");
    expect(productionSource).not.toContain("packageId: 'moorline/http'");
    expect(productionSource).not.toContain('isPrivilegedPluginId');
    expect(productionSource).not.toContain("packageGroup === 'moorline'");
    expect(productionSource).not.toContain("segments[packagesIndex + 2] === 'moorline'");
  });

  it('keeps release automation manual and non-publishing', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).not.toContain('tags:');
    expect(workflow).not.toContain('npm publish');
    expect(workflow).not.toContain('softprops/action-gh-release');
    for (const name of hostPackages) {
      expect(workflow).toContain(`npm pack ./packages/${name}`);
    }
  });

  it('smoke-packs all public host packages in CI', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    for (const name of hostPackages) {
      expect(workflow).toContain(`npm pack ./packages/${name}`);
    }
    expect(workflow).not.toContain('packages/package-kit');
    expect(workflow).not.toContain('build:personal-npm-packages');
  });

  it('does not keep an moorline/http inventory bypass', () => {
    const source = readFileSync(join(root, 'packages', 'core', 'src', 'app', 'bootstrap', 'operatorPackageService.ts'), 'utf8');
    expect(source).not.toContain("this.config.surfaces.apiAdapter.activePackageId !== 'moorline/http'");
    expect(source).toContain('installPackage');
    expect(source).toContain('setSelectedPackage');
  });

  it('resolves migrations and default policy from core package resources', () => {
    const runtimePaths = readFileSync(join(root, 'packages', 'core', 'src', 'core', 'runtime', 'graph', 'runtimePaths.ts'), 'utf8');
    const runtimeBuilder = readFileSync(join(root, 'packages', 'core', 'src', 'core', 'runtime', 'moorlineRuntimeBuilder.ts'), 'utf8');
    const copyMigrations = readFileSync(join(root, 'scripts', 'copy-migrations.mjs'), 'utf8');
    expect(runtimePaths).toContain("'resources', 'migrations'");
    expect(runtimeBuilder).toContain("'resources', 'policies', 'default-secure.json'");
    expect(copyMigrations).toContain("'packages', 'core', 'resources', 'migrations'");
    expect(existsSync(join(root, 'packages', 'core', 'resources', 'migrations', '001_sessions.sql'))).toBe(true);
    expect(existsSync(join(root, 'packages', 'core', 'resources', 'policies', 'default-secure.json'))).toBe(true);
  });

  it('does not ship a tracked host package catalog', () => {
    expect(existsSync(join(root, 'packages', 'core', 'resources', 'host-package-catalog.json'))).toBe(false);
    const source = readSourceTree(join(root, 'packages', 'core', 'src', 'core', 'extension', 'packages'));
    expect(source).not.toContain('hostPackageCatalog');
    expect(source).not.toContain('host_package_catalog');
    expect(source).not.toContain(legacyRepoSlug);
  });

  it('does not depend on local package-kit or package source directories', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['build:installables']).toBeUndefined();
    expect(pkg.scripts['build:personal-npm-packages']).toBeUndefined();
    expect(pkg.scripts['validate:installables']).toBeUndefined();
    expect(pkg.scripts['test:full']).not.toContain('validate:installables');
    expect(existsSync(join(root, 'packages', 'package-kit'))).toBe(false);
    expect(existsSync(join(root, 'packages', 'provider'))).toBe(false);
    expect(existsSync(join(root, 'tools', 'installables'))).toBe(false);
  });

  it('cleans package-local dist output before package builds publish files', () => {
    const packagesWithTypeScriptBuilds = ['cli', 'contracts', 'control-api', 'core', 'http'];
    for (const name of packagesWithTypeScriptBuilds) {
      expect((packageJson(name).scripts as Record<string, string>).build).toContain(`clean-package-dist.mjs ${name}`);
    }

    const fixtureRoot = join(root, '.tmp-test', `flatten-fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const staleDir = join(fixtureRoot, 'packages', 'http', 'dist');
    mkdirSync(staleDir, { recursive: true });
    try {
      for (const staleFile of ['auth.js', 'auth.d.ts', 'auth.js.map']) {
        writeFileSync(join(staleDir, staleFile), 'stale webui auth output\n', 'utf8');
      }

      const nestedBuildDir = join(staleDir, 'packages', 'http', 'src');
      mkdirSync(nestedBuildDir, { recursive: true });
      writeFileSync(join(nestedBuildDir, 'index.js'), 'export {};\n', 'utf8');
      writeFileSync(join(nestedBuildDir, 'index.d.ts'), 'export {};\n', 'utf8');

      execFileSync('node', ['scripts/flatten-package-dist.mjs', 'http'], {
        cwd: root,
        env: {
          ...process.env,
          MOORLINE_FLATTEN_PROJECT_ROOT: fixtureRoot
        },
        stdio: 'pipe'
      });

      for (const staleFile of ['auth.js', 'auth.d.ts', 'auth.js.map']) {
        expect(existsSync(join(staleDir, staleFile))).toBe(false);
      }
      expect(existsSync(join(staleDir, 'index.js'))).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps behavioral HTTP adapter tests in the full gate', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const httpAdapterTest = readFileSync(join(root, 'tests', 'integration', 'http-adapter.test.ts'), 'utf8');
    expect(pkg.scripts['test:integration']).toContain('tests/integration/*.test.ts');
    expect(httpAdapterTest).toContain('serves health without auth');
    expect(httpAdapterTest).toContain('rejects API calls without the bearer token');
    expect(httpAdapterTest).toContain('binary backup export and import routes');
    expect(httpAdapterTest).toContain('lease commands');
    expect(httpAdapterTest).toContain('rejects non-loopback requests');
  });

  it('projects api-adapter package config and activation in the configure read model', () => {
    const source = readFileSync(join(root, 'packages', 'core', 'src', 'core', 'system', 'projection', 'managementReadModelService.ts'), 'utf8');
    expect(source).toContain("input.surface === 'api-adapter'");
    expect(source).toContain('input.config.surfaces.apiAdapter.config');
    expect(source).not.toContain("input.packageId === 'moorline/http'");
    expect(source).not.toContain("packageId: 'moorline/http'");
    expect(source).toContain('this.deps.config.surfaces.apiAdapter.activePackageId === entry.packageId');
  });

  it('does not write or parse the removed v3 namespace alias in v4 config', () => {
    const cliSource = readFileSync(join(root, 'packages', 'cli', 'src', 'app', 'cli', 'cli.ts'), 'utf8');
    const configSource = readFileSync(join(root, 'packages', 'core', 'src', 'types', 'config.ts'), 'utf8');
    expect(cliSource).not.toMatch(/\n\s+namespace,/);
    expect(configSource).toContain('config.namespace has been removed');
    expect(configSource).not.toContain('asObject(root.namespace');
    expect(configSource).not.toContain('namespace: parseSurfaceNames(surface)');
  });

  it('keeps public runtime terminology resource-oriented', () => {
    const publicSources = [
      readSourceTree(join(root, 'packages', 'contracts', 'src')),
      readSourceTree(join(root, 'packages', 'control-api', 'src')),
      readSourceTree(join(root, 'packages', 'cli', 'src')),
      readSourceTree(join(root, 'packages', 'http', 'src')),
      readFileSync(join(root, 'README.md'), 'utf8'),
      readFileSync(join(root, 'docs', 'TERMINOLOGY.md'), 'utf8')
    ].join('\n');

    const oldMessageSurface = ['c', 'hat'].join('');
    const oldResourceWord = ['s', 'pace'].join('');
    const oldTransportPackage = ['dis', 'cord'].join('');
    const forbiddenTerms = [
      ['main', '_', oldMessageSurface],
      ['Runtime', 'S', 'pace'],
      [oldResourceWord, 'Id'],
      [oldResourceWord, 'Name'],
      [oldMessageSurface],
      ['official', '/', oldTransportPackage],
      [oldTransportPackage],
      ['transport', '.', oldResourceWord],
      ['--', oldResourceWord]
    ];
    for (const term of forbiddenTerms) {
      const forbidden = new RegExp(term.join('').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      expect(publicSources).not.toMatch(forbidden);
    }
  });

  it('uses the runtime package install roots', () => {
    const installer = readFileSync(join(root, 'packages', 'core', 'src', 'core', 'extension', 'packages', 'packageInstaller.ts'), 'utf8');
    const layout = readFileSync(join(root, 'packages', 'core', 'src', 'core', 'runtime', 'hosting', 'runtimeLayout.ts'), 'utf8');
    const providerLoader = readFileSync(join(root, 'packages', 'core', 'src', 'app', 'bootstrap', 'providerPackageLoader.ts'), 'utf8');
    const transportLoader = readFileSync(join(root, 'packages', 'core', 'src', 'app', 'bootstrap', 'transportPackageLoader.ts'), 'utf8');
    const apiAdapterLoader = readFileSync(join(root, 'packages', 'core', 'src', 'app', 'bootstrap', 'apiAdapterPackageLoader.ts'), 'utf8');
    expect(installer).toContain("join(runtimeRoot, 'packages', dirName)");
    expect(providerLoader).toContain("'packages', 'providers'");
    expect(transportLoader).toContain("'packages', 'transports'");
    expect(apiAdapterLoader).toContain("'packages', 'api-adapters'");
    for (const dir of ['api-adapters', 'providers', 'transports', 'plugins', 'skills', 'bundles']) {
      expect(layout).toContain(`'${dir}'`);
    }
    expect(layout).not.toContain("join(input.runtimeRoot, 'plugins')");
  });
});
