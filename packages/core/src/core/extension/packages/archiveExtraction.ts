import { mkdirSync, statSync, createWriteStream } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import * as yauzl from 'yauzl';
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_FILES,
  MAX_EXTRACTED_BYTES
} from './packageSourceLimits.js';

interface ArchiveEntryInfo {
  path: string;
  size: number;
  directory: boolean;
}

function normalizeArchiveEntryPath(rawPath: string): string {
  const normalized = normalize(rawPath).replaceAll('\\', '/');
  if (!normalized || normalized === '.' || normalized === './') {
    return '';
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`Archive entry must not be absolute: ${rawPath}`);
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Archive entry must not escape the bundle root: ${rawPath}`);
  }
  return segments.join('/');
}

function validateArchiveInventory(entries: ArchiveEntryInfo[]): void {
  let extractedBytes = 0;
  let files = 0;
  for (const entry of entries) {
    if (!entry.directory) {
      files += 1;
      extractedBytes += entry.size;
    }
  }
  if (files > MAX_ARCHIVE_FILES) {
    throw new Error(`Archive contains too many files: ${files} > ${MAX_ARCHIVE_FILES}`);
  }
  if (extractedBytes > MAX_EXTRACTED_BYTES) {
    throw new Error(`Archive expands to ${extractedBytes} bytes, exceeding the ${MAX_EXTRACTED_BYTES}-byte limit`);
  }
}

async function listTarEntries(archivePath: string): Promise<ArchiveEntryInfo[]> {
  const entries: ArchiveEntryInfo[] = [];
  let validationError: Error | null = null;
  await tar.list({
    file: archivePath,
    onReadEntry(entry: tar.ReadEntry) {
      if (validationError) {
        return;
      }
      try {
        const normalized = normalizeArchiveEntryPath(entry.path);
        if (!normalized) {
          return;
        }
        if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
          throw new Error(`Archive must not contain links: ${entry.path}`);
        }
        entries.push({
          path: normalized,
          size: Number(entry.size ?? 0),
          directory: entry.type === 'Directory'
        });
      } catch (error) {
        validationError = error instanceof Error ? error : new Error(String(error));
      }
    }
  });
  if (validationError) {
    throw validationError;
  }
  validateArchiveInventory(entries);
  return entries;
}

async function extractTarArchive(archivePath: string, targetDir: string): Promise<void> {
  await listTarEntries(archivePath);
  await tar.x({
    file: archivePath,
    cwd: targetDir,
    filter: (entryPath) => {
      normalizeArchiveEntryPath(entryPath);
      return true;
    }
  });
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error: Error | null, zipfile: yauzl.ZipFile | undefined) => {
      if (error || !zipfile) {
        reject(error ?? new Error(`Unable to open zip archive ${archivePath}`));
        return;
      }
      resolve(zipfile);
    });
  });
}

function zipEntryIsSymlink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

function closeZip(zipfile: yauzl.ZipFile): Promise<void> {
  return new Promise((resolve) => {
    zipfile.close();
    resolve();
  });
}

function openZipReadStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error: Error | null, stream: Readable | undefined) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read zip entry ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}

async function extractZipArchive(archivePath: string, targetDir: string): Promise<void> {
  const zipfile = await openZip(archivePath);
  const entries: ArchiveEntryInfo[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      zipfile.once('error', reject);
      zipfile.once('end', resolve);
      zipfile.on('entry', (entry: yauzl.Entry) => {
        try {
          const normalized = normalizeArchiveEntryPath(entry.fileName);
          if (zipEntryIsSymlink(entry)) {
            throw new Error(`Archive must not contain symlinks: ${entry.fileName}`);
          }
          if (normalized) {
            entries.push({
              path: normalized,
              size: entry.uncompressedSize,
              directory: /\/$/u.test(entry.fileName)
            });
          }
          zipfile.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zipfile.readEntry();
    });
  } finally {
    await closeZip(zipfile);
  }

  validateArchiveInventory(entries);

  const secondPass = await openZip(archivePath);
  try {
    await new Promise<void>((resolve, reject) => {
      secondPass.once('error', reject);
      secondPass.once('end', resolve);
      secondPass.on('entry', async (entry: yauzl.Entry) => {
        try {
          const normalized = normalizeArchiveEntryPath(entry.fileName);
          if (!normalized) {
            secondPass.readEntry();
            return;
          }
          const targetPath = join(targetDir, normalized);
          if (/\/$/u.test(entry.fileName)) {
            mkdirSync(targetPath, { recursive: true });
            secondPass.readEntry();
            return;
          }
          mkdirSync(dirname(targetPath), { recursive: true });
          const stream = await openZipReadStream(secondPass, entry);
          await pipeline(stream, createWriteStream(targetPath));
          secondPass.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      secondPass.readEntry();
    });
  } finally {
    await closeZip(secondPass);
  }
}

export function extractArchive(archivePath: string, targetDir: string): Promise<void> {
  const archiveSize = statSync(archivePath).size;
  if (archiveSize > MAX_ARCHIVE_BYTES) {
    throw new Error(`Archive exceeds the ${MAX_ARCHIVE_BYTES}-byte limit: ${archivePath}`);
  }
  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    return extractTarArchive(archivePath, targetDir);
  }
  if (archivePath.endsWith('.zip')) {
    return extractZipArchive(archivePath, targetDir);
  }
  throw new Error(`Unsupported archive format: ${archivePath}`);
}
