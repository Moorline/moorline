import type { HistoryEntry, HistoryEntryKind, TrackedSurfaceTarget } from '../../../types/history.js';

const RECORD_SEPARATOR = '\u001e';
const FIELD_SEPARATOR = '\u001f';

function parseTargets(raw: string | undefined): TrackedSurfaceTarget[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((path) => ({ path }));
}

function historyKindFromTrailers(trailers: Record<string, string>): HistoryEntryKind {
  const kind = trailers['Moorline-Kind'];
  if (kind === 'checkpoint' || kind === 'snapshot') {
    return kind;
  }
  return 'external';
}

function parseTrailers(body: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const match = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/u);
    if (!match) {
      continue;
    }
    trailers[match[1]] = match[2].trim();
  }
  return trailers;
}

export function gitHistoryLogFormat(): string {
  return `%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%cI${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`;
}

export function parseGitHistoryLog(raw: string): HistoryEntry[] {
  return raw
    .split(RECORD_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [commitId, shortCommitId, createdAt, subject, body = ''] = entry.split(FIELD_SEPARATOR);
      const trailers = parseTrailers(body);
      return {
        commitId,
        shortCommitId,
        kind: historyKindFromTrailers(trailers),
        title: subject,
        createdAt,
        actor: trailers['Moorline-Actor'] ?? null,
        reason: trailers['Moorline-Reason'] ?? null,
        operation: trailers['Moorline-Operation'] ?? null,
        targets: parseTargets(trailers['Moorline-Targets'])
      } satisfies HistoryEntry;
    });
}
