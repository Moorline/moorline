import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export class GitRepoStore {
  isGitAvailable(): boolean {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  hasRepo(root: string): boolean {
    return existsSync(join(resolve(root), '.git'));
  }

  run(root: string, args: string[], options: { allowFailure?: boolean; stdio?: 'pipe' | 'ignore' } = {}): string {
    try {
      return execFileSync('git', args, {
        cwd: resolve(root),
        encoding: 'utf8',
        stdio: ['ignore', options.stdio ?? 'pipe', 'pipe']
      });
    } catch (error) {
      if (options.allowFailure) {
        return '';
      }
      throw error;
    }
  }

  ensureDir(path: string): void {
    mkdirSync(resolve(path), { recursive: true });
  }

  readFile(path: string): string | null {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }

  writeFile(path: string, body: string): void {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(path, body, 'utf8');
  }

  remove(path: string): void {
    rmSync(path, { recursive: true, force: true });
  }
}
