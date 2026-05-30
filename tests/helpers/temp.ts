import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

interface TrackedTempRoot {
  keepOnFailure: boolean;
}

const trackedRoots = new Map<string, TrackedTempRoot>();

function shouldKeepTempRoots(): boolean {
  return process.env.MOORLINE_KEEP_TEST_TEMP === '1';
}

export function createTempRoot(prefix: string, options: { keepOnFailure?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  trackedRoots.set(root, {
    keepOnFailure: options.keepOnFailure === true
  });
  return root;
}

async function cleanupTempRoots(options: { testFailed?: boolean } = {}): Promise<void> {
  if (shouldKeepTempRoots()) {
    trackedRoots.clear();
    return;
  }

  for (const [root, tracking] of trackedRoots) {
    if (tracking.keepOnFailure && options.testFailed === true) {
      continue;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    trackedRoots.delete(root);
  }
}

afterEach(async () => {
  await cleanupTempRoots();
});
