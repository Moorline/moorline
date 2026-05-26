import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function isResolvedPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return (
    rel === '' ||
    (!(rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || rel.startsWith('..\\')) &&
      !isAbsolute(rel))
  );
}

export function canonicalizeExistingPath(path: string, label: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch (error) {
    throw new Error(
      `${label} does not exist or cannot be resolved: ${path}. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function isCanonicalExistingPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const canonicalRoot = canonicalizeExistingPath(rootPath, 'Root path');
  const canonicalCandidate = canonicalizeExistingPath(candidatePath, 'Candidate path');
  return isResolvedPathWithinRoot(canonicalRoot, canonicalCandidate);
}

export function assertCanonicalExistingPathWithinRoot(input: {
  rootPath: string;
  candidatePath: string;
  rootLabel: string;
  candidateLabel: string;
}): string {
  const canonicalRoot = canonicalizeExistingPath(input.rootPath, input.rootLabel);
  const canonicalCandidate = canonicalizeExistingPath(input.candidatePath, input.candidateLabel);
  if (!isResolvedPathWithinRoot(canonicalRoot, canonicalCandidate)) {
    throw new Error(`${input.candidateLabel} must stay inside ${input.rootLabel}.`);
  }
  return canonicalCandidate;
}
