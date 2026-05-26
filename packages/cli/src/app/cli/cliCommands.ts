import {
  apiGet,
  apiPost,
  parseConfigPath,
  parseConnectionOptions,
  parseMissionTarget,
  parseRuntimeMode,
  parseSurface,
  parseSessionTarget,
  requireValue
} from './cliCommandParseUtils.js';
import { parseConfigureCommand } from './cliConfigureCommands.js';
import { parseHistoryCommand } from './cliHistoryCommands.js';
import { parseRequestsCommand } from './cliRequestCommands.js';
export type { CliCommand, ControlApiConnectionOptions } from './cliCommandTypes.js';
import type { CliCommand } from './cliCommandTypes.js';

export function parseCliArgs(argv: string[]): CliCommand {
  const { configPath, rest } = parseConfigPath(argv);
  const command = rest[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { kind: 'help' };
  }

  if (command === 'init') {
    if (rest.length !== 1) {
      throw new Error('Usage: moorline init [--config <path>]');
    }
    return { kind: 'init', configPath };
  }

  if (command === 'run') {
    if (rest.length !== 1) {
      throw new Error('Usage: moorline run [--config <path>]');
    }
    return { kind: 'api-run-foreground', configPath };
  }

  if (command === 'api' && rest[1] === 'start') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline api start [--url <url>] [--token <token>] [--config <path>]');
    }
    return { kind: 'api-start', configPath, ...parsed.options };
  }

  if (command === 'api' && rest[1] === 'stop') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline api stop [--url <url>] [--token <token>] [--config <path>]');
    }
    return { kind: 'api-stop', configPath, ...parsed.options };
  }

  if (command === 'api' && rest[1] === 'status') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline api status [--url <url>] [--token <token>] [--config <path>]');
    }
    return { kind: 'api-status', configPath, ...parsed.options };
  }

  if (command === 'main' && rest[1] === 'status') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline main status [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiGet('/api/main/status', configPath, parsed.options, parsed.json);
  }

  if (command === 'main' && rest[1] === 'start') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline main start [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiPost('/api/main/start', {}, configPath, parsed.options, parsed.json);
  }

  if (command === 'main' && rest[1] === 'stop') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline main stop [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiPost('/api/main/stop', {}, configPath, parsed.options, parsed.json);
  }

  if (command === 'main' && rest[1] === 'restart') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline main restart [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiPost('/api/main/restart', {}, configPath, parsed.options, parsed.json);
  }

  if (command === 'package') {
    const subcommand = rest[1];
    if (subcommand === 'search') {
      const usage = 'Usage: moorline package search [query] [--kind <api-adapter|transport|provider|plugin|skill|bundle>] [--url <url>] [--token <token>] [--json] [--config <path>]';
      const parsed = parseConnectionOptions(rest.slice(2));
      let query: string | undefined;
      let packageKind: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle' | undefined;
      for (let index = 0; index < parsed.rest.length; index += 1) {
        const token = parsed.rest[index];
        if (token === '--kind' || token === '--surface') {
          packageKind = parseSurface(requireValue(parsed.rest[index + 1], usage), usage);
          index += 1;
          continue;
        }
        if (token.startsWith('--')) {
          throw new Error(usage);
        }
        if (query !== undefined) {
          throw new Error(usage);
        }
        query = token;
      }
      return { kind: 'package-search', query, packageKind, json: parsed.json, configPath, ...parsed.options };
    }
    if (subcommand === 'info') {
      const usage = 'Usage: moorline package info <package-id> [--kind <api-adapter|transport|provider|plugin|skill|bundle>] [--url <url>] [--token <token>] [--json] [--config <path>]';
      const parsed = parseConnectionOptions(rest.slice(2));
      const packageId = parsed.rest[0];
      if (!packageId || packageId.startsWith('--')) {
        throw new Error(usage);
      }
      let packageKind: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle' | undefined;
      for (let index = 1; index < parsed.rest.length; index += 1) {
        const token = parsed.rest[index];
        if (token === '--kind' || token === '--surface') {
          packageKind = parseSurface(requireValue(parsed.rest[index + 1], usage), usage);
          index += 1;
          continue;
        }
        throw new Error(usage);
      }
      return { kind: 'package-info', packageId, packageKind, json: parsed.json, configPath, ...parsed.options };
    }
    if (subcommand === 'install') {
      const usage = 'Usage: moorline package install <package-id> --kind <api-adapter|transport|provider|plugin|skill|bundle> [--url <url>] [--token <token>] [--json] [--config <path>]';
      const parsed = parseConnectionOptions(rest.slice(2));
      const packageId = parsed.rest[0];
      if (!packageId || packageId.startsWith('--')) {
        throw new Error(usage);
      }
      let packageKind: 'api-adapter' | 'transport' | 'provider' | 'plugin' | 'skill' | 'bundle' | undefined;
      for (let index = 1; index < parsed.rest.length; index += 1) {
        const token = parsed.rest[index];
        if (token === '--kind' || token === '--surface') {
          packageKind = parseSurface(requireValue(parsed.rest[index + 1], usage), usage);
          index += 1;
          continue;
        }
        throw new Error(usage);
      }
      if (!packageKind) {
        throw new Error(usage);
      }
      return { kind: 'package-install', packageId, packageKind, json: parsed.json, configPath, ...parsed.options };
    }
  }

  if (command === 'worker-run') {
    if (rest.length !== 1) {
      throw new Error('Usage: moorline worker-run [--config <path>]');
    }
    return { kind: 'worker-run', configPath };
  }

  if (command === 'api-run-foreground') {
    if (rest.length !== 1) {
      throw new Error('Usage: moorline api-run-foreground [--config <path>]');
    }
    return { kind: 'api-run-foreground', configPath };
  }

  if (command === 'interactive') {
    const parsed = parseConnectionOptions(rest.slice(1));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline interactive [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return { kind: 'interactive', configPath, ...parsed.options };
  }

  if (command === 'api' && rest[1] === 'diagnostics-export') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline api diagnostics-export [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiGet('/api/management/diagnostics-export', configPath, parsed.options, parsed.json);
  }

  if (command === 'ops' && rest[1] === 'state') {
    const parsed = parseConnectionOptions(rest.slice(2));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline ops state [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiGet('/api/state/operations', configPath, parsed.options, parsed.json);
  }

  if (command === 'ops' && rest[1] === 'accepting') {
    const mode = rest[2];
    if (mode !== 'on' && mode !== 'off') {
      throw new Error('Usage: moorline ops accepting <on|off> [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    const parsed = parseConnectionOptions(rest.slice(3));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline ops accepting <on|off> [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiPost('/api/runtime/accepting', { accepting: mode === 'on' }, configPath, parsed.options, parsed.json);
  }

  if (command === 'ops' && rest[1] === 'reload') {
    const mode = rest[2];
    if (mode !== 'graceful' && mode !== 'force') {
      throw new Error('Usage: moorline ops reload <graceful|force> [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    const parsed = parseConnectionOptions(rest.slice(3));
    if (parsed.rest.length > 0) {
      throw new Error('Usage: moorline ops reload <graceful|force> [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    return apiPost('/api/runtime/reload', { mode }, configPath, parsed.options, parsed.json);
  }

  if (command === 'ops' && rest[1] === 'provider') {
    const action = rest[2];
    if (action !== 'start' && action !== 'stop' && action !== 'test') {
      throw new Error('Usage: moorline ops provider <start|stop|test> [--thread <id>] [--turn] [--prompt <text>] [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    const parsed = parseConnectionOptions(rest.slice(3));
    let threadId: string | undefined;
    let sendTurn = false;
    let prompt: string | undefined;
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--thread') {
        if (action === 'test') {
          throw new Error('Usage: moorline ops provider test [--turn] [--prompt <text>] [--url <url>] [--token <token>] [--json] [--config <path>]');
        }
        threadId = requireValue(parsed.rest[index + 1], 'Missing provider thread id after --thread.');
        index += 1;
        continue;
      }
      if (token === '--turn') {
        sendTurn = true;
        continue;
      }
      if (token === '--prompt') {
        prompt = requireValue(parsed.rest[index + 1], 'Missing provider test prompt after --prompt.');
        index += 1;
        continue;
      }
      throw new Error('Usage: moorline ops provider <start|stop|test> [--thread <id>] [--turn] [--prompt <text>] [--url <url>] [--token <token>] [--json] [--config <path>]');
    }
    if (action === 'test') {
      return apiPost('/api/provider/test', { ...(sendTurn ? { sendTurn: true } : {}), ...(prompt ? { prompt } : {}) }, configPath, parsed.options, parsed.json);
    }
    const path = action === 'start' ? '/api/provider/start' : '/api/provider/stop';
    return apiPost(path, threadId ? { threadId } : {}, configPath, parsed.options, parsed.json);
  }

  if (command === 'ops' && rest[1] === 'session' && rest[2] === 'create') {
    const usage =
      'Usage: moorline ops session create <name> [--mode <full-access|approval-required>] [--objective <text>] [--instruction <text>] [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(3));
    let requestedName: string | undefined;
    let runtimeMode: 'full-access' | 'approval-required' = 'full-access';
    let objective: string | undefined;
    let initialInstruction: string | undefined;
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--mode') {
        runtimeMode = parseRuntimeMode(requireValue(parsed.rest[index + 1], usage), usage);
        index += 1;
        continue;
      }
      if (token === '--objective') {
        objective = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token === '--instruction') {
        initialInstruction = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token.startsWith('--')) {
        throw new Error(usage);
      }
      if (!requestedName) {
        requestedName = token;
        continue;
      }
      throw new Error(usage);
    }
    if (!requestedName) {
      throw new Error(usage);
    }
    return apiPost(
      '/api/work/session/create',
      {
        requestedName,
        runtimeMode,
        ...(objective ? { objective } : {}),
        ...(initialInstruction ? { initialInstruction } : {})
      },
      configPath,
      parsed.options,
      parsed.json
    );
  }

  if (command === 'ops' && rest[1] === 'session' && rest[2] === 'direct') {
    const usage =
      'Usage: moorline ops session direct (--session <id>|--space <id>) --instruction <text> [--reason <text>] [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(3));
    let instruction: string | undefined;
    let reason: string | undefined;
    const targetTokens: string[] = [];
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--instruction') {
        instruction = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token === '--reason') {
        reason = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      targetTokens.push(token);
    }
    if (!instruction) {
      throw new Error(usage);
    }
    return apiPost(
      '/api/work/session/direct',
      {
        ...parseSessionTarget(targetTokens, usage),
        instruction,
        ...(reason ? { reason } : {})
      },
      configPath,
      parsed.options,
      parsed.json
    );
  }

  if (command === 'ops' && rest[1] === 'session' && (rest[2] === 'archive' || rest[2] === 'delete')) {
    const action = rest[2];
    const usage = `Usage: moorline ops session ${action} (--session <id>|--space <id>) [--url <url>] [--token <token>] [--json] [--config <path>]`;
    const parsed = parseConnectionOptions(rest.slice(3));
    const path = action === 'archive' ? '/api/work/session/archive' : '/api/work/session/delete';
    return apiPost(path, parseSessionTarget(parsed.rest, usage), configPath, parsed.options, parsed.json);
  }

  if (command === 'ops' && rest[1] === 'mission' && rest[2] === 'create') {
    const usage =
      'Usage: moorline ops mission create --title <text> --goal <text> --schedule <cron> [--mode <full-access|approval-required>] [--start-time <iso>] [--url <url>] [--token <token>] [--json] [--config <path>]';
    const parsed = parseConnectionOptions(rest.slice(3));
    let title: string | undefined;
    let goal: string | undefined;
    let schedule: string | undefined;
    let runtimeMode: 'full-access' | 'approval-required' = 'full-access';
    let startTime: string | undefined;
    for (let index = 0; index < parsed.rest.length; index += 1) {
      const token = parsed.rest[index];
      if (token === '--title') {
        title = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token === '--goal') {
        goal = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token === '--schedule') {
        schedule = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      if (token === '--mode') {
        runtimeMode = parseRuntimeMode(requireValue(parsed.rest[index + 1], usage), usage);
        index += 1;
        continue;
      }
      if (token === '--start-time') {
        startTime = requireValue(parsed.rest[index + 1], usage);
        index += 1;
        continue;
      }
      throw new Error(usage);
    }
    if (!title || !goal || !schedule) {
      throw new Error(usage);
    }
    return apiPost(
      '/api/work/mission/create',
      {
        title,
        goal,
        schedule,
        runtimeMode,
        ...(startTime ? { startTime } : {})
      },
      configPath,
      parsed.options,
      parsed.json
    );
  }

  if (command === 'ops' && rest[1] === 'mission' && ['pause', 'resume', 'stop', 'run', 'archive', 'delete'].includes(rest[2] ?? '')) {
    const action = rest[2] as 'pause' | 'resume' | 'stop' | 'run' | 'archive' | 'delete';
    const usage = `Usage: moorline ops mission ${action} (--mission <id>|--space <id>) [--url <url>] [--token <token>] [--json] [--config <path>]`;
    const parsed = parseConnectionOptions(rest.slice(3));
    const routeByAction: Record<typeof action, string> = {
      pause: '/api/work/mission/pause',
      resume: '/api/work/mission/resume',
      stop: '/api/work/mission/stop',
      run: '/api/work/mission/run',
      archive: '/api/work/mission/archive',
      delete: '/api/work/mission/delete'
    };
    return apiPost(routeByAction[action], parseMissionTarget(parsed.rest, usage), configPath, parsed.options, parsed.json);
  }

  const configureCommand = parseConfigureCommand(rest, configPath);
  if (configureCommand) {
    return configureCommand;
  }

  const historyCommand = parseHistoryCommand(rest, configPath);
  if (historyCommand) {
    return historyCommand;
  }

  const requestsCommand = parseRequestsCommand(rest, configPath);
  if (requestsCommand) {
    return requestsCommand;
  }

  throw new Error(`Unknown command: ${command}. Run "moorline help" for command usage.`);
}
