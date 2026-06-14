export class MoorlineStatusError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'MoorlineStatusError';
  }
}

export function errorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('statusCode' in error)) {
    return null;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : null;
}
