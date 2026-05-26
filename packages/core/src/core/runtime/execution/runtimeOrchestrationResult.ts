export function parseOrchestrationResult<T>(request: { error: string | null; resultJson: string | null }): T {
  if (request.error) {
    throw new Error(request.error);
  }
  return JSON.parse(request.resultJson ?? 'null') as T;
}
