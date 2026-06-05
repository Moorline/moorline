import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCliArgs } from '../../packages/cli/src/app/cli/cliCommands.js';
import { executeCli } from '../../packages/cli/src/app/cli/cli.js';
import { runApiForeground } from '../../packages/cli/src/app/cli/cliForegroundCommands.js';
import { defaultAdminConfig, defaultMainProcessConfig, defaultSurfaceNames, type MoorlineConfig } from '../../packages/core/src/types/config.js';
import { saveMoorlineConfig } from '../../packages/core/src/core/system/config/configStore.js';
import { createTempRoot } from '../helpers/temp.js';

const originalApiUrl = process.env.MOORLINE_API_URL;
const originalApiToken = process.env.MOORLINE_API_TOKEN;
const originalMoorlineHome = process.env.MOORLINE_HOME;

afterEach(() => {
  if (originalApiUrl === undefined) {
    delete process.env.MOORLINE_API_URL;
  } else {
    process.env.MOORLINE_API_URL = originalApiUrl;
  }
  if (originalApiToken === undefined) {
    delete process.env.MOORLINE_API_TOKEN;
  } else {
    process.env.MOORLINE_API_TOKEN = originalApiToken;
  }
  if (originalMoorlineHome === undefined) {
    delete process.env.MOORLINE_HOME;
  } else {
    process.env.MOORLINE_HOME = originalMoorlineHome;
  }
  vi.restoreAllMocks();
});

function writeCustomApiAdapter(root: string): void {
  mkdirSync(root, { recursive: true });
  const manifest = {
    id: 'acme/http-alt',
    name: 'acme/http-alt',
    version: '1.0.0',
    type: 'api-adapter',
    entrypoint: 'index.mjs'
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(root, 'index.mjs'), [
    'import { writeFileSync } from "node:fs";',
    `const manifest = ${JSON.stringify(manifest)};`,
    'export default {',
    '  manifest,',
    '  createAdapter(input) {',
      '    return {',
      '      async start() {',
      '        if (input.config.host !== "0.0.0.0" || input.config.port !== 45678 || input.config.exposure !== "loopback" || input.config["acme/http-alt"]) {',
      '          throw new Error(`unexpected adapter config ${JSON.stringify(input.config)}`);',
      '        }',
      '        return { endpoints: [{ protocol: "http", url: `http://${input.host}:${input.port}`, token: "custom-token" }] };',
      '      },',
    '      async stop() { if (input.config.stopMarker) writeFileSync(input.config.stopMarker, "stopped\\n"); }',
    '    };',
    '  }',
    '};'
  ].join('\n'), 'utf8');
}

function writeNoEndpointApiAdapter(root: string): void {
  mkdirSync(root, { recursive: true });
  const manifest = {
    id: 'acme/no-endpoint',
    name: 'acme/no-endpoint',
    version: '1.0.0',
    type: 'api-adapter',
    entrypoint: 'index.mjs'
  };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(root, 'index.mjs'), [
    `const manifest = ${JSON.stringify(manifest)};`,
    'export default {',
    '  manifest,',
    '  createAdapter() {',
    '    return {',
    '      async start() { return { endpoints: [] }; },',
    '      async stop() {}',
    '    };',
    '  }',
    '};'
  ].join('\n'), 'utf8');
}

function customAdapterConfig(root: string): MoorlineConfig {
  const surface = defaultSurfaceNames();
  return {
    version: 4,
    runtimeRoot: join(root, 'runtime'),
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
          port: 45678,
          exposure: 'loopback'
        },
        configByPackageId: {}
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
  };
}

describe('split-era CLI parser', () => {
  it('keeps the local run and api management commands without WebUI aliases', () => {
    expect(parseCliArgs(['run'])).toMatchObject({
      kind: 'api-run-foreground'
    });
    expect(parseCliArgs(['api', 'start'])).toMatchObject({
      kind: 'api-start'
    });
    expect(() => parseCliArgs(['console', 'start'])).toThrow(/unknown command/i);
    expect(() => parseCliArgs(['console-run-foreground'])).toThrow(/unknown command/i);
    expect(() => parseCliArgs(['mcp-server'])).toThrow(/unknown command/i);
  });

  it('parses remote connection flags for api start/status/stop', () => {
    expect(parseCliArgs(['api', 'start', '--url', 'https://moorline.example.test', '--token', 'secret'])).toMatchObject({
      kind: 'api-start',
      url: 'https://moorline.example.test',
      token: 'secret'
    });
    expect(parseCliArgs(['api', 'status', '--url', 'https://moorline.example.test', '--token', 'secret'])).toMatchObject({
      kind: 'api-status',
      url: 'https://moorline.example.test',
      token: 'secret'
    });
    expect(parseCliArgs(['api', 'stop', '--url', 'https://moorline.example.test', '--token', 'secret'])).toMatchObject({
      kind: 'api-stop',
      url: 'https://moorline.example.test',
      token: 'secret'
    });
  });

  it('uses MOORLINE_API_URL and MOORLINE_API_TOKEN for api status', async () => {
    process.env.MOORLINE_HOME = join(createTempRoot('moorline-remote-status-home-'), 'home');
    process.env.MOORLINE_API_URL = 'https://moorline.example.test';
    process.env.MOORLINE_API_TOKEN = 'secret';
    const output: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(executeCli({
      kind: 'api-status'
    }, {
      output: {
        write(line: string) {
          output.push(line);
        }
      },
      prompt: {
        input: async () => '',
        select: async (_label: string, _description: string, _options: Array<{ value: string }>, fallback: string) => fallback,
        confirm: async (_label: string, _description: string, fallback: boolean) => fallback,
        close() {}
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: ''
        })
      }
    })).resolves.toBe(0);

    expect(fetch).toHaveBeenCalledWith('https://moorline.example.test/api/state/configure', {
      headers: {
        authorization: 'Bearer secret'
      }
    });
    expect(output).toContain('Control API: https://moorline.example.test');
  });

  it('fails remote api status when the provided token is rejected', async () => {
    process.env.MOORLINE_HOME = join(createTempRoot('moorline-remote-status-token-home-'), 'home');
    process.env.MOORLINE_API_URL = 'https://moorline.example.test';
    process.env.MOORLINE_API_TOKEN = 'wrong-secret';
    const output: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(executeCli({
      kind: 'api-status'
    }, {
      output: {
        write(line: string) {
          output.push(line);
        }
      },
      prompt: {
        input: async () => '',
        select: async (_label: string, _description: string, _options: Array<{ value: string }>, fallback: string) => fallback,
        confirm: async (_label: string, _description: string, fallback: boolean) => fallback,
        close() {}
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: ''
        })
      }
    })).resolves.toBe(1);

    expect(fetch).toHaveBeenCalledWith('https://moorline.example.test/api/state/configure', {
      headers: {
        authorization: 'Bearer wrong-secret'
      }
    });
    expect(output).toContain('Control API metadata exists but authenticated status check failed: https://moorline.example.test');
  });

  it('normalizes trailing slashes when checking remote api status', async () => {
    process.env.MOORLINE_HOME = join(createTempRoot('moorline-remote-status-slash-home-'), 'home');
    process.env.MOORLINE_API_URL = 'https://moorline.example.test/';
    process.env.MOORLINE_API_TOKEN = 'secret';
    const output: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(executeCli({
      kind: 'api-status'
    }, {
      output: {
        write(line: string) {
          output.push(line);
        }
      },
      prompt: {
        input: async () => '',
        select: async (_label: string, _description: string, _options: Array<{ value: string }>, fallback: string) => fallback,
        confirm: async (_label: string, _description: string, fallback: boolean) => fallback,
        close() {}
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: ''
        })
      }
    })).resolves.toBe(0);

    expect(fetch).toHaveBeenCalledWith('https://moorline.example.test/api/state/configure', {
      headers: {
        authorization: 'Bearer secret'
      }
    });
    expect(output).toContain('Control API: https://moorline.example.test/');
  });

  it('reports local api status as stopped before init', async () => {
    process.env.MOORLINE_HOME = join(createTempRoot('moorline-local-status-before-init-'), 'home');
    const output: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(executeCli({
      kind: 'api-status'
    }, {
      output: {
        write(line: string) {
          output.push(line);
        }
      },
      prompt: {
        input: async () => '',
        select: async (_label: string, _description: string, _options: Array<{ value: string }>, fallback: string) => fallback,
        confirm: async (_label: string, _description: string, fallback: boolean) => fallback,
        close() {}
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: ''
        })
      }
    })).resolves.toBe(0);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(output).toContain('Control API is not running.');
  });

  it('reports local api stop as stopped before init', async () => {
    process.env.MOORLINE_HOME = join(createTempRoot('moorline-local-stop-before-init-'), 'home');
    const output: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(executeCli({
      kind: 'api-stop'
    }, {
      output: {
        write(line: string) {
          output.push(line);
        }
      },
      prompt: {
        input: async () => '',
        select: async (_label: string, _description: string, _options: Array<{ value: string }>, fallback: string) => fallback,
        confirm: async (_label: string, _description: string, fallback: boolean) => fallback,
        close() {}
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: ''
        })
      }
    })).resolves.toBe(0);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(output).toContain('Control API is not running.');
  });

  it('uses remote api stop without reading local bootstrap config', async () => {
    process.env.MOORLINE_HOME = join(createTempRoot('moorline-remote-stop-home-'), 'home');
    process.env.MOORLINE_API_URL = 'https://moorline.example.test';
    process.env.MOORLINE_API_TOKEN = 'secret';
    const output: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
      headers: {
        get: () => null
      },
      text: async () => '',
      json: async () => null,
      arrayBuffer: async () => new ArrayBuffer(0)
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(executeCli({
      kind: 'api-stop'
    }, {
      output: {
        write(line: string) {
          output.push(line);
        }
      },
      prompt: {
        input: async () => '',
        select: async (_label: string, _description: string, _options: Array<{ value: string }>, fallback: string) => fallback,
        confirm: async (_label: string, _description: string, fallback: boolean) => fallback,
        close() {}
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: ''
        })
      }
    })).resolves.toBe(0);

    expect(fetch).toHaveBeenCalledWith('https://moorline.example.test/api/shutdown', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer secret'
      })
    }));
    expect(output).toContain('Control API shutdown requested.');
  });

  it('uses remote interactive mode without reading local config', async () => {
    process.env.MOORLINE_HOME = join(createTempRoot('moorline-remote-interactive-home-'), 'home');
    const output: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: () => null
      },
      text: async () => JSON.stringify({ leaseId: 'lease-1' }),
      json: async () => ({ leaseId: 'lease-1' }),
      arrayBuffer: async () => new ArrayBuffer(0)
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(executeCli({
      kind: 'interactive',
      url: 'https://moorline.example.test',
      token: 'secret'
    }, {
      output: {
        write(line: string) {
          output.push(line);
        }
      },
      prompt: {
        input: async () => '',
        select: async () => 'exit',
        confirm: async (_label: string, _description: string, fallback: boolean) => fallback,
        close() {}
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: ''
        })
      }
    })).resolves.toBe(0);

    expect(fetch).toHaveBeenCalledWith('https://moorline.example.test/api/leases/create', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer secret'
      }),
      body: expect.stringContaining('"policy":"detached"')
    }));
    expect(fetch).toHaveBeenCalledWith('https://moorline.example.test/api/leases/release', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer secret'
      })
    }));
    expect(output).toContain('Interactive mode closed.');
  });

  it('rejects explicit remote URLs without a token instead of falling back to local bootstrap', async () => {
    process.env.MOORLINE_HOME = join(createTempRoot('moorline-remote-missing-token-home-'), 'home');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(executeCli({
      kind: 'api-get',
      path: '/api/state/operations',
      url: 'https://moorline.example.test',
      json: true
    }, {
      output: {
        write() {}
      },
      prompt: {
        input: async () => '',
        select: async (_label: string, _description: string, _options: Array<{ value: string }>, fallback: string) => fallback,
        confirm: async (_label: string, _description: string, fallback: boolean) => fallback,
        close() {}
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: ''
        })
      }
    })).rejects.toThrow(/token is required/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects MOORLINE_API_URL without MOORLINE_API_TOKEN before reading local config', async () => {
    process.env.MOORLINE_HOME = join(createTempRoot('moorline-env-missing-token-home-'), 'home');
    process.env.MOORLINE_API_URL = 'https://moorline.example.test';

    await expect(executeCli({
      kind: 'api-get',
      path: '/api/state/operations',
      json: true
    }, {
      output: {
        write() {}
      },
      prompt: {
        input: async () => '',
        select: async (_label: string, _description: string, _options: Array<{ value: string }>, fallback: string) => fallback,
        confirm: async (_label: string, _description: string, fallback: boolean) => fallback,
        close() {}
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: ''
        })
      }
    })).rejects.toThrow(/token is required/i);
  });

  it('parses remote HTTP URL and bearer token options for API-backed commands', () => {
    expect(parseCliArgs(['ops', 'state', '--url', 'https://moorline.example.test', '--token', 'secret', '--json'])).toMatchObject({
      kind: 'api-get',
      path: '/api/state/operations',
      url: 'https://moorline.example.test',
      token: 'secret',
      json: true
    });
    expect(parseCliArgs(['api', 'diagnostics-export', '--url', 'http://127.0.0.1:45173', '--token', 'local'])).toMatchObject({
      kind: 'api-get',
      path: '/api/management/diagnostics-export',
      url: 'http://127.0.0.1:45173',
      token: 'local'
    });
  });

  it('exposes api-adapter as a first-class package kind in CLI package commands', () => {
    expect(parseCliArgs(['package', 'search', 'http', '--kind', 'api-adapter'])).toMatchObject({
      kind: 'package-search',
      query: 'http',
      packageKind: 'api-adapter'
    });
    expect(parseCliArgs(['package', 'install', 'moorline/http', '--kind', 'api-adapter'])).toMatchObject({
      kind: 'package-install',
      packageId: 'moorline/http',
      packageKind: 'api-adapter'
    });
  });

  it('mentions api-adapter in configure package usage text for selection and configuration commands', () => {
    expect(() => parseCliArgs(['configure', 'package', 'activate'])).toThrow(/<api-adapter\|transport\|provider\|plugin\|skill>/);
    expect(() => parseCliArgs(['configure', 'package', 'select'])).toThrow(/<api-adapter\|transport\|provider>/);
    expect(() => parseCliArgs(['configure', 'package', 'config'])).toThrow(/<api-adapter\|transport\|provider\|plugin\|skill>/);
  });

  it('starts the selected api-adapter package for local foreground runs', async () => {
    const root = createTempRoot('moorline-cli-api-adapter-');
    const config = customAdapterConfig(root);
    const configPath = join(root, 'config.json');
    writeCustomApiAdapter(join(config.runtimeRoot, 'packages', 'api-adapters', 'acme', 'http-alt'));
    saveMoorlineConfig(config, configPath);
    const output: string[] = [];

    await expect(runApiForeground({
      kind: 'api-run-foreground',
      configPath
    }, {
      output: {
        write(line: string) {
          output.push(line);
        }
      },
      commandRunner: async () => ({
        code: 0,
        stdout: '',
        stderr: ''
      }),
      waitForShutdown: async () => undefined
    } as never)).resolves.toBe(0);

    expect(output).toEqual(expect.arrayContaining([
      'Moorline Control API: http://0.0.0.0:45678',
      'Moorline Control API token: custom-token'
    ]));
  });

  it('stops a started api-adapter when bootstrap record publication fails', async () => {
    const root = createTempRoot('moorline-cli-api-adapter-bootstrap-fail-');
    const config = customAdapterConfig(root);
    const stopMarker = join(root, 'adapter-stopped.txt');
    config.surfaces.apiAdapter.config.stopMarker = stopMarker;
    const configPath = join(root, 'config.json');
    const stateDir = join(config.runtimeRoot, 'state');
    writeCustomApiAdapter(join(config.runtimeRoot, 'packages', 'api-adapters', 'acme', 'http-alt'));
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o500);
    saveMoorlineConfig(config, configPath);

    try {
      await expect(runApiForeground({
        kind: 'api-run-foreground',
        configPath
      }, {
        output: {
          write() {}
        },
        commandRunner: async () => ({
          code: 0,
          stdout: '',
          stderr: ''
        }),
        waitForShutdown: async () => undefined
      } as never)).rejects.toThrow();
    } finally {
      chmodSync(stateDir, 0o700);
    }

    expect(existsSync(stopMarker)).toBe(true);
  });

  it('does not fall back to moorline/http when the api-adapter selection is cleared', async () => {
    const root = createTempRoot('moorline-cli-no-api-adapter-');
    const config = customAdapterConfig(root);
    config.surfaces.apiAdapter.activePackageId = null;
    config.surfaces.apiAdapter.config = {};
    const configPath = join(root, 'config.json');
    saveMoorlineConfig(config, configPath);

    await expect(runApiForeground({
      kind: 'api-run-foreground',
      configPath
    }, {
      output: {
        write() {}
      },
      commandRunner: async () => ({
        code: 0,
        stdout: '',
        stderr: ''
      }),
      waitForShutdown: async () => undefined
    } as never)).rejects.toThrow(/No API adapter package is selected/);
  });

  it('fails foreground runs when the selected adapter has no HTTP endpoint', async () => {
    const root = createTempRoot('moorline-cli-api-adapter-no-endpoint-');
    const config = customAdapterConfig(root);
    config.surfaces.apiAdapter.activePackageId = 'acme/no-endpoint';
    config.surfaces.apiAdapter.config = {};
    config.surfaces.apiAdapter.configByPackageId = {};
    const configPath = join(root, 'config.json');
    writeNoEndpointApiAdapter(join(config.runtimeRoot, 'packages', 'api-adapters', 'acme', 'no-endpoint'));
    saveMoorlineConfig(config, configPath);
    const output: string[] = [];

    await expect(runApiForeground({
      kind: 'api-run-foreground',
      configPath
    }, {
      output: {
        write(line: string) {
          output.push(line);
        }
      },
      commandRunner: async () => ({
        code: 0,
        stdout: '',
        stderr: ''
      }),
      waitForShutdown: async () => undefined
    } as never)).resolves.toBe(1);

    expect(output).toContain('Moorline API adapter acme/no-endpoint did not expose an HTTP endpoint.');
  });
});
