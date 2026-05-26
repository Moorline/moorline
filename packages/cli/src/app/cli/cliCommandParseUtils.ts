import type { CliCommand, ControlApiConnectionOptions } from './cliCommandTypes.js';

export function parseConfigPath(argv: string[]): { configPath?: string; rest: string[] } {
  const rest: string[] = [];
  let configPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing config path. Usage: moorline <command> [args] [--config <path>]');
      }
      configPath = next;
      index += 1;
      continue;
    }
    rest.push(token);
  }

  return {
    configPath,
    rest
  };
}

export function requireValue(value: string | undefined, message: string): string {
  if (!value || value.startsWith('--')) {
    throw new Error(message);
  }
  return value;
}

export function parseConnectionOptions(args: string[]): { options: ControlApiConnectionOptions; json: boolean; rest: string[] } {
  const options: ControlApiConnectionOptions = {};
  const rest: string[] = [];
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--url') {
      options.url = requireValue(args[index + 1], 'Missing URL value after --url.');
      index += 1;
      continue;
    }
    if (token === '--token') {
      options.token = requireValue(args[index + 1], 'Missing token value after --token.');
      index += 1;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    rest.push(token);
  }

  return {
    options,
    json,
    rest
  };
}

export function parseRuntimeMode(value: string, usage: string): 'full-access' | 'approval-required' {
  if (value === 'full-access' || value === 'approval-required') {
    return value;
  }
  throw new Error(`Invalid runtime mode "${value}". Usage: ${usage}`);
}

export function parseSurface(value: string, usage: string): 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle' {
  if (value === 'api-adapter' || value === 'transport' || value === 'provider' || value === 'plugin' || value === 'skill' || value === 'bundle') {
    return value;
  }
  throw new Error(`Invalid surface "${value}". Usage: ${usage}`);
}

export function parseRuntimeSurface(value: string, usage: string): 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' {
  if (value === 'api-adapter' || value === 'transport' || value === 'provider' || value === 'plugin' || value === 'skill') {
    return value;
  }
  throw new Error(`Invalid surface "${value}". Usage: ${usage}`);
}

export function parseSelectionSurface(value: string, usage: string): 'api-adapter' | 'transport' | 'provider' {
  if (value === 'api-adapter' || value === 'transport' || value === 'provider') {
    return value;
  }
  throw new Error(`Invalid surface "${value}". Usage: ${usage}`);
}

export function parseEnableSurface(value: string, usage: string): 'plugin' | 'skill' {
  if (value === 'plugin' || value === 'skill') {
    return value;
  }
  throw new Error(`Invalid surface "${value}". Usage: ${usage}`);
}

export function parseSessionTarget(tokens: string[], usage: string): { sessionId?: string; spaceId?: string } {
  let sessionId: string | undefined;
  let spaceId: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--session') {
      sessionId = requireValue(tokens[index + 1], `Missing session id. Usage: ${usage}`);
      index += 1;
      continue;
    }
    if (token === '--space') {
      spaceId = requireValue(tokens[index + 1], `Missing space id. Usage: ${usage}`);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}. Usage: ${usage}`);
  }
  if (!sessionId && !spaceId) {
    throw new Error(`Either --session <id> or --space <id> is required. Usage: ${usage}`);
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(spaceId ? { spaceId } : {})
  };
}

export function parseMissionTarget(tokens: string[], usage: string): { missionId?: string; spaceId?: string } {
  let missionId: string | undefined;
  let spaceId: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--mission') {
      missionId = requireValue(tokens[index + 1], `Missing mission id. Usage: ${usage}`);
      index += 1;
      continue;
    }
    if (token === '--space') {
      spaceId = requireValue(tokens[index + 1], `Missing space id. Usage: ${usage}`);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}. Usage: ${usage}`);
  }
  if (!missionId && !spaceId) {
    throw new Error(`Either --mission <id> or --space <id> is required. Usage: ${usage}`);
  }
  return {
    ...(missionId ? { missionId } : {}),
    ...(spaceId ? { spaceId } : {})
  };
}

export function parseOutOption(tokens: string[], usage: string): { outPath?: string } {
  let outPath: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--out') {
      outPath = requireValue(tokens[index + 1], `Missing output path. Usage: ${usage}`);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}. Usage: ${usage}`);
  }
  return outPath ? { outPath } : {};
}

export function apiGet(path: string, configPath: string | undefined, options: ControlApiConnectionOptions, json: boolean): CliCommand {
  return { kind: 'api-get', path, json, configPath, ...options };
}

export function apiPost(
  path: string,
  payload: Record<string, unknown>,
  configPath: string | undefined,
  options: ControlApiConnectionOptions,
  json: boolean
): CliCommand {
  return { kind: 'api-post', path, payload, json, configPath, ...options };
}

export function apiDownload(
  path: string,
  configPath: string | undefined,
  options: ControlApiConnectionOptions,
  json: boolean,
  outPath?: string
): CliCommand {
  return { kind: 'api-download', path, outPath, json, configPath, ...options };
}

export function apiUpload(
  path: string,
  filePath: string,
  contentType: string,
  configPath: string | undefined,
  options: ControlApiConnectionOptions,
  json: boolean
): CliCommand {
  return { kind: 'api-upload', path, filePath, contentType, json, configPath, ...options };
}
