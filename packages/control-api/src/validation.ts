import { parseRuntimeModeName, type RuntimeModeName } from '@moorline/contracts';
import { JsonBodyError } from './errors.js';

export function parseControlApiRuntimeMode(
  value: unknown,
  field: string
): RuntimeModeName {
  try {
    return parseRuntimeModeName(value, field);
  } catch (error) {
    throw new JsonBodyError(400, error instanceof Error ? error.message : String(error));
  }
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
  options: { trim?: boolean; allowEmpty?: boolean } = {}
): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new JsonBodyError(422, `${field} must be a string.`);
  }
  const trim = options.trim !== false;
  const normalized = trim ? value.trim() : value;
  if (!options.allowEmpty && normalized.length === 0) {
    throw new JsonBodyError(422, `${field} must be a non-empty string.`);
  }
  return normalized;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  options: { trim?: boolean; allowEmpty?: boolean } = {}
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new JsonBodyError(422, `${field} must be a string when provided.`);
  }
  const trim = options.trim !== false;
  const normalized = trim ? value.trim() : value;
  if (!options.allowEmpty && normalized.length === 0) {
    return undefined;
  }
  return normalized;
}

export function requireBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') {
    throw new JsonBodyError(422, `${field} is required and must be a boolean.`);
  }
  return value;
}

export function optionalNullableId(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new JsonBodyError(422, `${field} must be a string, null, or undefined.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new JsonBodyError(422, `${field} must not be empty when provided.`);
  }
  return normalized;
}
