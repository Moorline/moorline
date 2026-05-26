import { rmSync } from 'node:fs';
import { join } from 'node:path';

const distRoot = join(process.cwd(), 'dist');
console.log(`[moorline] removing generated output: ${distRoot}`);
rmSync(distRoot, { recursive: true, force: true });
