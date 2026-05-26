function runtimeLabel(): string {
  if (typeof process.versions.bun === 'string') {
    return `bun ${process.versions.bun}`;
  }
  if (typeof process.versions.node === 'string') {
    return `node ${process.versions.node}`;
  }
  return 'unknown runtime';
}

export async function detectSqliteRuntimeSupport(): Promise<{ ok: boolean; detail: string }> {
  const runtime = runtimeLabel();
  try {
    const module = (await import('node:sqlite')) as { DatabaseSync?: unknown };
    if (typeof module.DatabaseSync !== 'function') {
      return {
        ok: false,
        detail: `${runtime} does not expose DatabaseSync from node:sqlite`
      };
    }
    return {
      ok: true,
      detail: `${runtime} exposes node:sqlite`
    };
  } catch (error) {
    return {
      ok: false,
      detail: `${runtime} cannot load node:sqlite: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
