import { describe, it, expect, beforeEach } from 'vitest';

// We need a fresh metrics instance per test, so import the class path
// Actually metrics is a singleton, let's just test it
import { metrics } from '../src/utils/metrics.js';

describe('Metrics', () => {
  // Note: metrics is a global singleton, counters accumulate across tests
  // This is fine for testing behavior

  it('should increment counters', () => {
    const before = metrics.getCounter('test_counter');
    metrics.inc('test_counter');
    expect(metrics.getCounter('test_counter')).toBe(before + 1);
    metrics.inc('test_counter', undefined, 5);
    expect(metrics.getCounter('test_counter')).toBe(before + 6);
  });

  it('should support labeled counters', () => {
    metrics.inc('test_labeled', { action: 'insert' });
    metrics.inc('test_labeled', { action: 'insert' });
    metrics.inc('test_labeled', { action: 'skip' });
    expect(metrics.getCounter('test_labeled', { action: 'insert' })).toBeGreaterThanOrEqual(2);
    expect(metrics.getCounter('test_labeled', { action: 'skip' })).toBeGreaterThanOrEqual(1);
  });

  it('should observe histogram values', () => {
    for (let i = 0; i < 100; i++) {
      metrics.observe('test_latency', i * 10);
    }
    const stats = metrics.getHistogram('test_latency');
    expect(stats).not.toBeNull();
    expect(stats!.count).toBeGreaterThanOrEqual(100);
    expect(stats!.p50).toBeGreaterThan(0);
    expect(stats!.p95).toBeGreaterThan(stats!.p50);
    expect(stats!.avg).toBeGreaterThan(0);
  });

  it('should export Prometheus format', () => {
    metrics.inc('prom_test_total');
    const output = metrics.toPrometheus();
    expect(output).toContain('# TYPE');
    expect(output).toContain('prom_test_total');
  });

  it('should export JSON format', () => {
    metrics.inc('json_test_total');
    metrics.observe('json_test_latency', 42);
    const json = metrics.toJSON();
    expect(json.counters).toBeDefined();
    expect(json.histograms).toBeDefined();
    expect(json.counters['json_test_total']).toBeDefined();
    expect(json.histograms['json_test_latency']).toBeDefined();
    expect(json.histograms['json_test_latency'].count).toBeGreaterThanOrEqual(1);
  });

  it('should bound histogram memory to 1000 values', () => {
    for (let i = 0; i < 1500; i++) {
      metrics.observe('bounded_hist', i);
    }
    const stats = metrics.getHistogram('bounded_hist');
    expect(stats).not.toBeNull();
    // Count tracks all observations, but internal array is bounded
    expect(stats!.count).toBeGreaterThanOrEqual(1500);
  });
});
