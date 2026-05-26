export interface SafeJsonReadResult<T> {
  value: T | undefined;
  malformed: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function safeReadJson<T>(
  value: string | null | undefined,
  validate: (parsed: unknown) => parsed is T
): SafeJsonReadResult<T> {
  if (!value) {
    return {
      value: undefined,
      malformed: false
    };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return validate(parsed)
      ? {
          value: parsed,
          malformed: false
        }
      : {
          value: undefined,
          malformed: true
        };
  } catch {
    return {
      value: undefined,
      malformed: true
    };
  }
}

export function safeReadJsonValue<T>(value: string | null | undefined): SafeJsonReadResult<T> {
  return safeReadJson<T>(value, (_parsed): _parsed is T => true);
}
