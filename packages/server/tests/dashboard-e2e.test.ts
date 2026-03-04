import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Dashboard Integration Tests
 *
 * Validates compiled Dashboard assets contain correct integration panel content.
 * Tests the built output directly — no server required.
 */

const DASHBOARD_DIST = path.resolve(__dirname, '../../dashboard/dist');

describe('Dashboard Integration', () => {
  const distExists = fs.existsSync(DASHBOARD_DIST);

  it('should have dist directory', () => {
    expect(distExists).toBe(true);
  });

  it('should have index.html', () => {
    if (!distExists) return;
    const html = fs.readFileSync(path.join(DASHBOARD_DIST, 'index.html'), 'utf-8');
    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('.js');
    expect(html).toContain('.css');
  });

  describe('JS bundle content', () => {
    let js = '';

    it('should find and read JS bundle', () => {
      if (!distExists) return;
      const assets = fs.readdirSync(path.join(DASHBOARD_DIST, 'assets'));
      const jsFile = assets.find(f => f.endsWith('.js'));
      expect(jsFile).toBeDefined();
      js = fs.readFileSync(path.join(DASHBOARD_DIST, 'assets', jsFile!), 'utf-8');
      expect(js.length).toBeGreaterThan(0);
    });

    // ── Integration panel: Methods A/B/C ──
    it('should contain Method A (openclaw.json config)', () => {
      if (!js) return;
      expect(js).toContain('openclawJsonMethod');
      expect(js).toContain('openclawJsonMethodDesc');
    });

    it('should contain Method B (.env)', () => {
      if (!js) return;
      expect(js).toContain('openclawEnvMethod');
      expect(js).toContain('openclawEnvMethodDesc');
    });

    it('should contain Method C (shell profile)', () => {
      if (!js) return;
      expect(js).toContain('openclawShellMethod');
      expect(js).toContain('openclawShellMethodDesc');
    });

    it('should not have duplicate Method B in English', () => {
      if (!js) return;
      expect(js).toContain('Method C');
      // Method B should appear at most twice (label + desc)
      const matches = js.match(/Method B/g) || [];
      expect(matches.length).toBeLessThanOrEqual(2);
    });

    // ── CORTEX_AGENT_ID presence ──
    it('should include CORTEX_AGENT_ID in templates', () => {
      if (!js) return;
      const count = (js.match(/CORTEX_AGENT_ID/g) || []).length;
      // Should appear in: .env template, shell template, MCP configs (at least 3)
      expect(count).toBeGreaterThanOrEqual(3);
    });

    // ── Commands use underscore (Telegram compatible) ──
    it('should use cortex_status (underscore, not hyphen)', () => {
      if (!js) return;
      expect(js).toContain('cortex_status');
      expect(js).not.toContain('cortex-status');
    });

    // ── All 4 commands listed ──
    it('should list all plugin commands', () => {
      if (!js) return;
      expect(js).toContain('openclawCommand');        // cortex_status
      expect(js).toContain('openclawCommandSearch');   // cortex_search
      expect(js).toContain('openclawCommandRemember'); // cortex_remember
      expect(js).toContain('openclawCommandRecent');   // cortex_recent
    });

    // ── Step titles ──
    it('should have all 4 integration steps', () => {
      if (!js) return;
      expect(js).toContain('openclawStep1Title');
      expect(js).toContain('openclawStep2Title');
      expect(js).toContain('openclawStep3Title');
      expect(js).toContain('openclawStep4Title');
    });

    // ── Hooks and tools listed ──
    it('should list hooks and tools in step 3', () => {
      if (!js) return;
      expect(js).toContain('openclawHookBefore');
      expect(js).toContain('openclawHookAfter');
      expect(js).toContain('openclawHookCompaction');
      expect(js).toContain('openclawToolRecall');
      expect(js).toContain('openclawToolRemember');
    });

    // ── No hardcoded personal info ──
    it('should not contain hardcoded personal info', () => {
      if (!js) return;
      expect(js).not.toContain('121.103');
      expect(js).not.toContain('aji4545');
      expect(js).not.toContain('rigouu');
      expect(js).not.toContain('harry-server');
      expect(js).not.toContain('qoi.me');
      expect(js).not.toContain('zan.ink');
    });

    // ── i18n completeness ──
    it('should have both zh and en locale keys', () => {
      if (!js) return;
      // Chinese
      expect(js).toContain('安装插件');
      expect(js).toContain('设置 Cortex 服务器地址');
      // English
      expect(js).toContain('Install Plugin');
      expect(js).toContain('Set Cortex Server Address');
    });
  });

  describe('CSS bundle', () => {
    it('should have valid CSS file', () => {
      if (!distExists) return;
      const assets = fs.readdirSync(path.join(DASHBOARD_DIST, 'assets'));
      const cssFile = assets.find(f => f.endsWith('.css'));
      expect(cssFile).toBeDefined();
      const css = fs.readFileSync(path.join(DASHBOARD_DIST, 'assets', cssFile!), 'utf-8');
      expect(css.length).toBeGreaterThan(100);
    });
  });
});
