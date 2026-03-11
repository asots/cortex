/**
 * CJK-aware tokenizer using jieba-wasm for Chinese word segmentation.
 * Used to tokenize content before FTS5 indexing and query processing.
 *
 * Strategy:
 * - Chinese text: jieba word segmentation → space-joined tokens
 * - Non-Chinese text: passed through as-is (FTS5 unicode61 handles it)
 * - Mixed text: segment CJK runs, keep non-CJK runs intact
 */

let jiebaModule: any = null;
let loadPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (jiebaModule) return;
  if (!loadPromise) {
    loadPromise = import('jieba-wasm').then(m => {
      jiebaModule = m;
    });
  }
  return loadPromise;
}

// Sync version (after first await completes)
function isLoaded(): boolean {
  return jiebaModule !== null;
}

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uF900-\uFAFF]/;
const CJK_RUN = /([\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uF900-\uFAFF]+)/g;

/**
 * Tokenize text for FTS5 indexing/querying.
 * CJK runs → jieba segmentation → space-joined
 * Non-CJK runs → kept as-is
 */
export function tokenize(text: string): string {
  if (!isLoaded() || !CJK_RANGE.test(text)) return text;

  return text.replace(CJK_RUN, (match) => {
    const words = jiebaModule.cut(match) as string[];
    return words.filter(w => w.trim()).join(' ');
  });
}

/**
 * Tokenize for search queries — uses cut_for_search for finer granularity.
 */
export function tokenizeQuery(text: string): string {
  if (!isLoaded() || !CJK_RANGE.test(text)) return text;

  return text.replace(CJK_RUN, (match) => {
    const words = jiebaModule.cut_for_search(match) as string[];
    return words.filter(w => w.trim()).join(' ');
  });
}

export { ensureLoaded };
