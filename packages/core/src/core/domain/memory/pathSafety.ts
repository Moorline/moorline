import { isAbsolute, relative, resolve } from 'node:path';

function containsForbiddenPathChar(value: string): boolean {
  for (const char of value) {
    if (char === '/' || char === '\\') {
      return true;
    }
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

export function sanitizePathSegment(value: string, label: string): string {
  const normalized = value.trim().normalize('NFKC');
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (normalized === '.' || normalized === '..' || normalized.includes('..')) {
    throw new Error(`${label} must not include dot-segments.`);
  }
  if (containsForbiddenPathChar(normalized)) {
    throw new Error(`${label} contains forbidden path characters.`);
  }
  return normalized;
}

export function resolveContainedPath(rootDir: string, pathSegments: string[], label: string): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(resolvedRoot, ...pathSegments);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return resolvedPath;
  }
  throw new Error(`${label} resolved outside the runtime memory root.`);
}
