import { apiGet, apiPost, parseConnectionOptions, requireValue } from './cliCommandParseUtils.js';
import type { CliCommand } from './cliCommandTypes.js';

export function parseRequestsCommand(rest: string[], configPath: string | undefined): CliCommand | null {
  const command = rest[0];
  if (command !== 'requests') {
    return null;
  }

  if (rest[1] === 'list') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline requests list [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiGet('/api/pending-requests/list', configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'inspect') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length !== 1) {
      throw new Error('Usage: moorline requests inspect <request-id> [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiGet(`/api/pending-requests/inspect?requestId=${encodeURIComponent(parsed.rest[0])}`, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'resolve') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length !== 2 || !['accept', 'decline', 'cancel'].includes(parsed.rest[1])) {
      throw new Error('Usage: moorline requests resolve <request-id> <accept|decline|cancel> [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiPost('/api/pending-requests/resolve', { requestId: parsed.rest[0], decision: parsed.rest[1] }, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'cancel') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length !== 1) {
      throw new Error('Usage: moorline requests cancel <request-id> [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiPost('/api/pending-requests/cancel', { requestId: parsed.rest[0] }, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'answer') {
    const usage =
      'Usage: moorline requests answer <request-id> --answers <json-object> [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(2));
    let requestId: string | undefined;
    let answers: Record<string, string | string[]> | undefined;
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (!requestId && !token.startsWith('--')) {
        requestId = token;
        continue;
      }
      if (token === '--answers') {
        const raw = requireValue(parsed.rest[index + 1], usage);
        try {
          const parsedAnswers = JSON.parse(raw);
          if (!parsedAnswers || typeof parsedAnswers !== 'object' || Array.isArray(parsedAnswers)) {
            throw new Error('answers must be a JSON object.');
          }
          answers = parsedAnswers as Record<string, string | string[]>;
        } catch (error) {
          throw new Error(error instanceof Error ? `Invalid --answers payload: ${error.message}` : 'Invalid --answers payload.');
        }
        index += 1;
        continue;
      }
      throw new Error(usage);
    }
    if (!requestId || !answers) {
      throw new Error(usage);
    }
    return apiPost('/api/pending-requests/answer', { requestId, answers }, configPath, parsed.options, parsed.json);
  }

  return null;
}
