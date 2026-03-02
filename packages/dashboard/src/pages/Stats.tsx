import React, { useEffect, useState, useRef } from 'react';
import { getStats, getHealth, getComponentHealth, listMemories } from '../api/client.js';
import { useI18n } from '../i18n/index.js';

function fmtNum(n: number): string {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 10_000) return (n / 10_000).toFixed(1).replace(/\.0$/, '') + '万';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function timeAgo(dateStr: string, future = false): string {
  const diff = future ? new Date(dateStr).getTime() - Date.now() : Date.now() - new Date(dateStr).getTime();
  const abs = Math.abs(diff);
  if (abs < 60_000) return future ? '即将' : '刚刚';
  if (abs < 3600_000) return Math.floor(abs / 60_000) + '分钟' + (future ? '后' : '前');
  if (abs < 86400_000) return Math.floor(abs / 3600_000) + '小时' + (future ? '后' : '前');
  return Math.floor(abs / 86400_000) + '天' + (future ? '后' : '前');
}

// ─── Mini Canvas Bar Chart ──────────────────────────────────────────────────

function BarChart({ data, colors, height = 220 }: { data: { label: string; value: number }[]; colors: string[]; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    const max = Math.max(...data.map(d => d.value), 1);
    const barW = Math.min(60, (W - 40) / data.length - 10);
    const startX = (W - data.length * (barW + 10) + 10) / 2;

    ctx.clearRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = 20 + (H - 90) * (1 - i / 4);
      ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(W - 10, y); ctx.stroke();
      ctx.fillStyle = '#71717a';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(max * i / 4)), 26, y + 3);
    }

    data.forEach((d, i) => {
      const x = startX + i * (barW + 10);
      const barH = (d.value / max) * (H - 90);
      const y = H - 70 - barH;

      // Bar with gradient
      const grad = ctx.createLinearGradient(x, y, x, H - 70);
      grad.addColorStop(0, colors[i % colors.length]!);
      grad.addColorStop(1, colors[i % colors.length]! + '44');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0]);
      ctx.fill();

      // Value on top
      ctx.fillStyle = '#e4e4e7';
      ctx.font = 'bold 12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(String(d.value), x + barW / 2, y - 6);

      // Label (rotated 45°)
      ctx.fillStyle = '#71717a';
      ctx.font = '10px system-ui';
      ctx.save();
      ctx.translate(x + barW / 2, H - 18);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'right';
      ctx.fillText(d.label, 0, 0);
      ctx.restore();
    });
  }, [data, colors, height]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: height }} />;
}

// ─── Horizontal Distribution Bar ────────────────────────────────────────────

function DistributionBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const { t } = useI18n();
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{t('common.noData')}</div>;
  return (
    <div>
      <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
        {segments.map((seg, i) => (
          <div
            key={i}
            style={{
              width: `${(seg.value / total) * 100}%`,
              background: seg.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 600, color: '#fff',
              minWidth: seg.value > 0 ? 24 : 0,
              transition: 'width 0.3s',
            }}
          >
            {seg.value > 0 && ((seg.value / total) > 0.08 ? seg.value : '')}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {segments.map((seg, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: seg.color }} />
            <span style={{ color: 'var(--text-muted)' }}>{seg.label}</span>
            <span style={{ fontWeight: 600 }}>{seg.value}</span>
            <span style={{ color: 'var(--text-muted)' }}>({total > 0 ? ((seg.value / total) * 100).toFixed(1) : 0}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Importance Histogram ───────────────────────────────────────────────────

function Histogram({ values, label, color }: { values: number[]; label: string; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || values.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;

    // Build 10 buckets [0,0.1), [0.1,0.2), ... [0.9,1.0]
    const buckets = new Array(10).fill(0);
    for (const v of values) {
      const idx = Math.min(Math.floor(v * 10), 9);
      buckets[idx]++;
    }
    const max = Math.max(...buckets, 1);
    const barW = (W - 50) / 10 - 2;

    ctx.clearRect(0, 0, W, H);

    // Y axis
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i <= 3; i++) {
      const y = 10 + (H - 40) * (1 - i / 3);
      ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(W - 5, y); ctx.stroke();
      ctx.fillStyle = '#71717a'; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(max * i / 3)), 26, y + 3);
    }

    buckets.forEach((count, i) => {
      const x = 35 + i * (barW + 2);
      const barH = (count / max) * (H - 40);
      const y = H - 25 - barH;

      ctx.fillStyle = color + (count > 0 ? 'cc' : '33');
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, [2, 2, 0, 0]);
      ctx.fill();

      // X label
      ctx.fillStyle = '#71717a'; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
      ctx.fillText((i / 10).toFixed(1), x + barW / 2, H - 8);
    });

    // Title
    ctx.fillStyle = '#71717a'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(label, W / 2, H - 0);
  }, [values, label, color]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: 140 }} />;
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function Stats() {
  const [stats, setStats] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [error, setError] = useState('');
  const [allMemories, setAllMemories] = useState<any[]>([]);
  const [components, setComponents] = useState<any[]>([]);
  const { t } = useI18n();

  useEffect(() => {
    Promise.all([getStats(), getHealth()])
      .then(([s, h]) => { setStats(s); setHealth(h); })
      .catch(e => setError(e.message));

    getComponentHealth()
      .then((r: any) => setComponents(r.components || []))
      .catch(() => {});

    // Load sample memories for distribution histograms
    listMemories({ limit: '500', offset: '0' })
      .then((r: any) => setAllMemories(r.items || []))
      .catch(() => {});
  }, []);

  if (error) return <div className="card" style={{ color: 'var(--danger)' }}>{t('common.errorPrefix', { message: error })}</div>;
  if (!stats) return <div className="loading">{t('common.loading')}</div>;

  const layers = stats.layers || {};
  const categories = stats.categories || {};

  const layerSegments = [
    { label: t('stats.core'), value: layers.core || 0, color: '#818cf8' },
    { label: t('stats.working'), value: layers.working || 0, color: '#4ade80' },
    { label: t('stats.archive'), value: layers.archive || 0, color: '#a1a1aa' },
  ];

  const catData = Object.entries(categories).map(([cat, cnt]) => ({
    label: cat,
    value: cnt as number,
  }));

  const catColors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6', '#f97316', '#8b5cf6'];

  const importanceValues = allMemories.map(m => m.importance ?? 0);
  const decayValues = allMemories.map(m => m.decay_score ?? 0);
  const confidenceValues = allMemories.map(m => m.confidence ?? 0);

  const formatUptime = (seconds: number) => {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  };

  return (
    <div>
      <h1 className="page-title">{t('stats.title')}</h1>

      {/* Stat Cards */}
      <div className="card-grid">
        <div className="stat-card">
          <div className="label">{t('stats.totalMemories')}</div>
          <div className="value">{fmtNum(stats.total_memories || 0)}</div>
        </div>
        <div className="stat-card">
          <div className="label">{t('stats.core')}</div>
          <div className="value" style={{ color: '#818cf8' }}>{layers.core || 0}</div>
        </div>
        <div className="stat-card">
          <div className="label">{t('stats.working')}</div>
          <div className="value" style={{ color: '#4ade80' }}>{layers.working || 0}</div>
        </div>
        <div className="stat-card">
          <div className="label">{t('stats.archive')}</div>
          <div className="value" style={{ color: '#a1a1aa' }}>{layers.archive || 0}</div>
        </div>
        <div className="stat-card">
          <div className="label">{t('stats.relations')}</div>
          <div className="value">{fmtNum(stats.total_relations || 0)}</div>
        </div>
        <div className="stat-card">
          <div className="label">{t('stats.accessLogs')}</div>
          <div className="value">{fmtNum(stats.total_access_logs || 0)}</div>
        </div>
      </div>

      {/* Layer Distribution */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>{t('stats.layerDistribution')}</h3>
        <DistributionBar segments={layerSegments} />
      </div>

      {/* Category Chart */}
      {catData.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('stats.categories')}</h3>
          <BarChart data={catData} colors={catColors} height={180} />
        </div>
      )}

      {/* Score Distributions */}
      {allMemories.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('stats.scoreDistributions')}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
            <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius)', padding: 12 }}>
              <Histogram values={importanceValues} label={t('stats.importance')} color="#6366f1" />
            </div>
            <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius)', padding: 12 }}>
              <Histogram values={decayValues} label={t('stats.decayScore')} color="#f59e0b" />
            </div>
            <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius)', padding: 12 }}>
              <Histogram values={confidenceValues} label={t('stats.confidence')} color="#22c55e" />
            </div>
          </div>
        </div>
      )}

      {/* System Health */}
      {health && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 12 }}>{t('stats.systemHealth')}</h3>
          <table>
            <tbody>
              <tr><td>{t('stats.status')}</td><td><span style={{ color: health.status === 'ok' ? 'var(--success)' : 'var(--danger)' }}>● {health.status}</span></td></tr>
              <tr><td>{t('stats.version')}</td><td>{health.version}</td></tr>
              <tr><td>{t('stats.uptime')}</td><td>{formatUptime(health.uptime)}</td></tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Component Status */}
      {components.length > 0 && (
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>{t('stats.componentStatus')}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {components.map((c: any) => {
              const statusColor = c.status === 'ok' ? '#22c55e' : c.status === 'warning' ? '#f59e0b' : c.status === 'error' ? '#ef4444' : c.status === 'stopped' ? '#ef4444' : c.status === 'not_configured' ? '#71717a' : '#71717a';
              const statusLabel = c.status === 'ok' ? '✅ 正常' : c.status === 'warning' ? '⚠️ 警告' : c.status === 'error' ? '❌ 错误' : c.status === 'stopped' ? '⏹ 停止' : c.status === 'not_configured' ? '⚙️ 未配置' : '❓ 未知';
              const ago = c.lastRun ? timeAgo(c.lastRun) : null;
              return (
                <div key={c.id} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</span>
                    <span style={{ color: statusColor, fontSize: 12, fontWeight: 600 }}>{statusLabel}</span>
                  </div>
                  {ago && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                      上次运行: {ago}
                    </div>
                  )}
                  {c.latencyMs != null && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                      延迟: {c.latencyMs}ms
                    </div>
                  )}
                  {c.details && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {c.id === 'extraction_llm' && <>
                        通道: {c.details.channel} · 24h: {c.details.last24h}次
                        {c.details.errorsLast24h > 0 && <span style={{ color: '#ef4444' }}> · 错误: {c.details.errorsLast24h}</span>}
                      </>}
                      {c.id === 'lifecycle' && <>
                        触发: {c.details.trigger === 'scheduled' ? '⏰定时' : c.details.trigger === 'manual' ? '👆手动' : c.details.trigger || '-'}
                        {' · '}升级: {c.details.promoted ?? 0} · 归档: {c.details.archived ?? 0}
                      </>}
                      {c.id === 'embedding' && <>
                        模型: {c.details.model}
                      </>}
                      {c.id === 'scheduler' && <>
                        计划: {c.details.schedule || '-'}
                        {c.details.nextRun && <> · 下次: {timeAgo(c.details.nextRun, true)}</>}
                      </>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
