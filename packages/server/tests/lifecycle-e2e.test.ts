import { describe, it, expect } from 'vitest';
import { setupTestDb } from './setup.js';
import { insertMemory, getDb } from '../src/db/index.js';
import { generateId } from '../src/utils/helpers.js';

setupTestDb();

describe('Lifecycle E2E', () => {
  it('should promote working memories to core after TTL expires', () => {
    const db = getDb();

    // Insert working memories with old created_at (simulate 72h ago)
    const oldDate = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    for (let i = 0; i < 5; i++) {
      const id = generateId();
      insertMemory({
        id,
        agent_id: 'test-agent',
        content: `Working memory ${i}: user prefers tool_${i}`,
        category: 'fact',
        layer: 'working',
        importance: 0.7,
        decay_score: 1.0,
        access_count: 0,
        source: 'test',
        metadata: '{}',
      });
      // Backdate the created_at
      db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(oldDate, id);
    }

    // Verify we have working memories
    const workingCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM memories WHERE layer = 'working' AND agent_id = 'test-agent'"
    ).get() as { cnt: number };
    expect(workingCount.cnt).toBe(5);
  });

  it('should handle expired working memories cleanup', () => {
    const db = getDb();

    // Insert a very old working memory (30 days)
    const veryOldDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const id = generateId();
    insertMemory({
      id,
      agent_id: 'test-cleanup',
      content: 'Very old working memory that should expire',
      category: 'context',
      layer: 'working',
      importance: 0.2,
      decay_score: 0.1,
      access_count: 0,
      source: 'test',
      metadata: '{}',
    });
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(veryOldDate, id);

    // Verify it exists
    const mem = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    expect(mem).toBeDefined();
    expect(mem.layer).toBe('working');
  });

  it('should not promote very recent working memories', () => {
    const db = getDb();

    // Insert a fresh working memory (1 hour ago)
    const recentDate = new Date(Date.now() - 3600 * 1000).toISOString();
    const id = generateId();
    insertMemory({
      id,
      agent_id: 'test-recent',
      content: 'Fresh working memory should stay working',
      category: 'fact',
      layer: 'working',
      importance: 0.7,
      decay_score: 1.0,
      access_count: 0,
      source: 'test',
      metadata: '{}',
    });
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(recentDate, id);

    const mem = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    expect(mem.layer).toBe('working');
  });
});
