import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NpmRegistryClient } from '../../packages/core/src/core/extension/packages/npmRegistryClient.js';
import { PackageRegistryService } from '../../packages/core/src/core/extension/packages/packageRegistryService.js';
import type { PackageRegistryEntry, PackageSearchInput } from '../../packages/core/src/core/extension/packages/packageRegistryTypes.js';
import type { PackageKind } from '../../packages/core/src/types/package.js';
import { createTempRoot } from '../helpers/temp.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function npmEntry(input: {
  packageId: string;
  npmName: string;
}): PackageRegistryEntry {
  return {
    schemaVersion: 1,
    kind: 'api-adapter',
    surface: 'api-adapter',
    packageId: input.packageId,
    name: input.packageId,
    description: input.packageId,
    version: '1.0.0',
    tags: [],
    source: {
      kind: 'remote_archive',
      url: `https://registry.example.test/${input.npmName}/-/pkg.tgz`,
      integrity: 'sha512-test'
    },
    requires: [],
    registrySource: 'npm',
    npm: {
      registryUrl: 'https://registry.example.test',
      packageName: input.npmName,
      version: '1.0.0',
      integrity: 'sha512-test'
    }
  };
}

class FakeNpmClient {
  registryUrl = 'https://registry.example.test';

  constructor(private readonly entries: PackageRegistryEntry[]) {}

  async search(input: PackageSearchInput = {}): Promise<PackageRegistryEntry[]> {
    return this.entries.filter((entry) => !input.kind || entry.kind === input.kind);
  }

  async findByPackageId(input: { packageId: string; kind?: PackageKind }): Promise<PackageRegistryEntry[]> {
    return this.entries.filter((entry) => entry.packageId === input.packageId && (!input.kind || entry.kind === input.kind));
  }
}

class FailingNpmClient extends FakeNpmClient {
  constructor() {
    super([]);
  }

  override async search(): Promise<PackageRegistryEntry[]> {
    throw new Error('simulated registry failure');
  }

  override async findByPackageId(): Promise<PackageRegistryEntry[]> {
    throw new Error('simulated registry failure');
  }
}

function writeRegistryCache(runtimeRoot: string, entries: PackageRegistryEntry[]): void {
  const stateDir = join(runtimeRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'package-registry-cache.json'),
    `${JSON.stringify({
      version: 1,
      registryUrl: 'https://registry.example.test',
      refreshedAt: '2026-06-07T00:00:00.000Z',
      entries
    }, null, 2)}\n`,
    'utf8'
  );
}

describe('npm Moorline-owned package identity', () => {
  it('rejects @moorline packages whose short npm name does not match the package id', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/-/v1/search')) {
        return {
          ok: true,
          json: async () => ({
            objects: [{
              package: {
                name: '@moorline/not-http-alt-for-test',
                version: '1.0.0',
                keywords: ['moorline-package']
              }
            }]
          })
        } as Awaited<ReturnType<typeof fetch>>;
      }
      return {
        ok: true,
        json: async () => ({
          name: '@moorline/not-http-alt-for-test',
          description: 'Mismatched package.',
          keywords: ['moorline-package'],
          'dist-tags': {
            latest: '1.0.0'
          },
          versions: {
            '1.0.0': {
              name: '@moorline/not-http-alt-for-test',
              version: '1.0.0',
              keywords: ['moorline-package'],
              dist: {
                tarball: 'https://registry.example.test/@moorline/not-http-alt-for-test/-/pkg.tgz',
                integrity: 'sha512-test'
              },
              moorline: {
                schemaVersion: 1,
                packageId: 'moorline/http-alt-for-test',
                kind: 'api-adapter',
                manifestPath: 'manifest.json',
                distroPath: 'moorline.dist.json'
              }
            }
          }
        })
      } as Awaited<ReturnType<typeof fetch>>;
    });

    const results = await new NpmRegistryClient({
      registryUrl: 'https://registry.example.test'
    }).search({
      query: 'http-alt-for-test',
      kind: 'api-adapter'
    });

    expect(results).toEqual([]);
  });

  it('does not treat mismatched @moorline names as valid package candidates', async () => {
    const service = new PackageRegistryService(new FakeNpmClient([
      npmEntry({
        packageId: 'moorline/http-alt-for-test',
        npmName: '@moorline/not-http-alt-for-test'
      })
    ]) as never);

    await expect(service.getPackage({
      kind: 'api-adapter',
      packageId: 'moorline/http-alt-for-test'
    })).rejects.toThrow(/must be published as @moorline\/http-alt-for-test/);
  });

  it('does not let other npm scopes claim Moorline package ids', async () => {
    const service = new PackageRegistryService(new FakeNpmClient([
      npmEntry({
        packageId: 'moorline/http-alt-for-test',
        npmName: '@acme/http-alt'
      })
    ]) as never);

    await expect(service.getPackage({
      kind: 'api-adapter',
      packageId: 'moorline/http-alt-for-test'
    })).rejects.toThrow(/must be published as @moorline\/http-alt-for-test/);
  });

  it('requires personal package ids to come from their matching npm scope', async () => {
    const service = new PackageRegistryService(new FakeNpmClient([
      {
        ...npmEntry({
          packageId: 'rync/discord-default',
          npmName: '@acme/moorline-discord-default'
        }),
        kind: 'bundle',
        surface: 'bundle'
      }
    ]) as never);

    await expect(service.getPackage({
      kind: 'bundle',
      packageId: 'rync/discord-default'
    })).rejects.toThrow(/must be published as @rync\/moorline-discord-default/);
  });

  it('accepts the shared Moorline package keyword for personal npm packages', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/-/v1/search')) {
        return {
          ok: true,
          json: async () => ({
            objects: [{
              package: {
                name: '@rync/moorline-discord-default',
                version: '0.0.2',
                keywords: ['moorline-package']
              }
            }]
          })
        } as Awaited<ReturnType<typeof fetch>>;
      }
      return {
        ok: true,
        json: async () => ({
          name: '@rync/moorline-discord-default',
          description: 'Discord default bundle.',
          keywords: ['moorline-package'],
          'dist-tags': {
            latest: '0.0.2'
          },
          versions: {
            '0.0.2': {
              name: '@rync/moorline-discord-default',
              version: '0.0.2',
              keywords: ['moorline-package'],
              dist: {
                tarball: 'https://registry.example.test/@rync/moorline-discord-default/-/pkg.tgz',
                integrity: 'sha512-test'
              },
              moorline: {
                schemaVersion: 1,
                packageId: 'rync/discord-default',
                kind: 'bundle',
                manifestPath: 'manifest.json',
                distroPath: 'moorline.dist.json'
              }
            }
          }
        })
      } as Awaited<ReturnType<typeof fetch>>;
    });

    const results = await new NpmRegistryClient({
      registryUrl: 'https://registry.example.test'
    }).search({
      query: 'discord-default',
      kind: 'bundle'
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'bundle',
      packageId: 'rync/discord-default',
      npm: {
        packageName: '@rync/moorline-discord-default'
      }
    });
  });

  it('discovers Moorline npm packages through keyword tags and filters small query terms locally', async () => {
    const packages = [
      {
        npmName: '@rync/moorline-discord-default',
        packageId: 'rync/discord-default',
        kind: 'bundle' as const,
        description: 'Discord transport plus status command and project resource routing.',
        keywords: ['moorline-package', 'moorline-kind-bundle', 'moorline-id-rync-discord-default', 'rync', 'discord', 'default', 'bundle', 'transport']
      },
      {
        npmName: '@rync/moorline-basic-essentials',
        packageId: 'rync/basic-essentials',
        kind: 'bundle' as const,
        description: 'Basic essentials bundle.',
        keywords: ['moorline-package', 'moorline-kind-bundle', 'moorline-id-rync-basic-essentials', 'rync', 'basic', 'essentials', 'bundle']
      },
      {
        npmName: '@rync/moorline-pi',
        packageId: 'rync/pi',
        kind: 'provider' as const,
        description: 'Rync Pi SDK provider package for Moorline.',
        keywords: ['moorline-package', 'moorline-kind-provider', 'moorline-id-rync-pi', 'rync', 'pi', 'provider']
      }
    ];
    const byName = new Map(packages.map((entry) => [entry.npmName, entry]));
    const searchQueries: string[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/-/v1/search')) {
        const parsed = new URL(rawUrl);
        searchQueries.push(parsed.searchParams.get('text') ?? '');
        return {
          ok: true,
          json: async () => ({
            objects: packages.map((entry) => ({
              package: {
                name: entry.npmName,
                version: '1.0.0',
                description: entry.description,
                keywords: entry.keywords
              },
              updated: '2026-06-21T00:00:00.000Z'
            }))
          })
        } as Awaited<ReturnType<typeof fetch>>;
      }
      const encodedName = rawUrl.slice('https://registry.example.test/'.length);
      const npmName = decodeURIComponent(encodedName);
      const entry = byName.get(npmName);
      if (!entry) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({})
        } as Awaited<ReturnType<typeof fetch>>;
      }
      return {
        ok: true,
        json: async () => ({
          name: entry.npmName,
          description: entry.description,
          keywords: entry.keywords,
          'dist-tags': {
            latest: '1.0.0'
          },
          time: {
            '1.0.0': '2026-06-21T00:00:00.000Z'
          },
          versions: {
            '1.0.0': {
              name: entry.npmName,
              version: '1.0.0',
              description: entry.description,
              keywords: entry.keywords,
              dist: {
                tarball: `https://registry.example.test/${entry.npmName}/-/pkg.tgz`,
                integrity: 'sha512-test'
              },
              moorline: {
                schemaVersion: 1,
                packageId: entry.packageId,
                kind: entry.kind,
                manifestPath: 'manifest.json',
                distroPath: 'moorline.dist.json'
              }
            }
          }
        })
      } as Awaited<ReturnType<typeof fetch>>;
    });

    const service = new PackageRegistryService({
      npmClient: new NpmRegistryClient({
        registryUrl: 'https://registry.example.test'
      })
    });

    await expect(service.search({ query: 'discord' })).resolves.toEqual([
      expect.objectContaining({ packageId: 'rync/discord-default' })
    ]);
    await expect(service.search({ query: 'pi' })).resolves.toEqual([
      expect.objectContaining({ packageId: 'rync/pi' })
    ]);
    await expect(service.search({ query: 'provider' })).resolves.toEqual([
      expect.objectContaining({ packageId: 'rync/pi' })
    ]);
    const bundleResults = await service.search({ query: 'bundle', kind: 'bundle' });
    expect(bundleResults).toHaveLength(2);
    expect(bundleResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ packageId: 'rync/basic-essentials' }),
      expect.objectContaining({ packageId: 'rync/discord-default' })
    ]));
    expect(searchQueries).toContain('keywords:moorline-package');
  });

  it('reserves @moorline npm scope for matching package ids', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/-/v1/search')) {
        return {
          ok: true,
          json: async () => ({
            objects: [{
              package: {
                name: '@moorline/acme-widget',
                version: '1.0.0',
                keywords: ['moorline-package']
              }
            }]
          })
        } as Awaited<ReturnType<typeof fetch>>;
      }
      return {
        ok: true,
        json: async () => ({
          name: '@moorline/acme-widget',
          description: 'Mismatched package.',
          keywords: ['moorline-package'],
          'dist-tags': {
            latest: '1.0.0'
          },
          versions: {
            '1.0.0': {
              name: '@moorline/acme-widget',
              version: '1.0.0',
              keywords: ['moorline-package'],
              dist: {
                tarball: 'https://registry.example.test/@moorline/acme-widget/-/pkg.tgz',
                integrity: 'sha512-test'
              },
              moorline: {
                schemaVersion: 1,
                packageId: 'acme/widget',
                kind: 'plugin',
                manifestPath: 'manifest.json',
                distroPath: 'moorline.dist.json'
              }
            }
          }
        })
      } as Awaited<ReturnType<typeof fetch>>;
    });

    const results = await new NpmRegistryClient({
      registryUrl: 'https://registry.example.test'
    }).search({
      query: 'acme-widget',
      kind: 'plugin'
    });

    expect(results).toEqual([]);
  });

  it('drops cached entries whose npm package name no longer matches the package id', async () => {
    const runtimeRoot = createTempRoot('moorline-bad-registry-cache-');
    writeRegistryCache(runtimeRoot, [
      npmEntry({
        packageId: 'moorline/http-alt-for-test',
        npmName: '@acme/http-alt'
      })
    ]);
    const service = new PackageRegistryService({
      runtimeRoot,
      npmClient: new FailingNpmClient() as never
    });

    expect(service.listCachedEntries()).toEqual([]);
    await expect(service.search({
      query: 'http-alt-for-test',
      kind: 'api-adapter'
    })).resolves.toEqual([]);
    await expect(service.getPackage({
      kind: 'api-adapter',
      packageId: 'moorline/http-alt-for-test',
      allowCacheOnly: true
    })).rejects.toThrow(/simulated registry failure/u);
    await expect(service.resolveInstallEntry({
      kind: 'api-adapter',
      packageId: 'moorline/http-alt-for-test'
    })).rejects.toThrow(/simulated registry failure/u);
  });
});
