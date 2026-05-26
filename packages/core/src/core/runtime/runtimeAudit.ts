import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const pendingWritesByPath = new Map<string, Promise<void>>();

function queueRuntimeAuditAppend(path: string, line: string): void {
  const previous = pendingWritesByPath.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await appendFile(path, line, 'utf8');
    })
    .catch((error) => {
      globalThis.console.error('[moorline:audit]', error);
    });
  pendingWritesByPath.set(path, next);
  void next.finally(() => {
    if (pendingWritesByPath.get(path) === next) {
      pendingWritesByPath.delete(path);
    }
  });
}

export function appendRuntimeAuditLine(input: {
  logsDir: string;
  now: () => string;
  event: string;
  payload: Record<string, unknown>;
}): void {
  const path = join(input.logsDir, 'audit.log');
  queueRuntimeAuditAppend(path, `${JSON.stringify({ at: input.now(), event: input.event, ...input.payload })}\n`);
}

export async function flushRuntimeAuditLines(logsDir?: string): Promise<void> {
  if (logsDir) {
    await (pendingWritesByPath.get(join(logsDir, 'audit.log')) ?? Promise.resolve());
    return;
  }
  await Promise.all([...pendingWritesByPath.values()]);
}
