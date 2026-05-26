import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { HistoryDiffRequest, HistoryEntry, HistoryRestoreRequest, HistoryStatus, TrackedMutationDescriptor } from '../../../types/history.js';
import { gitHistoryLogFormat, parseGitHistoryLog } from './gitCommitParser.js';
import { formatGitDiffOutput } from './gitDiffFormatter.js';
import { moorlineGitIgnoreTemplate } from './gitIgnoreTemplate.js';
import { GitRepoStore } from './gitRepoStore.js';
import { ensureTrackedTargets, existingTrackedRoots, isTrackedRelativePath, normalizeRepoRelativePath } from './gitTrackedPaths.js';

function commitMessage(input: {
  title: string;
  kind: 'checkpoint' | 'snapshot';
  actor: string;
  reason: string;
  operation: string;
  targets: string[];
}): string {
  return [
    input.title,
    '',
    `Moorline-Kind: ${input.kind}`,
    `Moorline-Actor: ${input.actor}`,
    `Moorline-Reason: ${input.reason}`,
    `Moorline-Targets: ${input.targets.join(',')}`,
    `Moorline-Operation: ${input.operation}`
  ].join('\n');
}

function trackedStatusEntries(repo: GitRepoStore, homeRoot: string, paths: string[]): string[] {
  if (paths.length === 0) {
    return [];
  }
  const output = repo.run(homeRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths], {
    allowFailure: true
  });
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function trackedDirtyPaths(repo: GitRepoStore, homeRoot: string, paths?: string[]): string[] {
  const entries = trackedStatusEntries(repo, homeRoot, paths ?? existingTrackedRoots(homeRoot));
  return [...new Set(entries.map((line) => line.slice(3).trim()).filter((line) => isTrackedRelativePath(line)))].sort();
}

export class GitHistoryService {
  constructor(private readonly repo = new GitRepoStore()) {}

  private ensureGitAvailable(): void {
    if (!this.repo.isGitAvailable()) {
      throw new Error('Git is not installed; local history features are unavailable.');
    }
  }

  private ensureRepoRoot(homeRoot: string): void {
    this.repo.ensureDir(homeRoot);
    const ignorePath = join(homeRoot, '.gitignore');
    const nextIgnore = moorlineGitIgnoreTemplate();
    const currentIgnore = this.repo.readFile(ignorePath);
    if (currentIgnore !== nextIgnore) {
      writeFileSync(ignorePath, nextIgnore, 'utf8');
    }
    if (!this.repo.hasRepo(homeRoot)) {
      try {
        this.repo.run(homeRoot, ['init', '-b', 'main']);
      } catch {
        this.repo.run(homeRoot, ['init']);
        this.repo.run(homeRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { allowFailure: true });
      }
    }
    this.repo.run(homeRoot, ['config', 'user.name', 'Moorline'], { allowFailure: true });
    this.repo.run(homeRoot, ['config', 'user.email', 'moorline@local.invalid'], { allowFailure: true });
  }

  private createCommit(homeRoot: string, input: {
    kind: 'checkpoint' | 'snapshot';
    title: string;
    actor: string;
    reason: string;
    operation: string;
    targets: string[];
  }): HistoryEntry | null {
    const targets = ensureTrackedTargets(homeRoot, input.targets);
    if (targets.length === 0) {
      return null;
    }
    const dirtyPaths = trackedDirtyPaths(this.repo, homeRoot, targets);
    if (dirtyPaths.length === 0) {
      return null;
    }
    this.repo.run(homeRoot, ['add', '--all', '--', ...dirtyPaths]);
    this.repo.run(homeRoot, ['commit', '--no-gpg-sign', '-m', commitMessage({ ...input, targets })]);
    return this.listSync(homeRoot, 1)[0] ?? null;
  }

  private initializeOrMigrateRepo(homeRoot: string): void {
    this.ensureRepoRoot(homeRoot);
    const runtimeGitDir = join(homeRoot, 'runtime', '.git');
    const hasHead = this.repo.run(homeRoot, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }).trim().length > 0;
    if (!hasHead) {
      const initialTargets = existingTrackedRoots(homeRoot);
      const ignorePath = join(homeRoot, '.gitignore');
      const dirty = trackedDirtyPaths(this.repo, homeRoot, ['config.json', 'runtime/packages', 'runtime/policies']);
      if (dirty.length > 0 || existsSync(ignorePath)) {
        this.repo.run(homeRoot, ['add', '--all', '--', '.gitignore', ...initialTargets]);
        this.repo.run(
          homeRoot,
          [
            'commit',
            '--no-gpg-sign',
            '-m',
            commitMessage({
              kind: 'snapshot',
              title: existsSync(runtimeGitDir) ? 'snapshot: migrate runtime git repo to home root' : 'snapshot: initialize Moorline local history',
              actor: 'system:moorline-history',
              reason: existsSync(runtimeGitDir) ? 'Move Moorline history to the home root.' : 'Initialize Moorline local history.',
              operation: existsSync(runtimeGitDir) ? 'history.migrate' : 'history.initialize',
              targets: initialTargets.length > 0 ? initialTargets : ['config.json']
            })
          ]
        );
      }
    }
    if (existsSync(runtimeGitDir)) {
      this.repo.remove(runtimeGitDir);
    }
  }

  ensureInitializedSync(homeRoot: string): void {
    if (!this.repo.isGitAvailable()) {
      return;
    }
    const normalized = resolve(homeRoot);
    mkdirSync(normalized, { recursive: true });
    this.initializeOrMigrateRepo(normalized);
  }

  async ensureInitialized(homeRoot: string): Promise<void> {
    this.ensureInitializedSync(homeRoot);
  }

  statusSync(homeRoot: string): HistoryStatus {
    const normalized = resolve(homeRoot);
    if (!this.repo.isGitAvailable()) {
      return {
        gitAvailable: false,
        repoInitialized: false,
        homeRoot: normalized,
        branch: null,
        dirtyPaths: [],
        lastEntry: null
      };
    }
    if (!this.repo.hasRepo(normalized)) {
      return {
        gitAvailable: true,
        repoInitialized: false,
        homeRoot: normalized,
        branch: null,
        dirtyPaths: [],
        lastEntry: null
      };
    }
    const branch = this.repo.run(normalized, ['branch', '--show-current'], { allowFailure: true }).trim() || null;
    const dirtyPaths = trackedDirtyPaths(this.repo, normalized);
    return {
      gitAvailable: true,
      repoInitialized: true,
      homeRoot: normalized,
      branch,
      dirtyPaths,
      lastEntry: this.listSync(normalized, 1)[0] ?? null
    };
  }

  async status(homeRoot: string): Promise<HistoryStatus> {
    return this.statusSync(homeRoot);
  }

  listSync(homeRoot: string, limit = 30): HistoryEntry[] {
    const normalized = resolve(homeRoot);
    if (!this.repo.isGitAvailable() || !this.repo.hasRepo(normalized)) {
      return [];
    }
    const raw = this.repo.run(normalized, ['log', `--max-count=${limit}`, `--format=${gitHistoryLogFormat()}`], { allowFailure: true });
    return parseGitHistoryLog(raw);
  }

  async list(homeRoot: string, limit = 30): Promise<HistoryEntry[]> {
    return this.listSync(homeRoot, limit);
  }

  showSync(homeRoot: string, commitish: string): { entry: HistoryEntry | null; stat: string } {
    const normalized = resolve(homeRoot);
    this.ensureGitAvailable();
    const stat = this.repo.run(normalized, ['show', '--stat', '--format=fuller', commitish]);
    const entry = this.repo.run(normalized, ['log', '-1', `--format=${gitHistoryLogFormat()}`, commitish], { allowFailure: true });
    return {
      entry: parseGitHistoryLog(entry)[0] ?? null,
      stat: stat.trimEnd()
    };
  }

  createCheckpointSync(input: TrackedMutationDescriptor): HistoryEntry | null {
    this.ensureInitializedSync(input.homeRoot);
    if (!this.repo.isGitAvailable() || !this.repo.hasRepo(input.homeRoot)) {
      return null;
    }
    return this.createCommit(resolve(input.homeRoot), {
      kind: 'checkpoint',
      title: `checkpoint: ${input.operation}`,
      actor: input.actor,
      reason: input.reason,
      operation: input.operation,
      targets: input.targets
    });
  }

  async createCheckpoint(input: TrackedMutationDescriptor): Promise<HistoryEntry | null> {
    return this.createCheckpointSync(input);
  }

  createSnapshotSync(input: { homeRoot: string; label: string; actor: string; reason?: string }): HistoryEntry | null {
    this.ensureInitializedSync(input.homeRoot);
    if (!this.repo.isGitAvailable() || !this.repo.hasRepo(input.homeRoot)) {
      return null;
    }
    return this.createCommit(resolve(input.homeRoot), {
      kind: 'snapshot',
      title: `snapshot: ${input.label}`,
      actor: input.actor,
      reason: input.reason ?? input.label,
      operation: 'history.snapshot',
      targets: existingTrackedRoots(input.homeRoot)
    });
  }

  async createSnapshot(input: { homeRoot: string; label: string; actor: string; reason?: string }): Promise<HistoryEntry | null> {
    return this.createSnapshotSync(input);
  }

  diffSync(input: HistoryDiffRequest): string {
    const normalized = resolve(input.homeRoot);
    this.ensureGitAvailable();
    if (!this.repo.hasRepo(normalized)) {
      return '';
    }
    const args = ['diff', '--no-color'];
    if (input.from && input.to) {
      args.push(input.from, input.to);
    } else if (input.from) {
      args.push(input.from);
    }
    if (input.path) {
      args.push('--', normalizeRepoRelativePath(input.path));
    } else {
      const roots = existingTrackedRoots(normalized);
      if (roots.length > 0) {
        args.push('--', ...roots);
      }
    }
    return formatGitDiffOutput(this.repo.run(normalized, args, { allowFailure: true }));
  }

  async diff(input: HistoryDiffRequest): Promise<string> {
    return this.diffSync(input);
  }

  restoreSync(input: HistoryRestoreRequest): HistoryEntry {
    const normalized = resolve(input.homeRoot);
    this.ensureGitAvailable();
    this.ensureInitializedSync(normalized);
    const targets = ensureTrackedTargets(normalized, input.paths);
    if (targets.length === 0) {
      throw new Error('No tracked paths are available to restore.');
    }
    this.repo.run(normalized, ['restore', '--source', input.commitish, '--worktree', '--', ...targets]);
    const restored = this.createCommit(normalized, {
      kind: 'snapshot',
      title: `snapshot: restore ${input.commitish.slice(0, 7)}`,
      actor: input.actor,
      reason: input.reason ?? `Restore tracked files from ${input.commitish}.`,
      operation: 'history.restore',
      targets
    });
    if (!restored) {
      throw new Error('Restore did not change any tracked files.');
    }
    return restored;
  }

  async restore(input: HistoryRestoreRequest): Promise<HistoryEntry> {
    return this.restoreSync(input);
  }

  discardSync(input: { homeRoot: string; paths?: string[] }): void {
    const normalized = resolve(input.homeRoot);
    this.ensureGitAvailable();
    if (!this.repo.hasRepo(normalized)) {
      return;
    }
    const targets = ensureTrackedTargets(normalized, input.paths);
    if (targets.length === 0) {
      return;
    }
    this.repo.run(normalized, ['restore', '--worktree', '--', ...targets], { allowFailure: true });
  }

  async discard(input: { homeRoot: string; paths?: string[] }): Promise<void> {
    this.discardSync(input);
  }
}
