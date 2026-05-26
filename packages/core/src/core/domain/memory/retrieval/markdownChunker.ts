import { CHUNK_MAX_CHARS, CHUNK_TARGET_CHARS } from './types.js';
import { normalizeTokens } from './tokenEmbedding.js';

export function extractHeadings(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 6);
}

export function tokenizeMetadata(input: string): string[] {
  return normalizeTokens(input).filter((token, index, list) => list.indexOf(token) === index);
}

export function markdownAwareChunks(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (!lines.length) {
    return [];
  }

  const segments: string[] = [];
  let inCodeFence = false;
  let current: string[] = [];

  const flushSegment = (): void => {
    if (!current.length) {
      return;
    }
    const segment = current.join('\n').trim();
    if (segment) {
      segments.push(segment);
    }
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isFence = trimmed.startsWith('```');

    if (!inCodeFence && /^#{1,6}\s+/.test(trimmed) && current.length) {
      flushSegment();
    }

    current.push(line);

    if (isFence) {
      inCodeFence = !inCodeFence;
      if (!inCodeFence) {
        flushSegment();
      }
      continue;
    }

    if (!inCodeFence && trimmed === '') {
      flushSegment();
    }
  }

  flushSegment();
  if (!segments.length) {
    return [content.trim()].filter(Boolean);
  }

  const chunks: string[] = [];
  let chunk = '';

  const flushChunk = (): void => {
    const trimmed = chunk.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    chunk = '';
  };

  for (const segment of segments) {
    const withSeparator = chunk.length ? `${chunk}\n\n${segment}` : segment;
    if (withSeparator.length > CHUNK_MAX_CHARS && chunk.length) {
      flushChunk();
    }

    chunk = chunk.length ? `${chunk}\n\n${segment}` : segment;
    if (chunk.length >= CHUNK_TARGET_CHARS) {
      flushChunk();
    }
  }

  flushChunk();
  return chunks.length ? chunks : [content.trim()].filter(Boolean);
}
