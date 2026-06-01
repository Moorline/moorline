const SENSITIVE_KEY_PATTERN = String.raw`(?:token|secret|password|authorization|cookie|api[_-]?key|access[_-]?key|credential|bearer)`;
const SENSITIVE_ASSIGNMENT_KEY_PATTERN = String.raw`(?:token|secret|password|cookie|api[_-]?key|access[_-]?key|credential)`;
const DISCORD_BOT_TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g;
const JSON_SENSITIVE_VALUE_PATTERN = new RegExp(String.raw`("${SENSITIVE_KEY_PATTERN}"\s*:\s*")([^"]+)(")`, 'gi');
const ASSIGNMENT_SENSITIVE_VALUE_PATTERN = new RegExp(String.raw`(\b${SENSITIVE_ASSIGNMENT_KEY_PATTERN}\b\s*[:=]\s*)([^\s,;&"']+)`, 'gi');
const BEARER_VALUE_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/-]+=*)/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(DISCORD_BOT_TOKEN_PATTERN, '[REDACTED]')
    .replace(JSON_SENSITIVE_VALUE_PATTERN, '$1[REDACTED]$3')
    .replace(ASSIGNMENT_SENSITIVE_VALUE_PATTERN, '$1[REDACTED]')
    .replace(BEARER_VALUE_PATTERN, '$1[REDACTED]');
}
