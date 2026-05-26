import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('packages/core/dist/core/extension/packages/officialCatalog.js')) {
  console.log('Release resources not refreshed because dist core build is not present.');
  process.exit(0);
}

execFileSync('bun', ['scripts/copy-migrations.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit'
});
