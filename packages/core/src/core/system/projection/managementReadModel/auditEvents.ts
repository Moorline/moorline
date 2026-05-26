import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

function readRecentLines(path: string, maxLines: number): string[] {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats || stats.size <= 0) {
    return [];
  }

  const fd = openSync(path, 'r');
  try {
    const chunkSize = 8 * 1024;
    let position = stats.size;
    const chunks: Buffer[] = [];
    let newlineCount = 0;

    while (position > 0 && newlineCount <= maxLines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      readSync(fd, chunk, 0, readSize, position);
      chunks.unshift(chunk);
      for (const value of chunk.values()) {
        if (value === 0x0a) {
          newlineCount += 1;
        }
      }
    }

    const buffered = Buffer.concat(chunks).toString('utf8');
    return buffered
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}

export function readRecentAuditEvents(auditLogPath: string): Array<{
  eventType: string;
  actor: string;
  action: string;
  status: string;
  target: string | null;
  reason: string | null;
  recordedAt: string | null;
}> {
  if (!existsSync(auditLogPath)) {
    return [];
  }

  const lines = readRecentLines(auditLogPath, 10);

  return lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as {
        eventType?: string;
        actor?: string;
        action?: string;
        status?: string;
        metadata?: { target?: string | null; reason?: string | null };
        timestamp?: string | null;
      };
      return [
        {
          eventType: parsed.eventType ?? 'unknown',
          actor: parsed.actor ?? 'unknown',
          action: parsed.action ?? 'unknown',
          status: parsed.status ?? 'unknown',
          target: parsed.metadata?.target ?? null,
          reason: parsed.metadata?.reason ?? null,
          recordedAt: parsed.timestamp ?? null
        }
      ];
    } catch {
      return [];
    }
  });
}
