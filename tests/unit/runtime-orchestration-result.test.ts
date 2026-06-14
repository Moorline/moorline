import { describe, expect, it } from 'vitest';
import { parseOrchestrationResult } from '../../packages/core/src/core/runtime/execution/runtimeOrchestrationResult.js';

describe('runtime orchestration results', () => {
  it('preserves status-bearing runtime failures for control API callers', () => {
    expect(() => parseOrchestrationResult({
      error: '[MOORLINE_STATUS_ERROR:404] No matching managed worker session found.',
      resultJson: null
    })).toThrow(expect.objectContaining({
      statusCode: 404,
      message: 'No matching managed worker session found.'
    }));
  });
});
