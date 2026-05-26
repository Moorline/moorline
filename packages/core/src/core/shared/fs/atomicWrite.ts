import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface WriteFileAtomicSyncOptions {
  mode?: number;
  fsync?: boolean;
}

function fsyncParentDir(path: string): void {
  try {
    const dirFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Some filesystems do not support directory fsync; best-effort only.
  }
}

export function writeFileAtomicSync(
  path: string,
  body: string | Uint8Array,
  options: WriteFileAtomicSyncOptions = {}
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, 'w', options.mode);
    writeFileSync(fd, body);
    if (options.fsync !== false) {
      fsyncSync(fd);
    }
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
    if (options.fsync !== false) {
      fsyncParentDir(path);
    }
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures on an already-failing write path.
      }
    }
    rmSync(tempPath, { force: true });
    throw error;
  }
}
