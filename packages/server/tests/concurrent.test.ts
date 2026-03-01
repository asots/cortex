import { describe, it, expect } from 'vitest';
import { setupTestDb } from './setup.js';
import { insertMemory, getDb } from '../src/db/index.js';
import { generateId } from '../src/utils/helpers.js';

setupTestDb();

describe('Concurrent Safety', () => {
  it('should handle parallel inserts without crashing', () => {
    const db = getDb();
    const ids: string[] = [];

    // Simulate rapid concurrent inserts (synchronous in SQLite but tests the path)
    for (let i = 0; i < 100; i++) {
      const id = generateId();
      ids.push(id);
      insertMemory({
        id,
        agent_id: 'concurrent-test',
        content: `Concurrent fact ${i}: data point ${Math.random()}`,
        category: 'fact',
        layer: 'working',
        importance: 0.5 + Math.random() * 0.5,
        decay_score: 1.0,
        access_count: 0,
        source: 'test',
        metadata: '{}',
      });
    }

    // Verify all inserted
    const count = db.prepare(
      "SELECT COUNT(*) as cnt FROM memories WHERE agent_id = 'concurrent-test'"
    ).get() as { cnt: number };
    expect(count.cnt).toBe(100);

    // Verify each ID exists
    for (const id of ids.slice(0, 10)) {
      const mem = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
      expect(mem).toBeDefined();
    }
  });

  it('should handle lifecycle active flag', async () => {
    // Import the flag checker
    const { isLifecycleActive } = await import('../src/decay/lifecycle.js');
    // By default, lifecycle should not be active
    expect(isLifecycleActive()).toBe(false);
  });

  it('should handle FTS search under load', () => {
    const db = getDb();

    // Insert memories with searchable content
    for (let i = 0; i < 50; i++) {
      const id = generateId();
      insertMemory({
        id,
        agent_id: 'fts-load-test',
        content: `User prefers TypeScript for backend development project ${i}`,
        category: 'preference',
        layer: 'core',
        importance: 0.8,
        decay_score: 1.0,
        access_count: 0,
        source: 'test',
        metadata: '{}',
      });
    }

    // Run FTS search multiple times
    const results: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = Date.now();
      const rows = db.prepare(
        "SELECT rowid, content FROM memories_fts WHERE memories_fts MATCH 'TypeScript' LIMIT 10"
      ).all();
      results.push(Date.now() - start);
      expect(rows.length).toBeGreaterThan(0);
    }

    // P95 should be reasonable (< 100ms for 50 records)
    results.sort((a, b) => a - b);
    const p95 = results[Math.floor(results.length * 0.95)]!;
    expect(p95).toBeLessThan(100);
  });
});
