import type { HybridRetrievalDocument, StrategyScores } from './types.js';

export function rankByScore(
  docs: Array<{ chunkId: string; scores: StrategyScores }>,
  strategy: keyof StrategyScores
): Map<string, number> {
  const ranked = docs
    .filter((doc) => doc.scores[strategy] > 0)
    .sort((a, b) => {
      if (b.scores[strategy] !== a.scores[strategy]) {
        return b.scores[strategy] - a.scores[strategy];
      }
      return a.chunkId.localeCompare(b.chunkId);
    });

  const rankMap = new Map<string, number>();
  for (let index = 0; index < ranked.length; index += 1) {
    rankMap.set(ranked[index].chunkId, index + 1);
  }
  return rankMap;
}

export function topStrategy(scores: StrategyScores): 'symbolic' | 'semantic' | 'metadata' {
  if (scores.semantic >= scores.symbolic && scores.semantic >= scores.metadata) {
    return 'semantic';
  }
  if (scores.symbolic >= scores.metadata) {
    return 'symbolic';
  }
  return 'metadata';
}

export function rerankWithHeuristics(
  query: string,
  queryTokens: string[],
  docs: Array<HybridRetrievalDocument & { retrievalScore: number }>
): Array<HybridRetrievalDocument & { retrievalScore: number }> {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery || !docs.length) {
    return docs;
  }

  return docs
    .map((doc) => {
      const lower = doc.content.toLowerCase();
      const coverage = queryTokens.length
        ? queryTokens.filter((token) => lower.includes(token)).length / queryTokens.length
        : 0;
      let orderedHits = 0;
      let cursor = 0;
      for (const token of queryTokens) {
        const pos = lower.indexOf(token, cursor);
        if (pos >= 0) {
          orderedHits += 1;
          cursor = pos + token.length;
        }
      }
      const orderedRatio = queryTokens.length ? orderedHits / queryTokens.length : 0;
      const exactPhraseBonus = normalizedQuery.length > 4 && lower.includes(normalizedQuery) ? 0.18 : 0;
      const rerankScore = doc.retrievalScore * 0.72 + coverage * 0.2 + orderedRatio * 0.08 + exactPhraseBonus;

      return {
        ...doc,
        score: rerankScore
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (b.retrievalScore !== a.retrievalScore) {
        return b.retrievalScore - a.retrievalScore;
      }
      return a.id.localeCompare(b.id);
    });
}
