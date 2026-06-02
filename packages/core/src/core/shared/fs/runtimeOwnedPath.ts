import { lstatSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function assertRuntimeOwnedWorkspacePath(input: {
  workspacesDir: string;
  workspacePath: string;
  expectedWorkDirName: string;
  entityLabel: string;
}): string {
  const root = resolve(input.workspacesDir);
  const candidate = resolve(input.workspacePath);
  const expected = resolve(join(root, input.expectedWorkDirName));

  if (!isPathWithinRoot(root, candidate)) {
    throw new Error(`${input.entityLabel} workspace path is outside the managed runtime workspace root.`);
  }

  if (candidate !== expected || basename(candidate) !== input.expectedWorkDirName) {
    throw new Error(
      `${input.entityLabel} workspace path does not match the runtime-owned work directory id ${input.expectedWorkDirName}.`
    );
  }

  const stats = lstatSync(candidate, { throwIfNoEntry: false });
  if (stats?.isSymbolicLink()) {
    throw new Error(`${input.entityLabel} workspace path is a symlink and cannot be deleted recursively.`);
  }

  return candidate;
}
