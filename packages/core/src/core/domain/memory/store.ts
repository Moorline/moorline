import { appendFile, mkdir, writeFile as writeFileFs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveContainedPath, sanitizePathSegment } from './pathSafety.js';

interface SessionRecordInput {
  scopeId: string;
  spaceId: string;
  threadId: string | null;
  kind: 'log' | 'summary' | 'facts' | 'tasks';
  content: string;
  sourceRefs: string[];
}

interface LayeredRecordInput {
  scopeId?: string;
  projectKey?: string;
  kind: 'facts' | 'tasks';
  content: string;
  sourceRefs: string[];
}

export class MemoryStore {
  constructor(private readonly rootDir: string) {}

  async writeSessionRecord(input: SessionRecordInput): Promise<void> {
    const thread = input.threadId ? sanitizePathSegment(input.threadId, 'threadId') : 'root';
    const scopeId = sanitizePathSegment(input.scopeId, 'scopeId');
    const spaceId = sanitizePathSegment(input.spaceId, 'spaceId');
    const path = resolveContainedPath(
      this.rootDir,
      ['memory', 'sessions', `g${scopeId}`, `c${spaceId}`, thread, `${input.kind}.md`],
      'Session memory path'
    );

    const stamped = [
      `- timestamp: ${new Date().toISOString()}`,
      `  sourceRefs: [${input.sourceRefs.join(', ')}]`,
      `  content: |`,
      `    ${input.content.replace(/\n/g, '\n    ')}`,
      ''
    ].join('\n');

    await this.appendToFile(path, stamped);
  }

  async writeServerRecord(input: LayeredRecordInput & { scopeId: string }): Promise<void> {
    const scopeId = sanitizePathSegment(input.scopeId, 'scopeId');
    const path = resolveContainedPath(
      this.rootDir,
      ['memory', 'server', `g${scopeId}`, `${input.kind}.md`],
      'Server memory path'
    );
    await this.appendStampedRecord(path, input.content, input.sourceRefs);
  }

  async writeProjectRecord(input: LayeredRecordInput): Promise<void> {
    const projectKey = sanitizePathSegment(input.projectKey ?? 'default', 'projectKey');
    const path = resolveContainedPath(
      this.rootDir,
      ['memory', 'projects', projectKey, `${input.kind}.md`],
      'Project memory path'
    );
    await this.appendStampedRecord(path, input.content, input.sourceRefs);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFileFs(path, content, 'utf8');
  }

  private async appendToFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, content, 'utf8');
  }

  private async appendStampedRecord(path: string, content: string, sourceRefs: string[]): Promise<void> {
    const stamped = [
      `- timestamp: ${new Date().toISOString()}`,
      `  sourceRefs: [${sourceRefs.join(', ')}]`,
      `  content: |`,
      `    ${content.replace(/\n/g, '\n    ')}`,
      ''
    ].join('\n');

    await this.appendToFile(path, stamped);
  }
}
