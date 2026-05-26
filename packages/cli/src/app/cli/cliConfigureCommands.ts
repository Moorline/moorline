import {
  apiDownload,
  apiGet,
  apiPost,
  apiUpload,
  parseConnectionOptions,
  parseEnableSurface,
  parseOutOption,
  parseRuntimeSurface,
  parseSelectionSurface,
  parseSurface,
  requireValue
} from './cliCommandParseUtils.js';
import type { CliCommand } from './cliCommandTypes.js';

export function parseConfigureCommand(rest: string[], configPath: string | undefined): CliCommand | null {
  const command = rest[0];
  if (command !== 'configure') {
    return null;
  }

  if (rest[1] === 'state') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline configure state [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiGet('/api/state/configure', configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'apply') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline configure apply [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiPost('/api/packages/apply', {}, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'packages' && rest[2] === 'catalog') {
    const parsed = parseConnectionOptions(rest.slice(3));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline configure packages catalog [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiGet('/api/packages/catalog', configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'packages' && rest[2] === 'installed') {
    const parsed = parseConnectionOptions(rest.slice(3));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline configure packages installed [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiGet('/api/packages/installed', configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'package' && rest[2] === 'install') {
    const usage =
      'Usage: moorline configure package install --kind <api-adapter|transport|provider|plugin|skill|bundle> [--package <id>|--source <pathOrUrl>] [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(3));
    let kind: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle' | undefined;
    let packageId: string | undefined;
    let source: string | undefined;
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--kind' || token === '--surface') {
        kind = parseSurface(requireValue(parsed.rest[index + 1], usage), usage);
        index += 1;
        continue;
      }
      if (token === '--package') {
        packageId = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token === '--source') {
        source = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      throw new Error(usage);
    }
    if (!kind || (!packageId && !source) || (packageId && source)) {
      throw new Error(usage);
    }
    return apiPost(
      '/api/packages/install',
      {
        kind,
        ...(packageId ? { packageId } : {}),
        ...(source ? { source } : {})
      },
      configPath,
      parsed.options,
      parsed.json
    );
  }

  if (rest[1] === 'package' && rest[2] === 'remove') {
    const usage =
      'Usage: moorline configure package remove --kind <api-adapter|transport|provider|plugin|skill|bundle> --package <id> [--cascade] [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(3));
    let kind: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle' | undefined;
    let packageId: string | undefined;
    let cascade = false;
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--kind' || token === '--surface') {
        kind = parseSurface(requireValue(parsed.rest[index + 1], usage), usage);
        index += 1;
        continue;
      }
      if (token === '--package') {
        packageId = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token === '--cascade') {
        cascade = true;
        continue;
      }
      throw new Error(usage);
    }
    if (!kind || !packageId) {
      throw new Error(usage);
    }
    return apiPost('/api/packages/remove', { kind, packageId, ...(cascade ? { cascade: true } : {}) }, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'package' && (rest[2] === 'enable' || rest[2] === 'disable')) {
    const action = rest[2];
    const usage = `Usage: moorline configure package ${action} --surface <plugin|skill> --package <id> [--url <url>] [--token <token>] [--json] [--config <path>]`;
    const parsed = parseConnectionOptions(rest.slice(3));
    let surface: 'plugin' | 'skill' | undefined;
    let packageId: string | undefined;
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--surface') {
        surface = parseEnableSurface(requireValue(parsed.rest[index + 1], usage), usage);
        index += 1;
        continue;
      }
      if (token === '--package') {
        packageId = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      throw new Error(usage);
    }
    if (!surface || !packageId) {
      throw new Error(usage);
    }
    return apiPost(`/api/packages/${action}`, { surface, packageId }, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'package' && (rest[2] === 'activate' || rest[2] === 'deactivate')) {
    const action = rest[2];
    const usage = `Usage: moorline configure package ${action} --surface <api-adapter|transport|provider|plugin|skill> --package <id> [--url <url>] [--token <token>] [--json] [--config <path>]`;
    const parsed = parseConnectionOptions(rest.slice(3));
    let surface: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | undefined;
    let packageId: string | undefined;
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--surface') {
        surface = parseRuntimeSurface(requireValue(parsed.rest[index + 1], usage), usage);
        index += 1;
        continue;
      }
      if (token === '--package') {
        packageId = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      throw new Error(usage);
    }
    if (!surface || !packageId) {
      throw new Error(usage);
    }
    return apiPost(`/api/packages/${action}`, { surface, packageId }, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'package' && rest[2] === 'select') {
    const usage =
      'Usage: moorline configure package select --surface <api-adapter|transport|provider> (--package <id>|--none) [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(3));
    let surface: 'api-adapter' | 'transport' | 'provider' | undefined;
    let packageId: string | null | undefined;
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--surface') {
        surface = parseSelectionSurface(requireValue(parsed.rest[index + 1], usage), usage);
        index += 1;
        continue;
      }
      if (token === '--package') {
        packageId = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token === '--none') {
        packageId = null;
        continue;
      }
      throw new Error(usage);
    }
    if (!surface || packageId === undefined) {
      throw new Error(usage);
    }
    return apiPost('/api/packages/select', { surface, packageId }, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'package' && rest[2] === 'config') {
    const usage =
      'Usage: moorline configure package config --surface <api-adapter|transport|provider|plugin|skill> --package <id> --key <configKey> --value <stringValue> [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(3));
    let surface: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | undefined;
    let packageId: string | undefined;
    let key: string | undefined;
    let value: string | undefined;
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--surface') {
        surface = parseRuntimeSurface(requireValue(parsed.rest[index + 1], usage), usage);
        index += 1;
        continue;
      }
      if (token === '--package') {
        packageId = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token === '--key') {
        key = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token === '--value') {
        value = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      throw new Error(usage);
    }
    if (!surface || !packageId || !key || value === undefined) {
      throw new Error(usage);
    }
    return apiPost('/api/packages/config', { surface, packageId, values: { [key]: value } }, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'model') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length !== 1) {
      throw new Error('Usage: moorline configure model <model-id> [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiPost('/api/management/default-model', { model: parsed.rest[0] }, configPath, parsed.options, parsed.json);
  }

  if (rest[1] === 'setup-export') {
    const parsed = parseConnectionOptions(rest.slice(2));
    const output = parseOutOption(parsed.rest, 'Usage: moorline configure setup-export [--out <file>] [--url <url>] [--token <token>] [--json] [--config <path>]');
    return apiDownload('/api/management/setup-export', configPath, parsed.options, parsed.json, output.outPath);
  }

  if (rest[1] === 'backup') {
    const usage =
      'Usage: moorline configure backup [--include-workspaces] [--out <file>] [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(2));
    let includeWorkspaces = false;
    const restFlags: string[] = [];
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--include-workspaces') {
        includeWorkspaces = true;
        continue;
      }
      restFlags.push(token);
    }
    const output = parseOutOption(restFlags, usage);
    return apiDownload(
      `/api/management/backup?includeWorkspaces=${includeWorkspaces ? '1' : '0'}`,
      configPath,
      parsed.options,
      parsed.json,
      output.outPath
    );
  }

  if (rest[1] === 'import') {
    const usage =
      'Usage: moorline configure import <archive-path> [--force] [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(2));
    let force = false;
    let archivePath: string | undefined;
    for (const token of parsed.rest) {
      if (token === '--force') {
        force = true;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(usage);
      }
      if (!archivePath) {
        archivePath = token;
        continue;
      }
      throw new Error(usage);
    }
    if (!archivePath) {
      throw new Error(usage);
    }
    return apiUpload(`/api/management/import?force=${force ? '1' : '0'}`, archivePath, 'application/octet-stream', configPath, parsed.options, parsed.json);
  }

  return null;
}
