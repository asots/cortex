/**
 * Rebuild FTS index with jieba-tokenized content.
 * Called once at startup after migration to ensure all memories are indexed
 * with proper CJK word segmentation.
 */

import { getDb } from './connection.js';
import { tokenize } from '../utils/tokenizer.js';
import { createLogger } from '../utils/index.js';

const log = createLogger('fts-rebuild');

export function rebuildFtsIndex(): void {
  const db = getDb();

  // Check if FTS was already rebuilt with jieba (tracked via metadata table)
  db.exec("CREATE TABLE IF NOT EXISTS _metadata (key TEXT PRIMARY KEY, value TEXT)");
  const marker = db.prepare(
    "SELECT value FROM _metadata WHERE key = 'fts_tokenizer'"
  ).get() as { value: string } | undefined;

  if (marker?.value === 'jieba') {
    // Verify count sanity
    const ftsCount = (db.prepare("SELECT COUNT(*) as cnt FROM memories_fts").get() as any)?.cnt ?? 0;
    const memCount = (db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as any)?.cnt ?? 0;
    if (ftsCount > 0 && Math.abs(ftsCount - memCount) < memCount * 0.1) {
      log.info({ ftsCount, memCount }, 'FTS index (jieba) looks healthy, skipping rebuild');
      return;
    }
  }

  const memCount = (db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as any)?.cnt ?? 0;
  log.info({ memCount }, 'Rebuilding FTS index with jieba tokenization');

  // Clear existing FTS entries
  db.exec("DELETE FROM memories_fts");

  // Rebuild with jieba-tokenized content
  const rows = db.prepare('SELECT rowid, content, category FROM memories').all() as {
    rowid: number;
    content: string;
    category: string;
  }[];

  const insertStmt = db.prepare(
    'INSERT INTO memories_fts(rowid, content, category) VALUES (?, ?, ?)'
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      insertStmt.run(row.rowid, tokenize(row.content), row.category);
    }
  });
  tx();

  // Mark FTS as jieba-tokenized
  db.exec("CREATE TABLE IF NOT EXISTS _metadata (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT OR REPLACE INTO _metadata (key, value) VALUES ('fts_tokenizer', 'jieba')").run();

  log.info({ indexed: rows.length }, 'FTS index rebuilt with jieba tokenization');
}
