import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import { parseMoorlineConfig, type MoorlineConfig } from '../../../types/config.js';
import { resolveSecretsPathForConfigPath, runtimePaths } from '../config/configStore.js';
import { PackageInventoryStore } from '../../extension/packages/packageInventoryStore.js';
import { SqliteSessionStore } from '../state/sqliteSessionStore.js';

const { dirname, join, resolve } = path;

const BACKUP_SCHEMA_VERSION = 1;
const MAX_BACKUP_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_BACKUP_ARCHIVE_FILES = 50_000;
const MAX_BACKUP_EXTRACTED_BYTES = 5 * 1024 * 1024 * 1024;

interface RuntimeBackupManifest {
  schemaVersion: number;
  createdAt: string;
  includeWorkspaces: boolean;
  source: {
    configPath: string;
    runtimeRoot: string;
  };
}

interface CreateRuntimeBackupInput {
  config: MoorlineConfig;
  configPath: string;
  includeWorkspaces: boolean;
  outputPath: string;
  nowIso?: string;
}

interface CreateRuntimeBackupResult {
  archivePath: string;
  includeWorkspaces: boolean;
}

interface ImportRuntimeBackupInput {
  archivePath: string;
  targetConfigPath: string;
  targetRuntimeRoot: string;
  force: boolean;
}

interface ImportRuntimeBackupResult {
  configPath: string;
  runtimeRoot: string;
  replacedExistingState: boolean;
}

function ensureSafeDirectoryTarget(path: string): void {
  const resolved = resolve(path);
  if (resolved === '/' || resolved === '' || resolved === '.' || resolved.length < 2) {
    throw new Error(`Refusing to operate on unsafe directory target: ${path}`);
  }
}

function ensureSafeFileTarget(path: string): void {
  const resolved = resolve(path);
  const parent = dirname(resolved);
  ensureSafeDirectoryTarget(parent);
  if (resolved === parent) {
    throw new Error(`Refusing to operate on unsafe file target: ${path}`);
  }
}

function isDirectoryNonEmpty(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return readdirSync(path).length > 0;
  } catch {
    return true;
  }
}

function ensureParent(path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

function tempStage(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function copyRuntimeRoot(input: {
  runtimeRoot: string;
  destination: string;
  includeWorkspaces: boolean;
}): void {
  const resolvedRuntimeRoot = resolve(input.runtimeRoot);
  const workspacesPath = resolve(resolvedRuntimeRoot, 'workspaces');
  const backupsPath = resolve(resolvedRuntimeRoot, 'state', 'backups');
  cpSync(resolvedRuntimeRoot, input.destination, {
    recursive: true,
    force: true,
    filter: (source) => {
      const resolvedSource = resolve(source);
      if (resolvedSource === backupsPath || isPathWithinDirectory(backupsPath, resolvedSource)) {
        return false;
      }
      if (input.includeWorkspaces) {
        return true;
      }
      if (resolvedSource === workspacesPath) {
        return false;
      }
      return !isPathWithinDirectory(workspacesPath, resolvedSource);
    }
  });
}

function isPathWithinDirectory(
  rootPath: string,
  candidatePath: string,
  pathOps: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute'> = path
): boolean {
  const rel = pathOps.relative(pathOps.resolve(rootPath), pathOps.resolve(candidatePath));
  return rel === '' || (!rel.startsWith('..') && !pathOps.isAbsolute(rel));
}

function normalizeTarEntryPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function assertSafeTarEntryPath(path: string): void {
  const normalized = normalizeTarEntryPath(path);
  if (!normalized || normalized.startsWith('/')) {
    throw new Error(`Backup archive contains an invalid absolute entry path: ${path}`);
  }
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Backup archive contains an invalid traversal entry path: ${path}`);
  }
}

async function validateBackupArchiveBeforeExtract(archivePath: string): Promise<void> {
  const stats = statSync(archivePath, { throwIfNoEntry: false });
  if (!stats || !stats.isFile()) {
    throw new Error(`Backup archive does not exist: ${archivePath}`);
  }
  if (stats.size > MAX_BACKUP_ARCHIVE_BYTES) {
    throw new Error(`Backup archive exceeds ${MAX_BACKUP_ARCHIVE_BYTES} bytes.`);
  }

  let fileCount = 0;
  let extractedBytes = 0;
  await tar.list({
    file: archivePath,
    strict: true,
    onReadEntry: (entry) => {
      assertSafeTarEntryPath(entry.path);
      fileCount += 1;
      if (fileCount > MAX_BACKUP_ARCHIVE_FILES) {
        throw new Error(`Backup archive contains too many files: ${fileCount} > ${MAX_BACKUP_ARCHIVE_FILES}`);
      }
      if (typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size > 0) {
        extractedBytes += entry.size;
        if (extractedBytes > MAX_BACKUP_EXTRACTED_BYTES) {
          throw new Error(`Backup archive expands beyond ${MAX_BACKUP_EXTRACTED_BYTES} bytes.`);
        }
      }
    }
  });
}

export async function createRuntimeBackup(input: CreateRuntimeBackupInput): Promise<CreateRuntimeBackupResult> {
  const archivePath = resolve(input.outputPath);
  ensureSafeFileTarget(archivePath);
  ensureSafeDirectoryTarget(input.config.runtimeRoot);
  ensureParent(archivePath);

  const stageRoot = tempStage('moorline-backup-stage-');
  try {
    const runtimeStage = join(stageRoot, 'runtime');
    const configStage = join(stageRoot, 'config.json');
    const secretsStage = join(stageRoot, 'config.secrets.json');
    const manifestStage = join(stageRoot, 'manifest.json');
    const sourceConfigPath = resolve(input.configPath);
    const sourceSecretsPath = resolveSecretsPathForConfigPath(sourceConfigPath);

    if (!existsSync(sourceConfigPath)) {
      throw new Error(`Config path does not exist: ${sourceConfigPath}`);
    }
    if (!existsSync(input.config.runtimeRoot)) {
      throw new Error(`Runtime root does not exist: ${input.config.runtimeRoot}`);
    }

    writeFileSync(configStage, readFileSync(sourceConfigPath));
    if (existsSync(sourceSecretsPath)) {
      writeFileSync(secretsStage, readFileSync(sourceSecretsPath));
    }
    copyRuntimeRoot({
      runtimeRoot: input.config.runtimeRoot,
      destination: runtimeStage,
      includeWorkspaces: input.includeWorkspaces
    });
    const nowIso = input.nowIso ?? new Date().toISOString();
    const manifest: RuntimeBackupManifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      createdAt: nowIso,
      includeWorkspaces: input.includeWorkspaces,
      source: {
        configPath: sourceConfigPath,
        runtimeRoot: resolve(input.config.runtimeRoot)
      }
    };
    writeFileSync(manifestStage, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await tar.create(
      {
        gzip: true,
        file: archivePath,
        cwd: stageRoot,
        portable: true
      },
      ['manifest.json', 'config.json', ...(existsSync(secretsStage) ? ['config.secrets.json'] : []), 'runtime']
    );
    return {
      archivePath,
      includeWorkspaces: input.includeWorkspaces
    };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

function readBackupManifest(stageRoot: string): RuntimeBackupManifest {
  const manifestPath = join(stageRoot, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('Backup archive is missing manifest.json.');
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Backup manifest must be a JSON object.');
  }
  const manifest = raw as Partial<RuntimeBackupManifest>;
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`Unsupported backup manifest schema version: ${String(manifest.schemaVersion)}.`);
  }
  if (typeof manifest.createdAt !== 'string' || !manifest.createdAt.trim()) {
    throw new Error('Backup manifest is missing createdAt.');
  }
  if (typeof manifest.includeWorkspaces !== 'boolean') {
    throw new Error('Backup manifest includeWorkspaces must be a boolean.');
  }
  if (typeof manifest.source !== 'object' || manifest.source === null) {
    throw new Error('Backup manifest source must be an object.');
  }
  if (typeof manifest.source.configPath !== 'string' || !manifest.source.configPath.trim()) {
    throw new Error('Backup manifest source.configPath must be a non-empty string.');
  }
  if (typeof manifest.source.runtimeRoot !== 'string' || !manifest.source.runtimeRoot.trim()) {
    throw new Error('Backup manifest source.runtimeRoot must be a non-empty string.');
  }
  return {
    schemaVersion: manifest.schemaVersion,
    createdAt: manifest.createdAt,
    includeWorkspaces: manifest.includeWorkspaces,
    source: {
      configPath: manifest.source.configPath,
      runtimeRoot: manifest.source.runtimeRoot
    }
  };
}

function readBackupConfig(stageRoot: string): {
  config: MoorlineConfig;
} {
  const configPath = join(stageRoot, 'config.json');
  if (!existsSync(configPath)) {
    throw new Error('Backup archive is missing config.json.');
  }
  const parsed = parseMoorlineConfig(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
  ensureSafeDirectoryTarget(parsed.runtimeRoot);
  return {
    config: parsed
  };
}

function hasNonEmptyTargetState(input: {
  configPath: string;
  secretsPath: string;
  runtimeRoot: string;
}): boolean {
  return existsSync(input.configPath) || existsSync(input.secretsPath) || isDirectoryNonEmpty(input.runtimeRoot);
}

function rewriteRestoredSessionWorkspacePaths(runtimeRoot: string): void {
  const paths = runtimePaths(runtimeRoot);
  if (!existsSync(paths.sqlitePath)) {
    return;
  }
  mkdirSync(paths.workspacesDir, { recursive: true });
  const store = new SqliteSessionStore(paths.sqlitePath);
  try {
    for (const session of store.listSessions()) {
      const workspacePath = join(paths.workspacesDir, session.sessionId);
      mkdirSync(workspacePath, { recursive: true });
      store.upsertSession({
        ...session,
        workspacePath
      });
    }
  } finally {
    store.close();
  }
}

function rewriteRuntimeRootPath(input: {
  value: string;
  sourceRuntimeRoot: string;
  targetRuntimeRoot: string;
}): string {
  const sourceRoot = resolve(input.sourceRuntimeRoot);
  const targetRoot = resolve(input.targetRuntimeRoot);
  const value = resolve(input.value);
  if (value === sourceRoot || isPathWithinDirectory(sourceRoot, value)) {
    return join(targetRoot, path.relative(sourceRoot, value));
  }
  return input.value;
}

function rewriteRestoredPackageInventoryPaths(input: {
  sourceRuntimeRoot: string;
  targetRuntimeRoot: string;
}): void {
  const paths = runtimePaths(input.targetRuntimeRoot);
  if (!existsSync(paths.packageInventoryPath)) {
    return;
  }
  const inventory = new PackageInventoryStore(input.targetRuntimeRoot);
  const state = inventory.load();
  for (const record of state.installed) {
    record.installPath = rewriteRuntimeRootPath({
      value: record.installPath,
      sourceRuntimeRoot: input.sourceRuntimeRoot,
      targetRuntimeRoot: input.targetRuntimeRoot
    });
    record.manifestPath = rewriteRuntimeRootPath({
      value: record.manifestPath,
      sourceRuntimeRoot: input.sourceRuntimeRoot,
      targetRuntimeRoot: input.targetRuntimeRoot
    });
    if (record.source.kind === 'local_dir' || record.source.kind === 'local_archive') {
      record.source.path = rewriteRuntimeRootPath({
        value: record.source.path,
        sourceRuntimeRoot: input.sourceRuntimeRoot,
        targetRuntimeRoot: input.targetRuntimeRoot
      });
    }
  }
  inventory.save(state);
}

function removeRestoredControlApiBootstrap(runtimeRoot: string): void {
  rmSync(join(runtimePaths(runtimeRoot).stateDir, 'control-api-bootstrap.json'), { force: true });
}

export async function importRuntimeBackup(input: ImportRuntimeBackupInput): Promise<ImportRuntimeBackupResult> {
  const archivePath = resolve(input.archivePath);
  if (!existsSync(archivePath)) {
    throw new Error(`Backup archive does not exist: ${archivePath}`);
  }
  await validateBackupArchiveBeforeExtract(archivePath);

  const stageRoot = tempStage('moorline-import-stage-');
  try {
    await tar.extract({
      file: archivePath,
      cwd: stageRoot,
      strict: true
    });
    const manifest = readBackupManifest(stageRoot);
    const backupInfo = readBackupConfig(stageRoot);
    const runtimeStage = join(stageRoot, 'runtime');
    if (!existsSync(runtimeStage)) {
      throw new Error('Backup archive is missing runtime state.');
    }
    if (resolve(manifest.source.runtimeRoot) !== resolve(backupInfo.config.runtimeRoot)) {
      throw new Error('Backup manifest runtimeRoot does not match backup config runtimeRoot.');
    }

    const targetConfigPath = resolve(input.targetConfigPath);
    const targetSecretsPath = resolveSecretsPathForConfigPath(targetConfigPath);
    const targetRuntimeRoot = resolve(input.targetRuntimeRoot);
    ensureSafeFileTarget(targetConfigPath);
    ensureSafeDirectoryTarget(targetRuntimeRoot);

    const targetNonEmpty = hasNonEmptyTargetState({
      configPath: targetConfigPath,
      secretsPath: targetSecretsPath,
      runtimeRoot: targetRuntimeRoot
    });
    if (targetNonEmpty && !input.force) {
      throw new Error(
        'Import target already contains state. Re-run with --force after confirming you want to delete existing local state.'
      );
    }
    if (targetNonEmpty && input.force) {
      rmSync(targetRuntimeRoot, { recursive: true, force: true });
      rmSync(targetConfigPath, { force: true });
      rmSync(targetSecretsPath, { force: true });
    }

    ensureParent(targetConfigPath);
    ensureParent(targetSecretsPath);
    mkdirSync(targetRuntimeRoot, { recursive: true });
    const restoredConfig: MoorlineConfig = {
      ...backupInfo.config,
      runtimeRoot: targetRuntimeRoot
    };
    writeFileSync(targetConfigPath, `${JSON.stringify(restoredConfig, null, 2)}\n`, 'utf8');
    const stagedSecretsPath = join(stageRoot, 'config.secrets.json');
    if (existsSync(stagedSecretsPath)) {
      writeFileSync(targetSecretsPath, readFileSync(stagedSecretsPath));
    }
    cpSync(runtimeStage, targetRuntimeRoot, { recursive: true, force: true });
    removeRestoredControlApiBootstrap(targetRuntimeRoot);
    rewriteRestoredSessionWorkspacePaths(targetRuntimeRoot);
    rewriteRestoredPackageInventoryPaths({
      sourceRuntimeRoot: backupInfo.config.runtimeRoot,
      targetRuntimeRoot
    });

    const parsedConfig = parseMoorlineConfig(JSON.parse(readFileSync(targetConfigPath, 'utf8')) as unknown);
    const parsedRuntimeRoot = resolve(parsedConfig.runtimeRoot);
    if (parsedRuntimeRoot !== targetRuntimeRoot) {
      throw new Error(
        `Imported config runtimeRoot (${parsedRuntimeRoot}) does not match restored runtime root (${targetRuntimeRoot}).`
      );
    }
    return {
      configPath: targetConfigPath,
      runtimeRoot: targetRuntimeRoot,
      replacedExistingState: targetNonEmpty
    };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}
