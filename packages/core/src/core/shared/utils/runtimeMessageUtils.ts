import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type {
  RuntimeAttachmentPayload
} from '../../../types/transport.js';
import { validateRemoteUrlTarget } from './remoteNetworkPolicy.js';
import { assertCanonicalExistingPathWithinRoot } from '../fs/canonicalPathContainment.js';

export function validateLocalRuntimeFiles(
  files: RuntimeAttachmentPayload[] | undefined,
  allowlistedRoots: string[] = []
): void {
  for (const file of files ?? []) {
    if (file.kind !== 'file' || !file.path) {
      continue;
    }
    const candidatePath = resolve(file.path);
    const stats = statSync(candidatePath, { throwIfNoEntry: false });
    if (!stats) {
      throw new Error(`Attachment file not found: ${file.path}`);
    }
    if (!stats.isFile()) {
      throw new Error(`Attachment path is not a file: ${file.path}`);
    }
    if (allowlistedRoots.length === 0) {
      continue;
    }
    const withinAllowlistedRoot = allowlistedRoots.some((root) => {
      try {
        assertCanonicalExistingPathWithinRoot({
          rootPath: root,
          candidatePath,
          rootLabel: `attachment root ${root}`,
          candidateLabel: `attachment path ${file.path}`
        });
        return true;
      } catch {
        return false;
      }
    });
    if (!withinAllowlistedRoot) {
      throw new Error(`Attachment path is outside allowlisted roots: ${file.path}`);
    }
  }
}

export function normalizeRuntimeReply(text: string): string {
  const segments = text.split(/(```[\s\S]*?```)/g);
  const normalized = segments
    .map((segment) => {
      if (segment.startsWith('```') && segment.endsWith('```')) {
        return segment.trim();
      }

      return segment
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/([.!?])([A-Z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z][a-z])/g, '$1 $2')
        .replace(/([.!?])(\n)([A-Za-z])/g, '$1$2$3')
        .replace(/([^\n])\n([^\n])/g, '$1 $2')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\bMoorline\b/g, 'Moorline')
        .trim();
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return normalized;
}

function sanitizeAttachmentFilename(filename: string | undefined, fallback = 'image'): string {
  const trimmed = filename?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : fallback;
  return base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function extensionForAttachment(attachment: RuntimeAttachmentPayload): string {
  const explicitExtension = extname(attachment.name ?? '');
  if (explicitExtension) {
    return explicitExtension;
  }

  switch (attachment.contentType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/heic':
      return '.heic';
    default:
      return '';
  }
}

const SUPPORTED_PROVIDER_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic'
]);
const MAX_PROVIDER_IMAGE_COUNT = 8;
const MAX_PROVIDER_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_IMAGE_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_PROVIDER_IMAGE_REDIRECTS = 5;

class ProviderImageValidationError extends Error {}

function privateRemoteImageFetchesEnabled(): boolean {
  return process.env.MOORLINE_ALLOW_PRIVATE_PROVIDER_IMAGE_URLS === '1';
}

function providerImageUrlFallbackEnabled(): boolean {
  return process.env.MOORLINE_ALLOW_PROVIDER_IMAGE_URL_FALLBACK === '1';
}

async function assertAllowedProviderImageUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ProviderImageValidationError(`Image URL is invalid: ${rawUrl}`);
  }

  if (parsed.protocol === 'data:') {
    return parsed;
  }
  try {
    return await validateRemoteUrlTarget({
      rawUrl,
      allowedProtocols: ['http:', 'https:'],
      allowPrivateTargets: privateRemoteImageFetchesEnabled(),
      failOnDnsErrors: true,
      sourceLabel: 'Image URL target'
    });
  } catch (error) {
    throw new ProviderImageValidationError(error instanceof Error ? error.message : String(error));
  }
}

async function fetchRemoteImageWithPolicy(rawUrl: string): Promise<{ response: globalThis.Response; resolvedUrl: URL }> {
  let current = await assertAllowedProviderImageUrl(rawUrl);
  for (let redirectCount = 0; redirectCount <= MAX_PROVIDER_IMAGE_REDIRECTS; redirectCount += 1) {
    const response = await globalThis.fetch(current, {
      redirect: 'manual'
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new ProviderImageValidationError(`Image redirect from ${current.toString()} did not include a location header.`);
      }
      current = await assertAllowedProviderImageUrl(new URL(location, current).toString());
      continue;
    }
    return { response, resolvedUrl: current };
  }
  throw new ProviderImageValidationError(`Image download exceeded ${MAX_PROVIDER_IMAGE_REDIRECTS} redirects for ${rawUrl}.`);
}

function parseContentType(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.split(';')[0]?.trim().toLowerCase();
  return normalized || null;
}

function assertSupportedContentType(contentType: string | null, label: string): string {
  if (!contentType || !SUPPORTED_PROVIDER_IMAGE_TYPES.has(contentType)) {
    throw new ProviderImageValidationError(
      `${label} must use one of: ${Array.from(SUPPORTED_PROVIDER_IMAGE_TYPES).join(', ')}.`
    );
  }
  return contentType;
}

async function streamResponseToFile(input: {
  response: globalThis.Response;
  targetPath: string;
  filename: string;
  totalBytes: { value: number };
}): Promise<void> {
  const declaredLength = Number.parseInt(input.response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_IMAGE_BYTES) {
    throw new ProviderImageValidationError(
      `Image ${input.filename} exceeds the per-image limit of ${MAX_PROVIDER_IMAGE_BYTES} bytes.`
    );
  }
  if (
    Number.isFinite(declaredLength) &&
    input.totalBytes.value + declaredLength > MAX_PROVIDER_IMAGE_TOTAL_BYTES
  ) {
    throw new ProviderImageValidationError(
      `Image payload exceeds the total limit of ${MAX_PROVIDER_IMAGE_TOTAL_BYTES} bytes.`
    );
  }

  const stream = createWriteStream(input.targetPath, { flags: 'wx' });
  const reader = input.response.body?.getReader();
  let written = 0;
  try {
    if (!reader) {
      const bytes = Buffer.from(await input.response.arrayBuffer());
      if (bytes.byteLength > MAX_PROVIDER_IMAGE_BYTES) {
        throw new ProviderImageValidationError(
          `Image ${input.filename} exceeds the per-image limit of ${MAX_PROVIDER_IMAGE_BYTES} bytes.`
        );
      }
      if (input.totalBytes.value + bytes.byteLength > MAX_PROVIDER_IMAGE_TOTAL_BYTES) {
        throw new ProviderImageValidationError(
          `Image payload exceeds the total limit of ${MAX_PROVIDER_IMAGE_TOTAL_BYTES} bytes.`
        );
      }
      stream.write(bytes);
      written = bytes.byteLength;
    } else {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = value ?? new Uint8Array();
        written += chunk.byteLength;
        if (written > MAX_PROVIDER_IMAGE_BYTES) {
          throw new ProviderImageValidationError(
            `Image ${input.filename} exceeds the per-image limit of ${MAX_PROVIDER_IMAGE_BYTES} bytes.`
          );
        }
        if (input.totalBytes.value + written > MAX_PROVIDER_IMAGE_TOTAL_BYTES) {
          throw new ProviderImageValidationError(
            `Image payload exceeds the total limit of ${MAX_PROVIDER_IMAGE_TOTAL_BYTES} bytes.`
          );
        }
        if (!stream.write(chunk)) {
          await once(stream, 'drain');
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    input.totalBytes.value += written;
  } catch (error) {
    stream.destroy();
    rmSync(input.targetPath, { force: true });
    throw error;
  }
}

export async function prepareProviderImages(input: {
  runtimeRoot: string;
  threadId: string;
  attachments: RuntimeAttachmentPayload[] | undefined;
}): Promise<Array<{ localPath: string } | { url: string }> | undefined> {
  const images = (input.attachments ?? []).filter(
    (attachment) => attachment.kind === 'image' && (Boolean(attachment.path) || Boolean(attachment.url))
  );
  if (images.length === 0) {
    return undefined;
  }
  if (images.length > MAX_PROVIDER_IMAGE_COUNT) {
    throw new ProviderImageValidationError(
      `Too many images. Maximum supported image count is ${MAX_PROVIDER_IMAGE_COUNT}.`
    );
  }

  const attachmentDir = join(input.runtimeRoot, 'state', 'input-images', input.threadId);
  mkdirSync(attachmentDir, { recursive: true });
  const totalBytes = { value: 0 };

  const prepared: Array<{ localPath: string } | { url: string }> = [];
  for (const [index, attachment] of images.entries()) {
    if (attachment.path) {
      const stats = statSync(attachment.path, { throwIfNoEntry: false });
      if (!stats || !stats.isFile()) {
        throw new ProviderImageValidationError(`Image attachment path is not a readable file: ${attachment.path}`);
      }
      if (stats.size > MAX_PROVIDER_IMAGE_BYTES) {
        throw new ProviderImageValidationError(
          `Image ${attachment.path} exceeds the per-image limit of ${MAX_PROVIDER_IMAGE_BYTES} bytes.`
        );
      }
      if (totalBytes.value + stats.size > MAX_PROVIDER_IMAGE_TOTAL_BYTES) {
        throw new ProviderImageValidationError(
          `Image payload exceeds the total limit of ${MAX_PROVIDER_IMAGE_TOTAL_BYTES} bytes.`
        );
      }
      const hintedType = parseContentType(attachment.contentType);
      if (hintedType) {
        assertSupportedContentType(hintedType, `Image ${attachment.path}`);
      }
      totalBytes.value += stats.size;
      prepared.push({ localPath: attachment.path });
      continue;
    }
    if (!attachment.url) {
      throw new ProviderImageValidationError('Image attachment requires either a local path or a remote URL.');
    }

    try {
      const { response, resolvedUrl } = await fetchRemoteImageWithPolicy(attachment.url);
      if (!response.ok) {
        throw new Error(`download failed with status ${response.status}`);
      }
      const contentType = assertSupportedContentType(
        parseContentType(response.headers.get('content-type')) ?? parseContentType(attachment.contentType),
        resolvedUrl.toString()
      );
      const filename = sanitizeAttachmentFilename(attachment.name, `image-${index + 1}`);
      const extension = extensionForAttachment(attachment);
      const targetPath = join(
        attachmentDir,
        `${Date.now()}-${index + 1}-${filename}${extname(filename) ? '' : extension}`
      );
      await streamResponseToFile({
        response,
        targetPath,
        filename,
        totalBytes
      });
      void contentType;
      prepared.push({ localPath: targetPath });
    } catch (error) {
      if (error instanceof ProviderImageValidationError) {
        throw error;
      }
      if (providerImageUrlFallbackEnabled()) {
        prepared.push({ url: attachment.url });
        continue;
      }
      throw new ProviderImageValidationError(
        `Image download failed for ${attachment.url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return prepared;
}

interface RuntimeImagePruneInput {
  runtimeRoot: string;
  threadId?: string;
  nowMs?: number;
  ttlMs?: number;
  maxFilesPerThread?: number;
}

interface RuntimeImagePruneStats {
  scannedThreads: number;
  removedFiles: number;
  removedDirectories: number;
}

const DEFAULT_PROVIDER_INPUT_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROVIDER_INPUT_IMAGE_MAX_FILES_PER_THREAD = 128;

export function pruneProviderInputImages(input: RuntimeImagePruneInput): RuntimeImagePruneStats {
  const root = join(input.runtimeRoot, 'state', 'input-images');
  if (!existsSync(root)) {
    return {
      scannedThreads: 0,
      removedFiles: 0,
      removedDirectories: 0
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_PROVIDER_INPUT_IMAGE_TTL_MS;
  const maxFilesPerThread = input.maxFilesPerThread ?? DEFAULT_PROVIDER_INPUT_IMAGE_MAX_FILES_PER_THREAD;
  const cutoff = nowMs - ttlMs;
  let removedFiles = 0;
  let removedDirectories = 0;
  let scannedThreads = 0;
  const threadDirs = input.threadId ? [input.threadId] : readdirSync(root);

  for (const threadId of threadDirs) {
    const threadRoot = join(root, threadId);
    const threadStats = statSync(threadRoot, { throwIfNoEntry: false });
    if (!threadStats?.isDirectory()) {
      continue;
    }
    scannedThreads += 1;
    const files = readdirSync(threadRoot)
      .map((entry) => {
        const fullPath = join(threadRoot, entry);
        const stats = statSync(fullPath, { throwIfNoEntry: false });
        if (!stats?.isFile()) {
          return null;
        }
        return {
          fullPath,
          mtimeMs: stats.mtimeMs
        };
      })
      .filter((entry): entry is { fullPath: string; mtimeMs: number } => entry !== null);

    for (const file of files) {
      if (file.mtimeMs > cutoff) {
        continue;
      }
      rmSync(file.fullPath, { force: true });
      removedFiles += 1;
    }

    const remaining = readdirSync(threadRoot)
      .map((entry) => {
        const fullPath = join(threadRoot, entry);
        const stats = statSync(fullPath, { throwIfNoEntry: false });
        if (!stats?.isFile()) {
          return null;
        }
        return {
          fullPath,
          mtimeMs: stats.mtimeMs
        };
      })
      .filter((entry): entry is { fullPath: string; mtimeMs: number } => entry !== null)
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    if (remaining.length > maxFilesPerThread) {
      const overflow = remaining.length - maxFilesPerThread;
      for (const file of remaining.slice(0, overflow)) {
        rmSync(file.fullPath, { force: true });
        removedFiles += 1;
      }
    }

    const hasFiles = readdirSync(threadRoot).some((entry) => statSync(join(threadRoot, entry), { throwIfNoEntry: false })?.isFile());
    if (!hasFiles) {
      rmSync(threadRoot, { recursive: true, force: true });
      removedDirectories += 1;
    }
  }

  return {
    scannedThreads,
    removedFiles,
    removedDirectories
  };
}
