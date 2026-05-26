import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function findBundleRoot(rootDir: string): string {
  const stack = [rootDir];
  const matches: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const stat = statSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      continue;
    }
    if (existsSync(join(current, 'manifest.json'))) {
      matches.push(current);
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      stack.push(join(current, entry.name));
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Moorline bundle root in ${rootDir}, found ${matches.length}`);
  }
  return matches[0];
}
