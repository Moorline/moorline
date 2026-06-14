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
          keywords: [
            'moorline-package',
            'moorline-kind-api-adapter',
            'moorline-namespace-moorline',
            'moorline-id-moorline-http-alt-for-test'
          ],
          'dist-tags': {
            latest: '1.0.0'
          },
          versions: {
            '1.0.0': {
              name: '@moorline/not-http-alt-for-test',
              version: '1.0.0',
              keywords: [
                'moorline-package',
                'moorline-kind-api-adapter',
                'moorline-namespace-moorline',
                'moorline-id-moorline-http-alt-for-test'
              ],
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

  it('accepts package-kit namespace keywords for personal npm packages', async () => {
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
          keywords: [
            'moorline-package',
            'moorline-kind-bundle',
            'moorline-namespace-rync',
            'moorline-id-rync-discord-default'
          ],
          'dist-tags': {
            latest: '0.0.2'
          },
          versions: {
            '0.0.2': {
              name: '@rync/moorline-discord-default',
              version: '0.0.2',
              keywords: [
                'moorline-package',
                'moorline-kind-bundle',
                'moorline-namespace-rync',
                'moorline-id-rync-discord-default'
              ],
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
          keywords: [
            'moorline-package',
            'moorline-kind-plugin',
            'moorline-namespace-acme',
            'moorline-id-acme-widget'
          ],
          'dist-tags': {
            latest: '1.0.0'
          },
          versions: {
            '1.0.0': {
              name: '@moorline/acme-widget',
              version: '1.0.0',
              keywords: [
                'moorline-package',
                'moorline-kind-plugin',
                'moorline-namespace-acme',
                'moorline-id-acme-widget'
              ],
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
