import { usesProviderDefaultModel } from '../../../types/config.js';

export function normalizeAndValidateDefaultModel(input: {
  model: string;
  availableModels: string[];
}): string {
  const normalizedModel = input.model.trim().toLowerCase() === 'latest' ? 'latest' : input.model.trim();
  if (!normalizedModel) {
    throw new Error('Model must be a non-empty string.');
  }
  if (!usesProviderDefaultModel(normalizedModel)) {
    if (input.availableModels.length === 0) {
      throw new Error('Moorline has not observed provider model metadata yet. Start a chat or session turn first.');
    }
    if (!input.availableModels.includes(normalizedModel)) {
      throw new Error(`Model ${normalizedModel} is not in the current provider model list.`);
    }
  }
  return normalizedModel;
}
