import { createHash, randomUUID } from 'node:crypto';
import type { RuntimeModeName } from '../../../types/runtime.js';
import type { SessionOwnerLink } from '../../../types/plugin.js';
import type { RuntimeReloadMode } from '../supervision/runtimeControl.js';
import type {
  RuntimeOrchestrationRequestRow,
  RuntimeOrchestrationRequestType,
  SqliteSessionStore
} from '../../system/state/sqliteSessionStore.js';

export interface CreateSessionOrchestrationPayload {
  requestedName: string;
  runtimeMode: RuntimeModeName;
  initialInstruction?: string;
  objective?: string;
  owner?: SessionOwnerLink;
  tags?: string[];
}

export interface DirectSessionOrchestrationPayload {
  sessionId?: string;
  spaceId?: string;
  instruction: string;
  reason?: string;
}

export interface ArchiveSessionOrchestrationPayload {
  sessionId?: string;
  spaceId: string;
}

export interface DeleteSessionOrchestrationPayload {
  sessionId?: string;
  spaceId: string;
}

export interface PostMessageOrchestrationPayload {
  spaceId: string;
  content?: string;
  files?: Array<{
    path: string;
    name?: string;
    description?: string;
  }>;
}

export interface ResolvePendingRequestOrchestrationPayload {
  requestId: string;
  decision: 'accept' | 'decline' | 'cancel';
}

export interface AnswerPendingRequestOrchestrationPayload {
  requestId: string;
  answers: Record<string, string | string[]>;
}

export interface RuntimeSetAcceptingOrchestrationPayload {
  accepting: boolean;
}

export interface RuntimeReloadOrchestrationPayload {
  mode: RuntimeReloadMode;
}

export interface ProviderSessionControlOrchestrationPayload {
  threadId?: string;
}

export interface ProviderTestOrchestrationPayload {
  sendTurn?: boolean;
  prompt?: string;
}

type RuntimeOrchestrationPayload =
  | CreateSessionOrchestrationPayload
  | DirectSessionOrchestrationPayload
  | ArchiveSessionOrchestrationPayload
  | DeleteSessionOrchestrationPayload
  | PostMessageOrchestrationPayload
  | RuntimeSetAcceptingOrchestrationPayload
  | RuntimeReloadOrchestrationPayload
  | ProviderTestOrchestrationPayload
  | ProviderSessionControlOrchestrationPayload
  | ResolvePendingRequestOrchestrationPayload
  | AnswerPendingRequestOrchestrationPayload;

type RuntimeOrchestrationPayloadByType = {
  create_session: CreateSessionOrchestrationPayload;
  direct_session: DirectSessionOrchestrationPayload;
  archive_session: ArchiveSessionOrchestrationPayload;
  delete_session: DeleteSessionOrchestrationPayload;
  post_message: PostMessageOrchestrationPayload;
  runtime_set_accepting: RuntimeSetAcceptingOrchestrationPayload;
  runtime_reload: RuntimeReloadOrchestrationPayload;
  provider_test: ProviderTestOrchestrationPayload;
  provider_stop: ProviderSessionControlOrchestrationPayload;
  provider_start: ProviderSessionControlOrchestrationPayload;
  resolve_pending_request: ResolvePendingRequestOrchestrationPayload;
  answer_pending_request: AnswerPendingRequestOrchestrationPayload;
};

interface ValidationFailure {
  code: string;
  message: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseRuntimeMode(value: unknown): RuntimeModeName | null {
  return value === 'full-access' || value === 'approval-required' ? value : null;
}

function validatePayloadByType(
  type: RuntimeOrchestrationRequestType,
  payload: unknown
): RuntimeOrchestrationPayloadByType[RuntimeOrchestrationRequestType] | ValidationFailure {
  const record = asObject(payload);
  if (!record) {
    return {
      code: 'ORCH_PAYLOAD_OBJECT_REQUIRED',
      message: `orchestration payload for ${type} must be an object.`
    };
  }

  switch (type) {
    case 'create_session': {
      const requestedName = readTrimmedString(record, 'requestedName');
      const runtimeMode = parseRuntimeMode(record.runtimeMode);
      if (!requestedName) {
        return {
          code: 'ORCH_CREATE_SESSION_NAME_REQUIRED',
          message: 'create_session payload requires non-empty requestedName.'
        };
      }
      if (!runtimeMode) {
        return {
          code: 'ORCH_CREATE_SESSION_MODE_INVALID',
          message: 'create_session payload runtimeMode must be full-access or approval-required.'
        };
      }
      const initialInstruction = readOptionalTrimmedString(record, 'initialInstruction');
      const objective = readOptionalTrimmedString(record, 'objective');
      const ownerRecord = record.owner === undefined ? null : asObject(record.owner);
      let owner: SessionOwnerLink | undefined;
      if (ownerRecord) {
        const kind = readTrimmedString(ownerRecord, 'kind');
        const id = readTrimmedString(ownerRecord, 'id');
        if (!kind || !id) {
          return {
            code: 'ORCH_CREATE_SESSION_OWNER_INVALID',
            message: 'create_session payload owner must include non-empty kind and id.'
          };
        }
        const label = readOptionalTrimmedString(ownerRecord, 'label');
        owner = {
          kind,
          id,
          ...(label ? { label } : {})
        };
      } else if (record.owner !== undefined) {
        return {
          code: 'ORCH_CREATE_SESSION_OWNER_OBJECT_REQUIRED',
          message: 'create_session payload owner must be an object when provided.'
        };
      }
      const tagsRaw = record.tags;
      const tags =
        tagsRaw === undefined
          ? undefined
          : Array.isArray(tagsRaw)
            ? tagsRaw
                .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
                .filter((entry) => entry.length > 0)
            : null;
      if (tags === null) {
        return {
          code: 'ORCH_CREATE_SESSION_TAGS_INVALID',
          message: 'create_session payload tags must be an array of non-empty strings when provided.'
        };
      }
      return {
        requestedName,
        runtimeMode,
        ...(initialInstruction ? { initialInstruction } : {}),
        ...(objective ? { objective } : {}),
        ...(owner ? { owner } : {}),
        ...(tags ? { tags } : {})
      };
    }
    case 'direct_session': {
      const instruction = readTrimmedString(record, 'instruction');
      if (!instruction) {
        return {
          code: 'ORCH_DIRECT_SESSION_INSTRUCTION_REQUIRED',
          message: 'direct_session payload requires non-empty instruction.'
        };
      }
      const sessionId = readOptionalTrimmedString(record, 'sessionId');
      const spaceId = readOptionalTrimmedString(record, 'spaceId');
      if (!sessionId && !spaceId) {
        return {
          code: 'ORCH_DIRECT_SESSION_TARGET_REQUIRED',
          message: 'direct_session payload requires sessionId or spaceId.'
        };
      }
      const reason = readOptionalTrimmedString(record, 'reason');
      return {
        instruction,
        ...(sessionId ? { sessionId } : {}),
        ...(spaceId ? { spaceId } : {}),
        ...(reason ? { reason } : {})
      };
    }
    case 'archive_session':
    case 'delete_session': {
      const spaceId = readTrimmedString(record, 'spaceId');
      if (!spaceId) {
        return {
          code: 'ORCH_SESSION_SPACE_REQUIRED',
          message: `${type} payload requires non-empty spaceId.`
        };
      }
      const sessionId = readOptionalTrimmedString(record, 'sessionId');
      return {
        spaceId,
        ...(sessionId ? { sessionId } : {})
      };
    }
    case 'post_message': {
      const spaceId = readTrimmedString(record, 'spaceId');
      if (!spaceId) {
        return {
          code: 'ORCH_POST_MESSAGE_SPACE_REQUIRED',
          message: 'post_message payload requires non-empty spaceId.'
        };
      }
      const content = readOptionalTrimmedString(record, 'content');
      const filesRaw = record.files;
      const files =
        filesRaw === undefined
          ? undefined
          : Array.isArray(filesRaw)
            ? filesRaw
                .map((entry) => {
                  const file = asObject(entry);
                  if (!file) {
                    return null;
                  }
                  const path = readTrimmedString(file, 'path');
                  if (!path) {
                    return null;
                  }
                  const name = readOptionalTrimmedString(file, 'name');
                  const description = readOptionalTrimmedString(file, 'description');
                  return {
                    path,
                    ...(name ? { name } : {}),
                    ...(description ? { description } : {})
                  };
                })
                .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
            : null;
      const invalidFiles =
        filesRaw !== undefined && (!Array.isArray(filesRaw) || !files || files.length !== filesRaw.length);
      if (invalidFiles) {
        return {
          code: 'ORCH_POST_MESSAGE_FILES_INVALID',
          message: 'post_message payload files must be an array of objects with non-empty path.'
        };
      }
      if (!content && (!files || files.length === 0)) {
        return {
          code: 'ORCH_POST_MESSAGE_CONTENT_REQUIRED',
          message: 'post_message payload requires content or at least one file attachment.'
        };
      }
      return {
        spaceId,
        ...(content ? { content } : {}),
        ...(files ? { files } : {})
      };
    }
    case 'runtime_set_accepting': {
      if (typeof record.accepting !== 'boolean') {
        return {
          code: 'ORCH_RUNTIME_ACCEPTING_INVALID',
          message: 'runtime_set_accepting payload accepting must be a boolean.'
        };
      }
      return {
        accepting: record.accepting
      };
    }
    case 'runtime_reload': {
      const mode = readTrimmedString(record, 'mode');
      if (mode !== 'graceful' && mode !== 'force') {
        return {
          code: 'ORCH_RUNTIME_RELOAD_MODE_INVALID',
          message: 'runtime_reload payload mode must be graceful or force.'
        };
      }
      return {
        mode
      };
    }
    case 'provider_test': {
      if (record.sendTurn !== undefined && typeof record.sendTurn !== 'boolean') {
        return {
          code: 'ORCH_PROVIDER_TEST_SEND_TURN_INVALID',
          message: 'provider_test payload sendTurn must be a boolean when provided.'
        };
      }
      const prompt = readOptionalTrimmedString(record, 'prompt');
      return {
        ...(record.sendTurn === true ? { sendTurn: true } : {}),
        ...(prompt ? { prompt } : {})
      };
    }
    case 'provider_stop':
    case 'provider_start': {
      const threadId = readOptionalTrimmedString(record, 'threadId');
      return {
        ...(threadId ? { threadId } : {})
      };
    }
    case 'resolve_pending_request': {
      const requestId = readTrimmedString(record, 'requestId');
      const decision = record.decision;
      if (!requestId) {
        return {
          code: 'ORCH_PENDING_REQUEST_ID_REQUIRED',
          message: 'resolve_pending_request payload requires non-empty requestId.'
        };
      }
      if (decision !== 'accept' && decision !== 'decline' && decision !== 'cancel') {
        return {
          code: 'ORCH_PENDING_REQUEST_DECISION_INVALID',
          message: 'resolve_pending_request payload decision must be accept, decline, or cancel.'
        };
      }
      return {
        requestId,
        decision
      };
    }
    case 'answer_pending_request': {
      const requestId = readTrimmedString(record, 'requestId');
      const answers = asObject(record.answers);
      if (!requestId) {
        return {
          code: 'ORCH_PENDING_REQUEST_ID_REQUIRED',
          message: 'answer_pending_request payload requires non-empty requestId.'
        };
      }
      if (!answers) {
        return {
          code: 'ORCH_PENDING_REQUEST_ANSWERS_OBJECT_REQUIRED',
          message: 'answer_pending_request payload answers must be an object.'
        };
      }
      const normalizedEntries: Array<[string, string | string[]]> = [];
      for (const [rawKey, rawValue] of Object.entries(answers)) {
        const key = rawKey.trim();
        if (!key) {
          return {
            code: 'ORCH_PENDING_REQUEST_ANSWER_KEY_INVALID',
            message: 'answer_pending_request payload answers keys must be non-empty strings.'
          };
        }
        if (typeof rawValue === 'string') {
          const trimmed = rawValue.trim();
          if (!trimmed) {
            return {
              code: 'ORCH_PENDING_REQUEST_ANSWER_VALUE_INVALID',
              message: `answer_pending_request payload answers.${key} must be a non-empty string or string array.`
            };
          }
          normalizedEntries.push([key, trimmed]);
          continue;
        }
        if (Array.isArray(rawValue)) {
          const values = rawValue
            .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
            .filter((entry) => entry.length > 0);
          if (values.length === 0 || values.length !== rawValue.length) {
            return {
              code: 'ORCH_PENDING_REQUEST_ANSWER_VALUE_INVALID',
              message: `answer_pending_request payload answers.${key} must be a non-empty string or string array.`
            };
          }
          normalizedEntries.push([key, values]);
          continue;
        }
        return {
          code: 'ORCH_PENDING_REQUEST_ANSWER_VALUE_INVALID',
          message: `answer_pending_request payload answers.${key} must be a non-empty string or string array.`
        };
      }
      if (normalizedEntries.length === 0) {
        return {
          code: 'ORCH_PENDING_REQUEST_ANSWERS_EMPTY',
          message: 'answer_pending_request payload answers must include at least one entry.'
        };
      }
      return {
        requestId,
        answers: Object.fromEntries(normalizedEntries)
      };
    }
    default:
      return {
        code: 'ORCH_PAYLOAD_TYPE_UNKNOWN',
        message: `Unknown orchestration request type ${String(type)}.`
      };
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function dedupeWindowKey(nowIso: string): string {
  const time = Date.parse(nowIso);
  if (!Number.isFinite(time)) {
    return 'window:unknown';
  }
  const minuteBucket = Math.floor(time / 60_000);
  return `window:${minuteBucket}`;
}

function orchestrationDedupeKey(input: {
  actorId: string;
  requestedByThreadId: string;
  requestedBySpaceId: string;
  type: RuntimeOrchestrationRequestType;
  targetSessionId: string | null;
  payload: RuntimeOrchestrationPayload;
  nowIso: string;
}): string {
  const payloadDigest = createHash('sha256').update(stableStringify(input.payload)).digest('hex');
  return [
    dedupeWindowKey(input.nowIso),
    input.type,
    input.actorId,
    input.requestedByThreadId,
    input.requestedBySpaceId,
    input.targetSessionId ?? '-',
    payloadDigest
  ].join('|');
}

export function decodeOrchestrationPayload<T extends RuntimeOrchestrationRequestType>(
  type: T,
  rawPayload: unknown
): RuntimeOrchestrationPayloadByType[T] {
  const validated = validatePayloadByType(type, rawPayload);
  if ('code' in validated) {
    throw new Error(`[${validated.code}] ${validated.message}`);
  }
  return validated as RuntimeOrchestrationPayloadByType[T];
}

export function enqueueOrchestrationRequest(input: {
  store: SqliteSessionStore;
  actorId: string;
  requestedByThreadId: string;
  requestedBySpaceId: string;
  type: RuntimeOrchestrationRequestType;
  targetSessionId?: string;
  payload: RuntimeOrchestrationPayload;
  nowIso: string;
}): RuntimeOrchestrationRequestRow {
  const payload = decodeOrchestrationPayload(input.type, input.payload);
  const dedupeKey = orchestrationDedupeKey({
    actorId: input.actorId,
    requestedByThreadId: input.requestedByThreadId,
    requestedBySpaceId: input.requestedBySpaceId,
    type: input.type,
    targetSessionId: input.targetSessionId ?? null,
    payload,
    nowIso: input.nowIso
  });
  const existing = input.store.getLatestOrchestrationRequestByDedupeKey(dedupeKey);
  if (existing && existing.status !== 'failed') {
    return existing;
  }
  const row: RuntimeOrchestrationRequestRow = {
    requestId: randomUUID(),
    actorId: input.actorId,
    requestedByThreadId: input.requestedByThreadId,
    requestedBySpaceId: input.requestedBySpaceId,
    dedupeKey,
    type: input.type,
    targetSessionId: input.targetSessionId ?? null,
    payloadJson: JSON.stringify(payload),
    status: 'pending',
    resultJson: null,
    error: null,
    executionOwner: null,
    executionAttempt: 0,
    executionStartedAt: null,
    completionToken: null,
    completedAt: null,
    createdAt: input.nowIso,
    updatedAt: input.nowIso
  };
  input.store.upsertOrchestrationRequest(row);
  return row;
}

export async function waitForOrchestrationRequest(input: {
  store: SqliteSessionStore;
  requestId: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<RuntimeOrchestrationRequestRow> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  const pollMs = input.pollMs ?? 100;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const request = input.store.getOrchestrationRequest(input.requestId);
    if (!request) {
      throw new Error(`Orchestration request ${input.requestId} disappeared before completion.`);
    }
    if (request.status === 'completed' || request.status === 'failed') {
      return request;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, pollMs));
  }

  const lastKnown = input.store.getOrchestrationRequest(input.requestId);
  throw new Error(
    `Timed out waiting for orchestration request ${input.requestId} (last status: ${lastKnown?.status ?? 'missing'}).`
  );
}
