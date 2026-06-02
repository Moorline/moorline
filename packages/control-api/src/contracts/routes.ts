import type { PackageKind, PackageSurface } from '@moorline/contracts';
import { JsonBodyError } from '../errors.js';
import {
  optionalNullableId,
  optionalString,
  parseControlApiRuntimeMode,
  requireBoolean,
  requireString
} from '../validation.js';

export type ControlApiGetPath =
  | '/api/state'
  | '/api/main/status'
  | '/api/state/operations'
  | '/api/state/configure'
  | '/api/packages/search'
  | `/api/packages/search?${string}`
  | `/api/packages/info?${string}`
  | '/api/packages/installed'
  | '/api/history/status'
  | '/api/history/list'
  | `/api/history/show?${string}`
  | '/api/history/diff'
  | `/api/history/diff?${string}`
  | '/api/pending-requests/list'
  | `/api/pending-requests/inspect?${string}`
  | '/api/management/backup'
  | `/api/management/backup?${string}`;

export type ControlApiTextGetPath =
  | '/api/management/diagnostics-export'
  | '/api/management/setup-export';

export type ControlApiBinaryGetPath =
  | '/api/management/backup'
  | `/api/management/backup?${string}`;

export type ControlApiBinaryPostPath = '/api/management/import';

export type ControlApiPostPath =
  | '/api/main/start'
  | '/api/main/stop'
  | '/api/main/restart'
  | '/api/shutdown'
  | '/api/leases/create'
  | '/api/leases/heartbeat'
  | '/api/leases/release'
  | '/api/runtime/accepting'
  | '/api/runtime/reload'
  | '/api/provider/test'
  | '/api/provider/start'
  | '/api/provider/stop'
  | '/api/work/session/create'
  | '/api/work/session/direct'
  | '/api/work/session/archive'
  | '/api/work/session/delete'
  | '/api/packages/install'
  | '/api/packages/remove'
  | '/api/packages/enable'
  | '/api/packages/disable'
  | '/api/packages/activate'
  | '/api/packages/deactivate'
  | '/api/packages/select'
  | '/api/packages/config'
  | '/api/packages/apply'
  | '/api/history/snapshot'
  | '/api/history/restore'
  | '/api/history/discard'
  | '/api/pending-requests/resolve'
  | '/api/pending-requests/answer'
  | '/api/pending-requests/cancel'
  | '/api/management/default-model'
  | '/api/management/config-migration-warning/acknowledge';

type SessionTargetPayload = { sessionId?: string; transportResourceId?: string };
type TransportResourceSessionTargetPayload = { sessionId?: string; transportResourceId: string };
type RuntimeReloadMode = 'graceful' | 'force';

export type ControlApiPayloadForPath<Path extends ControlApiPostPath> =
  Path extends '/api/main/start' | '/api/main/stop' | '/api/main/restart' | '/api/shutdown' ? Record<string, never> :
  Path extends '/api/leases/create' ? { client?: string; policy?: 'detached' | 'stop_on_last_lease'; ttlMs?: number } :
  Path extends '/api/leases/heartbeat' ? { leaseId: string; ttlMs?: number } :
  Path extends '/api/leases/release' ? { leaseId: string } :
  Path extends '/api/runtime/accepting' ? { accepting: boolean } :
  Path extends '/api/runtime/reload' ? { mode: RuntimeReloadMode } :
  Path extends '/api/provider/test' ? { sendTurn?: boolean; prompt?: string } :
  Path extends '/api/provider/start' | '/api/provider/stop' ? { threadId?: string } :
  Path extends '/api/work/session/create' ? { requestedName: string; runtimeMode: ReturnType<typeof parseControlApiRuntimeMode>; initialInstruction?: string; objective?: string } :
  Path extends '/api/work/session/direct' ? SessionTargetPayload & { instruction: string; reason?: string } :
  Path extends '/api/work/session/archive' | '/api/work/session/delete' ? TransportResourceSessionTargetPayload :
  Path extends '/api/packages/install' ? { kind: PackageKind; surface?: PackageKind; packageId?: string; source?: string } :
  Path extends '/api/packages/remove' ? { kind: PackageKind; surface?: PackageKind; packageId: string; cascade?: boolean } :
  Path extends '/api/packages/enable' | '/api/packages/disable' ? { surface: 'plugin' | 'skill'; packageId: string } :
  Path extends '/api/packages/activate' | '/api/packages/deactivate' ? { surface: PackageSurface; packageId: string } :
  Path extends '/api/packages/select' ? { surface: 'api-adapter' | 'transport' | 'provider'; packageId: string | null } :
  Path extends '/api/packages/config' ? {
    surface: PackageSurface;
    packageId: string;
    values?: Record<string, string>;
    secretReplacements?: Array<{ key: string; value: string }>;
  } :
  Path extends '/api/packages/apply' ? Record<string, never> :
  Path extends '/api/history/snapshot' ? { label: string } :
  Path extends '/api/history/restore' ? { commitish: string; path?: string } :
  Path extends '/api/history/discard' ? { path?: string } :
  Path extends '/api/pending-requests/resolve' ? { requestId: string; decision: 'accept' | 'decline' | 'cancel' } :
  Path extends '/api/pending-requests/answer' ? { requestId: string; answers: Record<string, string | string[]> } :
  Path extends '/api/pending-requests/cancel' ? { requestId: string } :
  Path extends '/api/management/default-model' ? { model: string } :
  Path extends '/api/management/config-migration-warning/acknowledge' ? Record<string, never> :
  never;

export type ControlApiPostCommand = {
  [Path in ControlApiPostPath]: {
    kind: 'api';
    path: Path;
    payload: ControlApiPayloadForPath<Path>;
  }
}[ControlApiPostPath];

export type ControlApiPostRoute = ControlApiPostCommand;

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JsonBodyError(422, 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function parsePackageKind(value: unknown): PackageKind {
  if (value === 'api-adapter' || value === 'transport' || value === 'provider' || value === 'plugin' || value === 'skill' || value === 'bundle') {
    return value;
  }
  throw new JsonBodyError(422, 'kind must be one of: api-adapter, transport, provider, plugin, skill, bundle.');
}

function parsePackageSurface(value: unknown): PackageSurface {
  if (value === 'api-adapter' || value === 'transport' || value === 'provider' || value === 'plugin' || value === 'skill') {
    return value;
  }
  throw new JsonBodyError(422, 'surface must be one of: api-adapter, transport, provider, plugin, skill.');
}

function parsePackageSelectionSurface(value: unknown): 'api-adapter' | 'transport' | 'provider' {
  if (value === 'api-adapter' || value === 'transport' || value === 'provider') {
    return value;
  }
  throw new JsonBodyError(422, 'surface must be one of: api-adapter, transport, provider.');
}

function parsePackageEnablementSurface(value: unknown): 'plugin' | 'skill' {
  if (value === 'plugin' || value === 'skill') {
    return value;
  }
  throw new JsonBodyError(422, 'surface must be one of: plugin, skill.');
}

function parseStringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JsonBodyError(422, `${label} must be an object mapping config keys to strings.`);
  }
  const parsed: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) {
      throw new JsonBodyError(422, `${label} keys must be non-empty strings.`);
    }
    if (typeof entry !== 'string') {
      throw new JsonBodyError(422, `${label}.${key} must be a string.`);
    }
    parsed[key] = entry;
  }
  return parsed;
}

function parseSecretReplacements(value: unknown): Array<{ key: string; value: string }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new JsonBodyError(422, 'secretReplacements must be an array when provided.');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new JsonBodyError(422, `secretReplacements[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    return {
      key: requireString(record, 'key'),
      value: requireString(record, 'value', { trim: false, allowEmpty: true })
    };
  });
}

function parseSessionTarget(body: Record<string, unknown>): { sessionId?: string; transportResourceId?: string } {
  const sessionId = optionalString(body, 'sessionId');
  const transportResourceId = optionalString(body, 'transportResourceId');
  if (!sessionId && !transportResourceId) {
    throw new JsonBodyError(422, 'Either sessionId or transportResourceId is required.');
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(transportResourceId ? { transportResourceId } : {})
  };
}

function parseTransportResourceSessionTarget(body: Record<string, unknown>): TransportResourceSessionTargetPayload {
  const target = parseSessionTarget(body);
  if (!target.transportResourceId) {
    throw new JsonBodyError(422, 'transportResourceId is required.');
  }
  return {
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    transportResourceId: target.transportResourceId
  };
}

function parseRequestAnswers(value: unknown): Record<string, string | string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new JsonBodyError(422, 'answers must be an object mapping question ids to answer strings.');
  }
  const answers: Record<string, string | string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    const id = key.trim();
    if (!id) {
      throw new JsonBodyError(422, 'answers keys must be non-empty question ids.');
    }
    if (typeof entry === 'string') {
      const normalized = entry.trim();
      if (!normalized) {
        throw new JsonBodyError(422, `answers.${id} must be a non-empty string.`);
      }
      answers[id] = normalized;
      continue;
    }
    if (Array.isArray(entry) && entry.every((item) => typeof item === 'string' && item.trim().length > 0)) {
      answers[id] = entry.map((item) => item.trim());
      continue;
    }
    throw new JsonBodyError(422, `answers.${id} must be a string or non-empty string array.`);
  }
  if (Object.keys(answers).length === 0) {
    throw new JsonBodyError(422, 'answers must include at least one question response.');
  }
  return answers;
}

function requireRoutePath(pathname: string): ControlApiPostPath {
  switch (pathname) {
    case '/api/main/start':
    case '/api/main/stop':
    case '/api/main/restart':
    case '/api/shutdown':
    case '/api/leases/create':
    case '/api/leases/heartbeat':
    case '/api/leases/release':
    case '/api/runtime/accepting':
    case '/api/runtime/reload':
    case '/api/provider/test':
    case '/api/provider/start':
    case '/api/provider/stop':
    case '/api/work/session/create':
    case '/api/work/session/direct':
    case '/api/work/session/archive':
    case '/api/work/session/delete':
    case '/api/packages/install':
    case '/api/packages/remove':
    case '/api/packages/enable':
    case '/api/packages/disable':
    case '/api/packages/activate':
    case '/api/packages/deactivate':
    case '/api/packages/select':
    case '/api/packages/config':
    case '/api/packages/apply':
    case '/api/history/snapshot':
    case '/api/history/restore':
    case '/api/history/discard':
    case '/api/pending-requests/resolve':
    case '/api/pending-requests/answer':
    case '/api/pending-requests/cancel':
    case '/api/management/default-model':
    case '/api/management/config-migration-warning/acknowledge':
      return pathname;
    default:
      throw new JsonBodyError(404, 'Not found');
  }
}

export function parseControlApiPostRoute(pathname: string, rawBody: unknown): ControlApiPostRoute {
  const body = parseRecord(rawBody);
  const path = requireRoutePath(pathname);

  switch (path) {
    case '/api/main/start':
    case '/api/main/stop':
    case '/api/main/restart':
    case '/api/shutdown':
      return {
        kind: 'api',
        path,
        payload: {}
      };

    case '/api/leases/create': {
      const client = optionalString(body, 'client') ?? 'unknown-client';
      const policy = body.policy;
      if (policy !== undefined && policy !== 'detached' && policy !== 'stop_on_last_lease') {
        throw new JsonBodyError(422, 'policy must be "detached" or "stop_on_last_lease" when provided.');
      }
      const ttlMs = body.ttlMs;
      if (ttlMs !== undefined && (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs))) {
        throw new JsonBodyError(422, 'ttlMs must be a finite number when provided.');
      }
      return {
        kind: 'api',
        path,
        payload: {
          client,
          ...(policy ? { policy } : {}),
          ...(typeof ttlMs === 'number' ? { ttlMs } : {})
        }
      };
    }

    case '/api/leases/heartbeat': {
      const leaseId = requireString(body, 'leaseId');
      const ttlMs = body.ttlMs;
      if (ttlMs !== undefined && (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs))) {
        throw new JsonBodyError(422, 'ttlMs must be a finite number when provided.');
      }
      return {
        kind: 'api',
        path,
        payload: {
          leaseId,
          ...(typeof ttlMs === 'number' ? { ttlMs } : {})
        }
      };
    }

    case '/api/leases/release':
      return {
        kind: 'api',
        path,
        payload: {
          leaseId: requireString(body, 'leaseId')
        }
      };

    case '/api/runtime/accepting':
      return {
        kind: 'api',
        path,
        payload: {
          accepting: requireBoolean(body, 'accepting')
        }
      };

    case '/api/runtime/reload': {
      const mode = body.mode;
      if (mode !== undefined && mode !== 'graceful' && mode !== 'force') {
        throw new JsonBodyError(422, 'mode must be "graceful" or "force" when provided.');
      }
      return {
        kind: 'api',
        path,
        payload: {
          mode: (mode === 'force' ? 'force' : 'graceful') as RuntimeReloadMode
        }
      };
    }

    case '/api/provider/start':
      {
        const threadId = optionalString(body, 'threadId');
        return {
          kind: 'api',
          path,
          payload: {
            ...(threadId ? { threadId } : {})
          }
        };
      }

    case '/api/provider/test':
      {
        const prompt = optionalString(body, 'prompt');
        const sendTurn = body.sendTurn;
        if (sendTurn !== undefined && typeof sendTurn !== 'boolean') {
          throw new JsonBodyError(422, 'sendTurn must be a boolean when provided.');
        }
        return {
          kind: 'api',
          path,
          payload: {
            ...(sendTurn === true ? { sendTurn: true } : {}),
            ...(prompt ? { prompt } : {})
          }
        };
      }

    case '/api/provider/stop':
      {
        const threadId = optionalString(body, 'threadId');
        return {
          kind: 'api',
          path,
          payload: {
            ...(threadId ? { threadId } : {})
          }
        };
      }

    case '/api/work/session/create': {
      const initialInstruction = optionalString(body, 'initialInstruction');
      const objective = optionalString(body, 'objective');
      return {
        kind: 'api',
        path,
        payload: {
          requestedName: requireString(body, 'requestedName'),
          runtimeMode: parseControlApiRuntimeMode(body.runtimeMode, 'runtimeMode'),
          ...(initialInstruction ? { initialInstruction } : {}),
          ...(objective ? { objective } : {})
        }
      };
    }

    case '/api/work/session/direct': {
      const reason = optionalString(body, 'reason');
      return {
        kind: 'api',
        path,
        payload: {
          ...parseSessionTarget(body),
          instruction: requireString(body, 'instruction'),
          ...(reason ? { reason } : {})
        }
      };
    }

    case '/api/work/session/archive':
      return {
        kind: 'api',
        path,
        payload: parseTransportResourceSessionTarget(body)
      };

    case '/api/work/session/delete':
      return {
        kind: 'api',
        path,
        payload: parseTransportResourceSessionTarget(body)
      };

    case '/api/packages/install': {
      const packageId = optionalString(body, 'packageId');
      const source = optionalString(body, 'source');
      return {
        kind: 'api',
        path,
        payload: {
          kind: parsePackageKind(body.kind ?? body.surface),
          ...(packageId ? { packageId } : {}),
          ...(source ? { source } : {})
        }
      };
    }

    case '/api/packages/remove': {
      const cascade = body.cascade;
      if (cascade !== undefined && typeof cascade !== 'boolean') {
        throw new JsonBodyError(422, 'cascade must be a boolean when provided.');
      }
      return {
        kind: 'api',
        path,
        payload: {
          kind: parsePackageKind(body.kind ?? body.surface),
          packageId: requireString(body, 'packageId'),
          ...(cascade === true ? { cascade: true } : {})
        }
      };
    }

    case '/api/packages/enable':
      return {
        kind: 'api',
        path,
        payload: {
          surface: parsePackageEnablementSurface(body.surface),
          packageId: requireString(body, 'packageId')
        }
      };

    case '/api/packages/disable':
      return {
        kind: 'api',
        path,
        payload: {
          surface: parsePackageEnablementSurface(body.surface),
          packageId: requireString(body, 'packageId')
        }
      };

    case '/api/packages/activate':
    case '/api/packages/deactivate':
      return {
        kind: 'api',
        path,
        payload: {
          surface: parsePackageSurface(body.surface),
          packageId: requireString(body, 'packageId')
        }
      };

    case '/api/packages/select': {
      const packageId = optionalNullableId(body, 'packageId');
      if (packageId === undefined) {
        throw new JsonBodyError(422, 'packageId must be provided as a string or null.');
      }
      return {
        kind: 'api',
        path,
        payload: {
          surface: parsePackageSelectionSurface(body.surface),
          packageId
        }
      };
    }

    case '/api/packages/config': {
      const values = parseStringRecord(body.values, 'values');
      if (Object.keys(values).length === 0 && body.secretReplacements === undefined) {
        throw new JsonBodyError(422, 'At least one config value or secret replacement is required.');
      }
      return {
        kind: 'api',
        path,
        payload: {
          surface: parsePackageSurface(body.surface),
          packageId: requireString(body, 'packageId'),
          values,
          secretReplacements: parseSecretReplacements(body.secretReplacements)
        }
      };
    }

    case '/api/packages/apply':
      return {
        kind: 'api',
        path,
        payload: {}
      };

    case '/api/history/snapshot':
      return {
        kind: 'api',
        path,
        payload: {
          label: requireString(body, 'label')
        }
      };

    case '/api/history/restore': {
      const historyPath = optionalString(body, 'path');
      return {
        kind: 'api',
        path,
        payload: {
          commitish: requireString(body, 'commitish'),
          ...(historyPath ? { path: historyPath } : {})
        }
      };
    }

    case '/api/history/discard': {
      const historyPath = optionalString(body, 'path');
      return {
        kind: 'api',
        path,
        payload: {
          ...(historyPath ? { path: historyPath } : {})
        }
      };
    }

    case '/api/pending-requests/resolve': {
      const decision = body.decision;
      if (decision !== 'accept' && decision !== 'decline' && decision !== 'cancel') {
        throw new JsonBodyError(422, 'decision must be one of: accept, decline, cancel.');
      }
      return {
        kind: 'api',
        path,
        payload: {
          requestId: requireString(body, 'requestId'),
          decision
        }
      };
    }

    case '/api/pending-requests/answer':
      return {
        kind: 'api',
        path,
        payload: {
          requestId: requireString(body, 'requestId'),
          answers: parseRequestAnswers(body.answers)
        }
      };

    case '/api/pending-requests/cancel':
      return {
        kind: 'api',
        path,
        payload: {
          requestId: requireString(body, 'requestId')
        }
      };

    case '/api/management/default-model':
      return {
        kind: 'api',
        path,
        payload: {
          model: requireString(body, 'model')
        }
      };

    case '/api/management/config-migration-warning/acknowledge':
      return {
        kind: 'api',
        path,
        payload: {}
      };
  }
}

function requireQueryString(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value || value.trim().length === 0) {
    throw new JsonBodyError(422, `${key} query parameter is required.`);
  }
  return value.trim();
}

export function parseHistoryShowQuery(url: URL): { commitish: string } {
  return {
    commitish: requireQueryString(url, 'commitish')
  };
}

export function parseHistoryDiffQuery(url: URL): { from?: string; to?: string; path?: string } {
  const from = url.searchParams.get('from')?.trim();
  const to = url.searchParams.get('to')?.trim();
  const path = url.searchParams.get('path')?.trim();
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(path ? { path } : {})
  };
}

export function parsePendingInspectQuery(url: URL): { requestId: string } {
  return {
    requestId: requireQueryString(url, 'requestId')
  };
}
