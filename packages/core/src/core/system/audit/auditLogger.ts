import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface AuditEvent {
  eventType:
    | 'policy.decision'
    | 'tool.execution'
    | 'plugin.load';
  actor: string;
  action: string;
  status: 'allowed' | 'denied' | 'success' | 'failed';
  metadata?: Record<string, string | number | boolean | null>;
}

export class JsonAuditLogger {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async log(event: AuditEvent): Promise<void> {
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
      await appendFile(this.filePath, `${line}\n`, 'utf8');
    });
    this.writes = write.catch(() => undefined);
    await write;
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
