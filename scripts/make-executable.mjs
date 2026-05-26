import { chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  throw new Error('Usage: node scripts/make-executable.mjs <path>');
}

const resolved = resolve(process.cwd(), target);
if (!existsSync(resolved) || process.platform === 'win32') {
  process.exit(0);
}

chmodSync(resolved, 0o755);
