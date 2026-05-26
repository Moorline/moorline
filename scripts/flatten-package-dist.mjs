import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageName = process.argv[2];
if (!packageName) {
  throw new Error('Usage: node scripts/flatten-package-dist.mjs <package-dir-name>');
}

const projectRoot = process.env.MOORLINE_FLATTEN_PROJECT_ROOT
  ? resolve(process.env.MOORLINE_FLATTEN_PROJECT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages', packageName);
const distRoot = join(packageRoot, 'dist');
const candidates = [
  join(distRoot, 'packages', packageName, 'src'),
  join(distRoot, 'packages', packageName)
];
const sourceRoot = candidates.find((candidate) => existsSync(candidate));

if (!sourceRoot) {
  throw new Error(`Could not find built output for packages/${packageName}`);
}

mkdirSync(distRoot, { recursive: true });

for (const entry of readdirSync(distRoot)) {
  if (entry !== 'packages') {
    rmSync(join(distRoot, entry), { recursive: true, force: true });
  }
}

for (const entry of readdirSync(sourceRoot)) {
  cpSync(join(sourceRoot, entry), join(distRoot, entry), { recursive: true });
}

const nestedPackages = join(distRoot, 'packages');
if (existsSync(nestedPackages)) {
  rmSync(nestedPackages, { recursive: true, force: true });
}
