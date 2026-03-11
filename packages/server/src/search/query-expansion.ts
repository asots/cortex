import { createLogger } from '../utils/logger.js';
import type { LLMProvider } from '../llm/interface.js';

const log = createLogger('query-expansion');

export interface QueryExpansionConfig {
  enabled: boolean;
  maxVariants: number;
}

/** Detect if query contains CJK characters */
function hasCJK(text: string): boolean {
  return /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text);
}

/**
 * Clean LLM output: remove bullet/numbering prefixes and empty lines.
 */
function cleanVariants(raw: string): string[] {
  return raw
    .split('\n')
    .map(line => line.trim())
    .map(line => line.replace(/^[-•*]\s*/, '').replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(line => line.length >= 3);
}

/**
 * Expand a recall query using a hybrid strategy:
 * - Short queries (≤15 chars): keyword expansion, single enriched search
 * - Long queries (>15 chars): generate 2 full variant queries for multi-angle cross-validation
 * - CJK queries get cross-language hints; English queries preserve technical terms
 */
export async function expandQuery(
  query: string,
  llm: LLMProvider,
  config: QueryExpansionConfig,
): Promise<string[]> {
  if (!config.enabled || query.length < 3) {
    return [query];
  }

  const isCJK = hasCJK(query);

  try {
    // Short queries (≤15 chars): keyword expansion, single search
    if (query.length <= 15) {
      const cjkHint = isCJK
        ? ' Also include 1-2 English keywords if the topic has common English terms.'
        : '';
      const response = await llm.complete(
        `Given this memory search query, output 4-6 additional keywords/synonyms that would help find relevant memories in a personal knowledge base. Think about how the answer might be stored (e.g. "名字叫什么" → the memory might say "昵称为xxx"). Same language as the query. Keep technical terms as-is.${cjkHint} Output only the keywords, space-separated.\n\nQuery: "${query}"`,
        {
          maxTokens: 60,
          temperature: 0.2,
          systemPrompt: 'Output only keywords, nothing else. Think about both the question AND how the answer might be stored in memory.',
        },
      );

      const keywords = response.trim();
      const enriched = `${query} ${keywords}`;
      log.info({ original: query, keywords }, 'Query expanded (keyword mode)');
      return [query, enriched]; // Original first (clean signal), then enriched for broader recall
    }

    // Long queries (>15 chars): generate 2 full variant queries
    const maxVariants = config.maxVariants || 3;
    const cjkRule = isCJK
      ? '- Include 1-2 English keyword variants if the topic involves technology, names, or common English terms'
      : '- If the query involves technical terms, keep the original term in at least one variant';
    const response = await llm.complete(
      `Given this memory search query, generate ${maxVariants} alternative search queries that capture the same intent using different words, synonyms, or angles. The goal is to improve recall when searching a personal memory database.

Original query: "${query}"

Rules:
- Each variant should use different keywords/phrasing
- Think about how the answer might be stored (e.g. "住在哪里" → memory might say "位于东京" or "lives_in Tokyo")
- Keep variants concise (under 30 words)
- Include the semantic meaning but vary the vocabulary
${cjkRule}
- Output ONLY the variant queries, one per line, no numbering or prefixes`,
      {
        maxTokens: 120,
        temperature: 0.4,
        systemPrompt: 'You are a search query expansion engine. Output only the expanded queries, nothing else.',
      },
    );

    const maxLen = query.length * 3;
    const variants = cleanVariants(response)
      .filter(line => line.length <= maxLen)
      .slice(0, maxVariants);

    const allQueries = [query, ...variants];
    log.info({ original: query.slice(0, 50), variants: variants.length }, 'Query expanded (variant mode)');
    return allQueries;
  } catch (e: any) {
    log.warn({ error: e.message }, 'Query expansion failed, using original query');
    return [query];
  }
}
