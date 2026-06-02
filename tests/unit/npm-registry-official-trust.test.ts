import { afterEach, describe, expect, it, vi } from 'vitest';
import { NpmRegistryClient } from '../../packages/core/src/core/extension/packages/npmRegistryClient.js';
import { PackageRegistryService } from '../../packages/core/src/core/extension/packages/packageRegistryService.js';
import type { PackageRegistryEntry, PackageSearchInput } from '../../packages/core/src/core/extension/packages/packageRegistryTypes.js';
import type { PackageKind } from '../../packages/core/src/types/package.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function npmEntry(input: {
  packageId: string;
  npmName: string;
  trustLevel: PackageRegistryEntry['trustLevel'];
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
    trustLevel: input.trustLevel,
    registrySource: 'npm',
    publisher: input.npmName.split('/')[0]?.replace(/^@/u, '') ?? 'unknown',
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

describe('npm official trust', () => {
  it('rejects @moorline packages whose short npm name does not match the official package id', async () => {
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
          description: 'Mismatched official package.',
          keywords: [
            'moorline-package',
            'moorline-kind-api-adapter',
            'moorline-surface-official',
            'moorline-id-official-http-alt-for-test'
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
                'moorline-surface-official',
                'moorline-id-official-http-alt-for-test'
              ],
              dist: {
                tarball: 'https://registry.example.test/@moorline/not-http-alt-for-test/-/pkg.tgz',
                integrity: 'sha512-test'
              },
              moorline: {
                schemaVersion: 1,
                packageId: 'official/http-alt-for-test',
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

  it('does not treat mismatched @moorline names as valid official package candidates', async () => {
    const service = new PackageRegistryService(new FakeNpmClient([
      npmEntry({
        packageId: 'official/http-alt-for-test',
        npmName: '@moorline/not-http-alt-for-test',
        trustLevel: 'community'
      })
    ]) as never);

    await expect(service.getPackage({
      kind: 'api-adapter',
      packageId: 'official/http-alt-for-test'
    })).rejects.toThrow(/must be published as @moorline\/http-alt-for-test/);
  });

  it('does not let community npm packages claim official package ids', async () => {
    const service = new PackageRegistryService(new FakeNpmClient([
      npmEntry({
        packageId: 'official/http-alt-for-test',
        npmName: '@acme/http-alt',
        trustLevel: 'community'
      })
    ]) as never);

    await expect(service.getPackage({
      kind: 'api-adapter',
      packageId: 'official/http-alt-for-test'
    })).rejects.toThrow(/must be published as @moorline\/http-alt-for-test/);
  });

  it('reserves @moorline npm scope for matching official package ids', async () => {
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
          description: 'Mismatched community package.',
          keywords: [
            'moorline-package',
            'moorline-kind-plugin',
            'moorline-surface-acme',
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
                'moorline-surface-acme',
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
});
