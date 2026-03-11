/**
 * Shared relation parsing and filtering logic.
 * Used by both sieve.ts and flush.ts to avoid code duplication.
 */

import { normalizeEntity } from '../utils/normalize.js';
import { type ExtractedRelation, VALID_PREDICATES } from './sieve.js';

/** Sensitive information regex: API keys, tokens, emails, IPs, private keys */
export const SENSITIVE_ENTITY_RE = /(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9\-]{20,}|token[:\s=][^\s]{10,}|[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|Bearer\s+[a-zA-Z0-9._\-]+)/i;

/** Minimum confidence to accept (filters LLM hallucinations) */
const MIN_CONFIDENCE = 0.5;

/** Maximum entity name length (prevents sentences as entity names) */
const MAX_ENTITY_LEN = 50;

/** Noise entity patterns — too generic or version-specific to be useful relations */
const NOISE_ENTITY_RE = /^(v\d+\.\d+|version|session|对话|消息|记忆|bug|error|fix|issue|task|问题|修复|功能|配置|设置|操作|处理|方案|测试|result|data|info|item|thing|stuff|内容|结果|信息)$/i;

/**
 * Parse and validate relation triples from LLM JSON output.
 * Applies: confidence gate, entity length limit, sensitive info filter,
 * entity normalization, expired field extraction.
 */
export function parseRelations(obj: any): ExtractedRelation[] {
  if (!obj?.relations || !Array.isArray(obj.relations)) return [];

  return obj.relations
    .filter((r: any) => {
      if (!r.subject || typeof r.subject !== 'string' || r.subject.length < 1) return false;
      if (!r.object || typeof r.object !== 'string' || r.object.length < 1) return false;
      if (!r.predicate || !VALID_PREDICATES.has(r.predicate)) return false;
      const conf = typeof r.confidence === 'number' ? r.confidence : 0.8;
      if (conf < 0 || conf > 1) return false;
      if (conf < MIN_CONFIDENCE) return false;
      if (r.subject.length > MAX_ENTITY_LEN) return false;
      if (r.object.length > MAX_ENTITY_LEN) return false;
      if (SENSITIVE_ENTITY_RE.test(r.subject)) return false;
      if (SENSITIVE_ENTITY_RE.test(r.object)) return false;
      // Fix 9: Filter noise entities (too generic or version-specific)
      if (NOISE_ENTITY_RE.test(r.subject.trim()) || NOISE_ENTITY_RE.test(r.object.trim())) return false;
      // Fix 9: Subject and object shouldn't be the same
      if (normalizeEntity(r.subject) === normalizeEntity(r.object)) return false;
      return true;
    })
    .map((r: any) => ({
      subject: normalizeEntity(r.subject),
      predicate: r.predicate,
      object: normalizeEntity(r.object),
      confidence: typeof r.confidence === 'number' ? r.confidence : 0.8,
      expired: r.expired === true,
    }));
}
