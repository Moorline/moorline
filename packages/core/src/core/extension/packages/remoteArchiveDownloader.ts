import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PackageSourceDescriptor } from '../../../types/package.js';
import {
  FETCH_TIMEOUT_MS,
  MAX_ARCHIVE_BYTES,
  MAX_REDIRECTS
} from './packageSourceLimits.js';
import { validateRemoteUrlTarget } from '../../shared/utils/remoteNetworkPolicy.js';

type RemoteArchiveDownloadErrorCode = 'network' | 'redirect' | 'http' | 'size' | 'checksum' | 'validation';

export class RemoteArchiveDownloadError extends Error {
  constructor(
    message: string,
    readonly code: RemoteArchiveDownloadErrorCode,
    cause?: unknown
  ) {
    super(message);
    this.name = 'RemoteArchiveDownloadError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: cause,
        configurable: true,
        enumerable: false,
        writable: false
      });
    }
  }
}

function privateRemoteArchiveFetchesEnabled(): boolean {
  return process.env.MOORLINE_ALLOW_PRIVATE_REMOTE_ARCHIVE_URLS === '1';
}

const SUPPORTED_ARCHIVE_SUFFIXES = ['.tar.gz', '.tgz', '.zip'] as const;
const SUPPORTED_INTEGRITY_ALGORITHMS = new Set(['sha256', 'sha384', 'sha512']);

function hasSupportedArchiveSuffix(filename: string): boolean {
  const lower = filename.toLowerCase();
  return SUPPORTED_ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function archiveFilenameFromUrl(url: URL): string {
  if (url.pathname.endsWith('/')) {
    const digest = createHash('sha256').update(url.toString()).digest('hex').slice(0, 16);
    return `remote-archive-${digest}.tar.gz`;
  }
  const raw = basename(url.pathname).trim();
  if (!raw) {
    const digest = createHash('sha256').update(url.toString()).digest('hex').slice(0, 16);
    return `remote-archive-${digest}.tar.gz`;
  }
  if (!hasSupportedArchiveSuffix(raw)) {
    throw new RemoteArchiveDownloadError(
      `Unsupported archive filename for ${url.toString()}. Expected one of: ${SUPPORTED_ARCHIVE_SUFFIXES.join(', ')}`,
      'validation'
    );
  }
  return raw;
}

function verifySubresourceIntegrity(input: { url: string; integrity: string; bytes: Buffer }): void {
  const candidates = input.integrity
    .trim()
    .split(/\s+/u)
    .map((entry) => {
      const [algorithm, digest] = entry.split('-', 2);
      return {
        algorithm,
        digest
      };
    })
    .filter((entry): entry is { algorithm: string; digest: string } => Boolean(entry.algorithm && entry.digest));

  if (candidates.length === 0) {
    throw new RemoteArchiveDownloadError(`Invalid integrity metadata for ${input.url}`, 'checksum');
  }

  const supported = candidates.filter((entry) => SUPPORTED_INTEGRITY_ALGORITHMS.has(entry.algorithm));
  if (supported.length === 0) {
    throw new RemoteArchiveDownloadError(
      `Unsupported integrity algorithm for ${input.url}. Expected one of: ${[...SUPPORTED_INTEGRITY_ALGORITHMS].join(', ')}`,
      'checksum'
    );
  }

  for (const candidate of supported) {
    const actual = createHash(candidate.algorithm).update(input.bytes).digest('base64');
    if (actual === candidate.digest) {
      return;
    }
  }

  throw new RemoteArchiveDownloadError(`Integrity mismatch for ${input.url}`, 'checksum');
}

async function ensureRemoteArchiveUrlAllowed(url: string): Promise<URL> {
  const allowPrivate = privateRemoteArchiveFetchesEnabled();
  const parsed = await validateRemoteUrlTarget({
    rawUrl: url,
    allowedProtocols: allowPrivate ? ['http:', 'https:'] : ['https:'],
    allowPrivateTargets: allowPrivate,
    failOnDnsErrors: true,
    sourceLabel: 'Remote archive URL'
  });
  if (parsed.protocol !== 'https:' && !allowPrivate) {
    throw new Error(`Remote archives must use HTTPS. Set MOORLINE_ALLOW_PRIVATE_REMOTE_ARCHIVE_URLS=1 to allow private/local HTTP URLs.`);
  }
  return parsed;
}

export async function downloadRemoteArchive(
  source: Extract<PackageSourceDescriptor, { kind: 'remote_archive' }>,
  targetDir: string
): Promise<string> {
  let url: URL;
  try {
    url = await ensureRemoteArchiveUrlAllowed(source.url);
  } catch (error) {
    throw new RemoteArchiveDownloadError(
      error instanceof Error ? error.message : String(error),
      'network',
      error
    );
  }
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const controller = new globalThis.AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await fetch(url, {
          redirect: 'manual',
          signal: controller.signal
        });
      } catch (error) {
        throw new RemoteArchiveDownloadError(`Unable to download package archive ${url.toString()}: network request failed`, 'network', error);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new RemoteArchiveDownloadError(`Redirect without location header for ${url.toString()}`, 'redirect');
        }
        try {
          url = await ensureRemoteArchiveUrlAllowed(new URL(location, url).toString());
        } catch (error) {
          throw new RemoteArchiveDownloadError(
            error instanceof Error ? error.message : String(error),
            'redirect',
            error
          );
        }
        continue;
      }
      if (!response.ok) {
        throw new RemoteArchiveDownloadError(
          `Unable to download package archive ${url.toString()}: ${response.status} ${response.statusText}`,
          'http'
        );
      }
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
        throw new RemoteArchiveDownloadError(`Archive download exceeds the ${MAX_ARCHIVE_BYTES}-byte limit: ${declaredLength}`, 'size');
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ARCHIVE_BYTES) {
        throw new RemoteArchiveDownloadError(`Archive download exceeds the ${MAX_ARCHIVE_BYTES}-byte limit: ${bytes.length}`, 'size');
      }
      if (source.sha256) {
        const actualHash = createHash('sha256').update(bytes).digest('hex');
        if (actualHash !== source.sha256.toLowerCase()) {
          throw new RemoteArchiveDownloadError(
            `Checksum mismatch for ${url.toString()}: expected ${source.sha256}, received ${actualHash}`,
            'checksum'
          );
        }
      }
      if (source.integrity) {
        verifySubresourceIntegrity({
          url: url.toString(),
          integrity: source.integrity,
          bytes
        });
      }
      const archivePath = join(targetDir, archiveFilenameFromUrl(url));
      writeFileSync(archivePath, bytes);
      return archivePath;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  throw new RemoteArchiveDownloadError(`Too many redirects while downloading ${source.url}`, 'redirect');
}
