import { URLSearchParams } from 'node:url';
import { apiGet, apiPost, parseConnectionOptions, requireValue } from './cliCommandParseUtils.js';
import type { CliCommand } from './cliCommandTypes.js';

export function parseHistoryCommand(rest: string[], configPath: string | undefined): CliCommand | null {
  const command = rest[0];
  if (command !== 'history') {
    return null;
  }

  if (rest[1] === 'status') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline history status [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiGet('/api/history/status', configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'list') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline history list [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiGet('/api/history/list', configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'show') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length !== 1) {
      throw new Error('Usage: moorline history show <commitish> [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiGet(`/api/history/show?commitish=${encodeURIComponent(parsed.rest[0])}`, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'diff') {
    const usage =
      'Usage: moorline history diff [<from>] [<to>] [--path <tracked-path>] [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(2));
    let path: string | undefined;
    const positionals: string[] = [];
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--path') {
        path = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(usage);
      }
      positionals.push(token);
    }
    if (positionals.length > 2) {
      throw new Error(usage);
    }
    const query = new URLSearchParams();
    if (positionals[0]) query.set('from', positionals[0]);
    if (positionals[1]) query.set('to', positionals[1]);
    if (path) query.set('path', path);
    return apiGet(`/api/history/diff?${query.toString()}`, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'snapshot') {
    const parsed = parseConnectionOptions(rest.slice(2));
    const label = parsed.rest.join(' ').trim();
    if (!label) {
      throw new Error('Usage: moorline history snapshot <label> [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiPost('/api/history/snapshot', { label }, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'restore') {
    const usage =
      'Usage: moorline history restore <commitish> [--path <tracked-path>] [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(2));
    let path: string | undefined;
    const positionals: string[] = [];
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--path') {
        path = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(usage);
      }
      positionals.push(token);
    }
    if (positionals.length !== 1) {
      throw new Error(usage);
    }
    return apiPost(
      '/api/history/restore',
      {
        commitish: positionals[0],
        ...(path ? { path } : {})
      },
      configPath,
      parsed.options,
      parsed.json
    );
  }

  if (rest[1] === 'discard') {
    const usage =
      'Usage: moorline history discard [--path <tracked-path>] [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(2));
    let path: string | undefined;
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--path') {
        path = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      throw new Error(usage);
    }
    return apiPost('/api/history/discard', path ? { path } : {}, configPath, parsed.options, parsed.json);
  }

  return null;
}
