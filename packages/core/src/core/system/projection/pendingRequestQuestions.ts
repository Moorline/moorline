import type { ManagedPendingRequestRecord } from '../../../types/app.js';

export function parsePendingRequestQuestions(questionsJson: string | null): ManagedPendingRequestRecord['questions'] {
  if (!questionsJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(questionsJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return [];
        }
        const question = entry as Record<string, unknown>;
        const id = typeof question.id === 'string' ? question.id.trim() : '';
        const header = typeof question.header === 'string' ? question.header.trim() : '';
        const prompt = typeof question.question === 'string' ? question.question.trim() : '';
        if (!id || !header || !prompt) {
          return [];
        }
        const options = Array.isArray(question.options)
          ? question.options.flatMap((option) => {
              if (!option || typeof option !== 'object' || Array.isArray(option)) {
                return [];
              }
              const record = option as Record<string, unknown>;
              const label = typeof record.label === 'string' ? record.label.trim() : '';
              const description = typeof record.description === 'string' ? record.description.trim() : '';
              if (!label || !description) {
                return [];
              }
              return [{ label, description }];
            })
          : [];
        return [
          {
            id,
            header,
            question: prompt,
            options
          }
        ];
      })
      .slice(0, 10);
  } catch {
    return [];
  }
}
