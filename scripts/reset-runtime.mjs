#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

function defaultHomeRoot() {
  const override = process.env.MOORLINE_HOME?.trim();
  return resolve(override || homedir(), override ? '.' : '.moorline');
}

function defaultConfigPath() {
  const explicit = process.env.MOORLINE_CONFIG?.trim();
  return explicit && explicit.length > 0 ? resolve(explicit) : resolve(defaultHomeRoot(), 'config.json');
}

function resolveRuntimeRoot() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--runtime-root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value after --runtime-root.');
      }
      return resolve(value);
    }
  }

  const configPath = defaultConfigPath();
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.runtimeRoot === 'string' && parsed.runtimeRoot.trim().length > 0) {
      return resolve(parsed.runtimeRoot);
    }
  }

  return resolve(defaultHomeRoot(), 'runtime');
}

try {
  const runtimeRoot = resolveRuntimeRoot();
  rmSync(runtimeRoot, { recursive: true, force: true });
  process.stdout.write(`Removed runtime root: ${runtimeRoot}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`reset-runtime failed: ${detail}\n`);
  process.exitCode = 1;
}
