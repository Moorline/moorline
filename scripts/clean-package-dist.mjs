import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageName = process.argv[2];
if (!packageName) {
  throw new Error('Usage: node scripts/clean-package-dist.mjs <package-dir-name>');
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = join(projectRoot, 'packages', packageName, 'dist');

if (existsSync(distRoot)) {
  rmSync(distRoot, { recursive: true, force: true });
}
