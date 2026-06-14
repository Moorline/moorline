import { MoorlineStatusError } from '../../shared/errors/statusError.js';

export function parseOrchestrationResult<T>(request: { error: string | null; resultJson: string | null }): T {
  if (request.error) {
    const statusMatch = request.error.match(/^\[MOORLINE_STATUS_ERROR:(\d{3})\]\s*(.*)$/u);
    if (statusMatch) {
      throw new MoorlineStatusError(Number.parseInt(statusMatch[1], 10), statusMatch[2] || 'Runtime request failed.');
    }
    throw new Error(request.error);
  }
  return JSON.parse(request.resultJson ?? 'null') as T;
}
