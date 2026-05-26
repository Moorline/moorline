export function safeParseEmbedding(raw: string): number[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    if (!parsed.length) {
      return [];
    }
    if (!parsed.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return null;
    }
    return parsed as number[];
  } catch {
    return null;
  }
}

export function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string') ? parsed : [];
  } catch {
    return [];
  }
}
