import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RuntimePackageLoadFailure, RuntimePackageLoadReport } from '../../../types/release.js';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function loadRuntimePackageLoadReport(path: string): RuntimePackageLoadReport | null {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as RuntimePackageLoadReport;
}

export function saveRuntimePackageLoadReport(path: string, report: RuntimePackageLoadReport): void {
  writeJson(path, report);
}

export function createRuntimePackageLoadReport(input: {
  runtimeMode: RuntimePackageLoadReport['runtimeMode'];
  releaseManifest: RuntimePackageLoadReport['releaseManifest'];
  failures: RuntimePackageLoadFailure[];
  updatedAt: string;
}): RuntimePackageLoadReport {
  return {
    runtimeMode: input.runtimeMode,
    releaseManifest: input.releaseManifest,
    failures: input.failures,
    updatedAt: input.updatedAt
  };
}
