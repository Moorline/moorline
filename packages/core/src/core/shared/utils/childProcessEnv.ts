const BASE_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'SSH_AUTH_SOCK',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy'
]);

const PREFIX_ALLOWLIST = ['MOORLINE_'];

function parseExtraAllowlist(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function buildChildProcessEnv(input: {
  explicit?: Record<string, string | undefined>;
  additionalAllowlist?: string[];
} = {}): Record<string, string | undefined> {
  const allowed = new Set(BASE_ENV_ALLOWLIST);
  for (const key of input.additionalAllowlist ?? []) {
    if (key.trim()) {
      allowed.add(key.trim());
    }
  }
  for (const key of parseExtraAllowlist(process.env.MOORLINE_CHILD_ENV_ALLOWLIST)) {
    allowed.add(key);
  }

  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (allowed.has(key) || PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(input.explicit ?? {})) {
    if (value === undefined) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }

  return env;
}
