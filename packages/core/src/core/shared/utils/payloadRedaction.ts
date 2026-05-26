const DEFAULT_REDACTED_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /cookie/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /credential/i,
  /bearer/i
];

const SENSITIVE_KEY_PATTERN = String.raw`(?:token|secret|password|authorization|cookie|api[_-]?key|access[_-]?key|credential|bearer)`;
const SENSITIVE_ASSIGNMENT_KEY_PATTERN = String.raw`(?:token|secret|password|cookie|api[_-]?key|access[_-]?key|credential)`;
const DISCORD_BOT_TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g;
const JSON_SENSITIVE_VALUE_PATTERN = new RegExp(String.raw`("${SENSITIVE_KEY_PATTERN}"\s*:\s*")([^"]+)(")`, 'gi');
const ASSIGNMENT_SENSITIVE_VALUE_PATTERN = new RegExp(String.raw`(\b${SENSITIVE_ASSIGNMENT_KEY_PATTERN}\b\s*[:=]\s*)([^\s,;&"']+)`, 'gi');
const BEARER_VALUE_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/-]+=*)/gi;

interface RedactPayloadOptions {
  maxDepth?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
  redactedKeyPatterns?: RegExp[];
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 14))}...(truncated)`;
}

function shouldRedactKey(key: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(key));
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(DISCORD_BOT_TOKEN_PATTERN, '[REDACTED]')
    .replace(JSON_SENSITIVE_VALUE_PATTERN, '$1[REDACTED]$3')
    .replace(ASSIGNMENT_SENSITIVE_VALUE_PATTERN, '$1[REDACTED]')
    .replace(BEARER_VALUE_PATTERN, '$1[REDACTED]');
}

function redactValue(
  value: unknown,
  depth: number,
  options: Required<RedactPayloadOptions>
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return truncateString(redactSensitiveText(value), options.maxStringLength);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const trimmed = value.slice(0, options.maxArrayLength).map((entry) => redactValue(entry, depth + 1, options));
    if (value.length > options.maxArrayLength) {
      trimmed.push(`[${value.length - options.maxArrayLength} additional entries truncated]`);
    }
    return trimmed;
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (depth >= options.maxDepth) {
    return '[object truncated]';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, options.maxObjectKeys);
  const redacted: Record<string, unknown> = {};
  for (const key of keys) {
    if (shouldRedactKey(key, options.redactedKeyPatterns)) {
      redacted[key] = '[REDACTED]';
      continue;
    }
    redacted[key] = redactValue(record[key], depth + 1, options);
  }
  if (Object.keys(record).length > options.maxObjectKeys) {
    redacted.__truncatedKeys = Object.keys(record).length - options.maxObjectKeys;
  }
  return redacted;
}

export function redactPayloadForLogs(value: unknown, options: RedactPayloadOptions = {}): unknown {
  const resolved: Required<RedactPayloadOptions> = {
    maxDepth: options.maxDepth ?? 4,
    maxArrayLength: options.maxArrayLength ?? 10,
    maxObjectKeys: options.maxObjectKeys ?? 20,
    maxStringLength: options.maxStringLength ?? 200,
    redactedKeyPatterns: options.redactedKeyPatterns ?? DEFAULT_REDACTED_KEY_PATTERNS
  };
  return redactValue(value, 0, resolved);
}

export function redactPayloadToJson(
  value: unknown,
  options: RedactPayloadOptions & { maxJsonLength?: number } = {}
): string {
  const redacted = redactPayloadForLogs(value, options);
  const json = JSON.stringify(redacted);
  const maxJsonLength = options.maxJsonLength ?? 4_000;
  if (json.length <= maxJsonLength) {
    return json;
  }
  return `${json.slice(0, Math.max(0, maxJsonLength - 14))}...(truncated)`;
}
