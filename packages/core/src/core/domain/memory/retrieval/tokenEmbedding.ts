import { createHash } from 'node:crypto';
import { VECTOR_DIMENSIONS } from './types.js';

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

export function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

export function tokenEmbedding(text: string): number[] {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  const tokens = normalizeTokens(text);
  if (!tokens.length) {
    return vector;
  }

  for (const token of tokens) {
    const tokenHash = createHash('sha1').update(token).digest();
    for (let i = 0; i < tokenHash.length; i += 1) {
      const bucket = tokenHash[i] % VECTOR_DIMENSIONS;
      const sign = i % 2 === 0 ? 1 : -1;
      vector[bucket] += sign * (1 + tokenHash[i] / 255);
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }

  return vector.map((value) => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += a[i] * b[i];
  }

  return Math.max(0, sum);
}
