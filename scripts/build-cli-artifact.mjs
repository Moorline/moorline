import { execFileSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { create } from 'tar';
import { ZipFile } from 'yazl';

function readFlag(argv, flag, fallback = undefined) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1] ?? fallback;
}

function requireFlag(argv, flag) {
  const value = readFlag(argv, flag);
  if (!value) {
    throw new Error(`Missing required flag ${flag}`);
  }
  return value;
}

function normalizeTargetPlatform(platformLabel) {
  if (platformLabel.startsWith('windows')) {
    return { platform: 'win32', runtimeBinaryName: 'node.exe' };
  }
  if (platformLabel.startsWith('linux')) {
    return { platform: 'linux', runtimeBinaryName: 'node' };
  }
  if (platformLabel.startsWith('darwin') || platformLabel.startsWith('macos') || platformLabel.startsWith('mac')) {
    return { platform: 'darwin', runtimeBinaryName: 'node' };
  }
  throw new Error(`Unsupported platform label: ${platformLabel}`);
}

async function createZip(sourceDir, archivePath) {
  await new Promise((resolvePromise, reject) => {
    const zip = new ZipFile();
    mkdirSync(dirname(archivePath), { recursive: true });
    zip.outputStream.pipe(createWriteStream(archivePath)).on('close', resolvePromise).on('error', reject);
    zip.addDir(sourceDir, basename(sourceDir));
    zip.end();
  });
}

function writeUnixLauncher(bundleRoot, runtimeBinaryName) {
  const launcherPath = join(bundleRoot, 'moorline');
  writeFileSync(
    launcherPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      `exec "$DIR/${runtimeBinaryName}" --disable-warning=ExperimentalWarning "$DIR/app/main.mjs" "$@"`
    ].join('\n'),
    'utf8'
  );
  execFileSync('node', ['scripts/make-executable.mjs', launcherPath], {
    cwd: process.cwd(),
    stdio: 'inherit'
  });
}

function writeWindowsLauncher(bundleRoot, runtimeBinaryName) {
  writeFileSync(
    join(bundleRoot, 'moorline.cmd'),
    [
      '@echo off',
      'set "SCRIPT_DIR=%~dp0"',
      `"%SCRIPT_DIR%${runtimeBinaryName}" --disable-warning=ExperimentalWarning "%SCRIPT_DIR%app\\main.mjs" %*`
    ].join('\r\n'),
    'utf8'
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const platformLabel = requireFlag(argv, '--platform');
  const archiveFormat = readFlag(argv, '--archive-format', platformLabel.startsWith('windows') ? 'zip' : 'tar.gz');
  const targetPlatform = normalizeTargetPlatform(platformLabel);
  const projectRoot = process.cwd();
  const distRoot = join(projectRoot, 'dist');
  const sourceEntrypoint = resolve(projectRoot, 'packages', 'cli', 'src', 'main.ts');
  const resourcesDir = resolve(distRoot, 'resources');
  if (targetPlatform.platform !== process.platform) {
    throw new Error(
      `Cross-platform artifact build is not supported for ${platformLabel} on host ${process.platform}. ` +
      'Build this artifact on the matching target platform.'
    );
  }

  if (!existsSync(sourceEntrypoint)) {
    throw new Error(`Source entrypoint missing: ${sourceEntrypoint}`);
  }
  if (!existsSync(resourcesDir)) {
    throw new Error(`Release resources missing: ${resourcesDir}`);
  }

  const bundleRoot = resolve(distRoot, 'cli-bundles', platformLabel, `moorline-cli-${platformLabel}`);
  const appRoot = join(bundleRoot, 'app');
  const bundledEntrypoint = join(appRoot, 'main.mjs');
  const runtimeBinaryName = targetPlatform.runtimeBinaryName;
  const runtimeBinarySource = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
  const archiveExtension = archiveFormat === 'zip' ? 'zip' : 'tar.gz';
  const archivePath = resolve(distRoot, 'release-artifacts', `moorline-cli-${platformLabel}.${archiveExtension}`);

  console.log(`[moorline] removing generated CLI bundle output: ${bundleRoot}`);
  rmSync(bundleRoot, { recursive: true, force: true });
  mkdirSync(appRoot, { recursive: true });

  execFileSync(
    'bun',
    ['build', sourceEntrypoint, '--bundle', '--target=node', '--format=esm', '--outfile', bundledEntrypoint],
    {
      cwd: projectRoot,
      stdio: 'inherit'
    }
  );

  cpSync(runtimeBinarySource, join(bundleRoot, runtimeBinaryName));
  cpSync(resourcesDir, join(bundleRoot, 'resources'), { recursive: true });
  if (archiveFormat === 'zip') {
    writeWindowsLauncher(bundleRoot, runtimeBinaryName);
  } else {
    writeUnixLauncher(bundleRoot, runtimeBinaryName);
  }
  writeFileSync(
    join(bundleRoot, 'INSTALL.txt'),
    [
      'Moorline 0.0.1 packaged CLI',
      '',
      platformLabel.startsWith('windows') ? 'Run moorline.cmd' : 'Run ./moorline',
      'Resources: ./resources',
      '',
      platformLabel.startsWith('windows') ? 'Then run: moorline.cmd init' : 'Then run: ./moorline init'
    ].join('\n'),
    'utf8'
  );

  const archiveDir = dirname(archivePath);
  console.log(`[moorline] removing generated CLI archive output: ${archiveDir}`);
  rmSync(archiveDir, { recursive: true, force: true });
  mkdirSync(archiveDir, { recursive: true });
  if (archiveFormat === 'zip') {
    await createZip(bundleRoot, archivePath);
  } else {
    await create(
      {
        gzip: true,
        cwd: dirname(bundleRoot),
        file: archivePath
      },
      [basename(bundleRoot)]
    );
  }

  console.log(`Built CLI artifact ${archivePath}`);
}

await main();
