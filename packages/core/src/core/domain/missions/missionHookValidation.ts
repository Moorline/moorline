export type MissionHookConditionValue = string | number | boolean | null;

export type MissionHookCondition = Record<string, MissionHookConditionValue>;

const MISSION_HOOK_KEY_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/u;

export function normalizeMissionHookKey(hookKey: string): string {
  const normalized = hookKey.trim();
  if (!MISSION_HOOK_KEY_PATTERN.test(normalized)) {
    throw new Error('hookKey must be 1-128 chars and only include letters, numbers, ".", "_", ":", "/", and "-".');
  }
  return normalized;
}

export function normalizeMissionHookCondition(condition: MissionHookCondition | undefined): MissionHookCondition {
  if (!condition) {
    return {};
  }
  const normalized: MissionHookCondition = {};
  for (const [key, value] of Object.entries(condition)) {
    if (!key.trim()) {
      throw new Error('Mission hook condition keys must be non-empty strings.');
    }
    if (!(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      throw new Error('Mission hook condition values must be string, number, boolean, or null.');
    }
    normalized[key] = value;
  }
  return normalized;
}

export function parseMissionHookConditionJson(conditionJson: string | null): MissionHookCondition {
  if (!conditionJson) {
    return {};
  }
  const parsed = JSON.parse(conditionJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Mission hook binding condition must be a JSON object.');
  }
  return normalizeMissionHookCondition(parsed as MissionHookCondition);
}

export function normalizeMissionHookPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) {
    return {};
  }
  if (Array.isArray(payload) || typeof payload !== 'object') {
    throw new Error('Mission hook payload must be a JSON object.');
  }
  return payload;
}

export function normalizeMissionHookSource(source: string): string {
  const normalized = source.trim();
  if (!MISSION_HOOK_KEY_PATTERN.test(normalized)) {
    throw new Error('Mission hook source must be 1-128 chars and use safe token characters.');
  }
  return normalized;
}

export function matchesMissionHookCondition(payload: Record<string, unknown>, condition: MissionHookCondition): boolean {
  for (const [key, expected] of Object.entries(condition)) {
    if (payload[key] !== expected) {
      return false;
    }
  }
  return true;
}
