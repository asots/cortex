import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { listRelations, createRelation, deleteRelation, search } from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { toLocal } from '../utils/time.js';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import FA2Layout from 'graphology-layout-forceatlas2/worker';

interface Relation {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  agent_id: string;
  extraction_count: number;
  expired: number;
  created_at: string;
  updated_at: string;
}

const AGENT_COLORS = [
  '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#3b82f6',
  '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#06b6d4',
];

function getAgentColor(agentId: string, agentMap: Map<string, number>): string {
  if (!agentMap.has(agentId)) agentMap.set(agentId, agentMap.size);
  return AGENT_COLORS[agentMap.get(agentId)! % AGENT_COLORS.length]!;
}

type ViewMode = 'explore' | 'full';

export default function RelationGraph() {
  const [relations, setRelations] = useState<Relation[]>([]);
  const [creating, setCreating] = useState(false);
  const [newRel, setNewRel] = useState({ subject: '', predicate: '', object: '', confidence: 0.8 });
  const [predicateFilter, setPredicateFilter] = useState('');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [nodeMemories, setNodeMemories] = useState<any[]>([]);
  const [loadingMemories, setLoadingMemories] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.6);
  const [viewMode, setViewMode] = useState<ViewMode>('explore');
  const [searchQuery, setSearchQuery] = useState('');
  const [focusEntity, setFocusEntity] = useState<string | null>(null);
  const [expandDepth, setExpandDepth] = useState(1);
  const [tablePage, setTablePage] = useState(0);
  const tableLimit = 20;

  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const layoutRef = useRef<FA2Layout | null>(null);
  const agentColorMap = useRef(new Map<string, number>());
  const { t } = useI18n();

  const load = () => {
    listRelations({ limit: '500', include_expired: '1' }).then((data: Relation[]) => {
      setRelations(data);
    });
  };

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  // Derive data
  const predicates = [...new Set(relations.map(r => r.predicate))];

  const filteredRelations = useMemo(() => {
    let result = relations.filter(r => (r.confidence ?? 1) >= confidenceThreshold);
    if (predicateFilter) result = result.filter(r => r.predicate === predicateFilter);
    return result;
  }, [relations, predicateFilter, confidenceThreshold]);

  // Build node degree map
  const nodeDegree = useMemo(() => {
    const deg = new Map<string, number>();
    for (const r of filteredRelations) {
      deg.set(r.subject, (deg.get(r.subject) || 0) + 1);
      deg.set(r.object, (deg.get(r.object) || 0) + 1);
    }
    return deg;
  }, [filteredRelations]);

  // Entity suggestions for search
  const entitySuggestions = useMemo(() => {
    if (!searchQuery || searchQuery.length < 1) return [];
    const q = searchQuery.toLowerCase();
    return [...nodeDegree.entries()]
      .filter(([name]) => name.toLowerCase().includes(q))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, deg]) => ({ name, degree: deg }));
  }, [searchQuery, nodeDegree]);

  // Compute visible relations based on mode
  const visibleRelations = useMemo(() => {
    if (viewMode === 'full') return filteredRelations;
    if (!focusEntity) return [];

    // BFS expansion from focus entity
    const visited = new Set<string>([focusEntity]);
    const queue = [focusEntity];
    for (let depth = 0; depth < expandDepth; depth++) {
      const nextQueue: string[] = [];
      for (const entity of queue) {
        for (const r of filteredRelations) {
          if (r.subject === entity && !visited.has(r.object)) {
            visited.add(r.object);
            nextQueue.push(r.object);
          }
          if (r.object === entity && !visited.has(r.subject)) {
            visited.add(r.subject);
            nextQueue.push(r.subject);
          }
        }
      }
      queue.length = 0;
      queue.push(...nextQueue);
    }

    return filteredRelations.filter(r => visited.has(r.subject) && visited.has(r.object));
  }, [viewMode, focusEntity, expandDepth, filteredRelations]);

  // Focus on entity
  const handleFocusEntity = (name: string) => {
    setFocusEntity(name);
    setSelectedNode(name);
    setSearchQuery(name);
    loadNodeMemories(name);
  };

  // Handlers
  const handleCreate = async () => {
    await createRelation(newRel);
    setNewRel({ subject: '', predicate: '', object: '', confidence: 0.8 });
    setCreating(false);
    load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('relations.confirmDelete'))) return;
    await deleteRelation(id);
    load();
  };

  const loadNodeMemories = async (entityName: string) => {
    setLoadingMemories(true);
    try {
      const res = await search({ query: entityName, limit: 10, debug: false });
      setNodeMemories(res.results || []);
    } catch { setNodeMemories([]); }
    setLoadingMemories(false);
  };

  // ── Sigma.js rendering ──

  useEffect(() => {
    if (!containerRef.current) return;
    if (visibleRelations.length === 0) {
      // Clean up existing renderer
      if (rendererRef.current) { rendererRef.current.kill(); rendererRef.current = null; }
      if (layoutRef.current) { layoutRef.current.stop(); layoutRef.current.kill(); layoutRef.current = null; }
      if (graphRef.current) { graphRef.current = null; }
      return;
    }

    const graph = new Graph({ multi: true, type: 'directed' });
    graphRef.current = graph;

    // Compute degree within visible set
    const visDegree = new Map<string, number>();
    for (const r of visibleRelations) {
      visDegree.set(r.subject, (visDegree.get(r.subject) || 0) + 1);
      visDegree.set(r.object, (visDegree.get(r.object) || 0) + 1);
    }
    const maxDeg = Math.max(...visDegree.values(), 1);

    // Node agent: most frequent agent in connected edges
    const nodeAgent = new Map<string, Map<string, number>>();
    for (const r of visibleRelations) {
      for (const entity of [r.subject, r.object]) {
        if (!nodeAgent.has(entity)) nodeAgent.set(entity, new Map());
        const m = nodeAgent.get(entity)!;
        m.set(r.agent_id, (m.get(r.agent_id) || 0) + 1);
      }
    }
    const getNodeAgent = (name: string): string => {
      const m = nodeAgent.get(name);
      if (!m) return 'default';
      let best = 'default', bestCount = 0;
      for (const [a, c] of m) { if (c > bestCount) { best = a; bestCount = c; } }
      return best;
    };

    // Add nodes
    for (const [entity, deg] of visDegree) {
      const isFocus = entity === focusEntity;
      const size = isFocus ? 20 : 5 + (deg / maxDeg) * 15;
      const color = isFocus ? '#f59e0b' : getAgentColor(getNodeAgent(entity), agentColorMap.current);

      graph.addNode(entity, {
        label: entity,
        size,
        color,
        x: Math.random() * 100,
        y: Math.random() * 100,
      });
    }

    // Add edges
    for (const r of visibleRelations) {
      const conf = r.confidence ?? 0.5;
      graph.addEdge(r.subject, r.object, {
        label: r.predicate,
        size: 1 + conf * 2,
        color: `rgba(120, 120, 180, ${Math.max(0.3, conf * 0.6)})`,
        type: 'arrow',
      });
    }

    // Layout
    if (graph.order > 0) {
      const nodeCount = graph.order;
      forceAtlas2.assign(graph, {
        iterations: 80,
        settings: {
          gravity: nodeCount > 50 ? 2 : 1,
          scalingRatio: nodeCount > 50 ? 15 : 10,
          barnesHutOptimize: nodeCount > 50,
          strongGravityMode: true,
          slowDown: 5,
          linLogMode: true,
        },
      });
    }

    // Renderer
    const renderer = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: viewMode === 'explore' && visibleRelations.length < 80,
      defaultEdgeType: 'arrow',
      labelRenderedSizeThreshold: viewMode === 'explore' ? 4 : 10,
      labelSize: 13,
      labelWeight: 'bold',
      labelColor: { color: '#e2e8f0' },
      edgeLabelColor: { color: '#7c8194' },
      edgeLabelSize: 9,
      nodeReducer: (node, data) => {
        const res = { ...data };
        if (selectedNode && selectedNode !== focusEntity) {
          if (node === selectedNode) {
            res.highlighted = true;
            res.zIndex = 1;
          } else {
            const connected = visibleRelations.some(
              r => (r.subject === selectedNode && r.object === node) ||
                   (r.object === selectedNode && r.subject === node)
            );
            if (!connected && node !== focusEntity) {
              res.color = '#2a2e3a';
              res.label = '';
            }
          }
        }
        return res;
      },
      edgeReducer: (edge, data) => {
        const res = { ...data };
        if (selectedNode && selectedNode !== focusEntity) {
          const source = graph.source(edge);
          const target = graph.target(edge);
          if (source === selectedNode || target === selectedNode) {
            res.color = 'rgba(99, 102, 241, 0.9)';
            res.size = (data.size || 2) + 1;
          } else {
            res.hidden = true;
          }
        }
        return res;
      },
    });
    rendererRef.current = renderer;

    renderer.on('clickNode', ({ node }) => {
      setSelectedNode(prev => {
        if (prev === node) { setNodeMemories([]); return null; }
        loadNodeMemories(node);
        return node;
      });
    });

    renderer.on('doubleClickNode', ({ node }) => {
      // Double-click to expand: focus on this node
      handleFocusEntity(node);
    });

    renderer.on('clickStage', () => {
      setSelectedNode(null);
      setNodeMemories([]);
    });

    // Animated layout
    if (graph.order > 1) {
      if (layoutRef.current) { layoutRef.current.stop(); layoutRef.current.kill(); }
      const layout = new FA2Layout(graph, {
        settings: {
          gravity: graph.order > 50 ? 2 : 1,
          scalingRatio: graph.order > 50 ? 15 : 10,
          barnesHutOptimize: graph.order > 50,
          strongGravityMode: true,
          slowDown: 5,
          linLogMode: true,
        },
      });
      layout.start();
      layoutRef.current = layout;
      setTimeout(() => { layout.stop(); }, 3000);
    }

    return () => {
      if (layoutRef.current) { layoutRef.current.stop(); layoutRef.current.kill(); layoutRef.current = null; }
      renderer.kill();
      rendererRef.current = null;
      graphRef.current = null;
    };
  }, [visibleRelations, selectedNode, focusEntity, viewMode]);

  // Stats
  const visNodeSet = new Set<string>();
  visibleRelations.forEach(r => { visNodeSet.add(r.subject); visNodeSet.add(r.object); });
  const agentIds = [...new Set(relations.map(r => r.agent_id || 'default'))];

  // Top entities for quick access
  const topEntities = useMemo(() =>
    [...nodeDegree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  [nodeDegree]);

  const selectedRelations = selectedNode
    ? visibleRelations.filter(r => r.subject === selectedNode || r.object === selectedNode)
    : [];

  const sourceBadge = (source: string) => {
    const isExtraction = source === 'extraction' || source === 'flush';
    return (
      <span style={{
        fontSize: 10, padding: '1px 6px', borderRadius: 3,
        background: isExtraction ? 'rgba(34,197,94,0.15)' : 'rgba(99,102,241,0.15)',
        color: isExtraction ? '#22c55e' : '#818cf8', fontWeight: 500,
      }}>
        {isExtraction ? t('relations.sourceExtraction') : t('relations.sourceManual')}
      </span>
    );
  };

  return (
    <div>
      <h1 className="page-title">{t('relations.title')}</h1>

      {/* Top toolbar */}
      <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        {/* Mode toggle */}
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <button
            onClick={() => { setViewMode('explore'); if (!focusEntity && topEntities.length > 0) handleFocusEntity(topEntities[0]![0]); }}
            style={{
              padding: '4px 12px', fontSize: 12, border: 'none', cursor: 'pointer',
              background: viewMode === 'explore' ? 'var(--primary)' : 'transparent',
              color: viewMode === 'explore' ? '#fff' : 'var(--text-muted)',
            }}
          >🔍 Explorer</button>
          <button
            onClick={() => setViewMode('full')}
            style={{
              padding: '4px 12px', fontSize: 12, border: 'none', cursor: 'pointer',
              background: viewMode === 'full' ? 'var(--primary)' : 'transparent',
              color: viewMode === 'full' ? '#fff' : 'var(--text-muted)',
            }}
          >🌐 Full Graph</button>
        </div>

        {/* Search (explore mode) */}
        {viewMode === 'explore' && (
          <div style={{ position: 'relative', flex: '1 1 200px', maxWidth: 300 }}>
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search entity..."
              style={{ width: '100%', fontSize: 13, padding: '5px 10px' }}
              onKeyDown={e => {
                if (e.key === 'Enter' && entitySuggestions.length > 0) {
                  handleFocusEntity(entitySuggestions[0]!.name);
                }
              }}
            />
            {entitySuggestions.length > 0 && searchQuery !== focusEntity && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
                background: 'var(--bg-card, #1e1e2e)', border: '1px solid var(--border)',
                borderRadius: 6, marginTop: 2, overflow: 'hidden',
              }}>
                {entitySuggestions.map(s => (
                  <div
                    key={s.name}
                    onClick={() => handleFocusEntity(s.name)}
                    style={{
                      padding: '6px 12px', cursor: 'pointer', fontSize: 13,
                      display: 'flex', justifyContent: 'space-between',
                      borderBottom: '1px solid var(--border)',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.1)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span>{s.name}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{s.degree} edges</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Depth control (explore mode) */}
        {viewMode === 'explore' && focusEntity && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Depth:</span>
            {[1, 2, 3].map(d => (
              <button
                key={d}
                onClick={() => setExpandDepth(d)}
                style={{
                  width: 26, height: 26, borderRadius: 4, border: 'none', cursor: 'pointer',
                  fontSize: 12, fontWeight: 600,
                  background: expandDepth === d ? 'var(--primary)' : 'rgba(100,100,140,0.2)',
                  color: expandDepth === d ? '#fff' : 'var(--text-muted)',
                }}
              >{d}</button>
            ))}
          </div>
        )}

        {predicates.length > 0 && (
          <select value={predicateFilter} onChange={e => { setPredicateFilter(e.target.value); setTablePage(0); }} style={{ fontSize: 12 }}>
            <option value="">All ({predicates.length})</option>
            {predicates.map(p => (
              <option key={p} value={p}>{p} ({relations.filter(r => r.predicate === p).length})</option>
            ))}
          </select>
        )}

        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {visNodeSet.size} nodes · {visibleRelations.length} edges
          {viewMode === 'full' && ` / ${nodeDegree.size} total`}
        </span>

        <div style={{ flex: 1 }} />
        <button className="btn" onClick={load} style={{ fontSize: 11, padding: '3px 8px' }}>↻</button>
        <button className="btn primary" onClick={() => setCreating(true)} style={{ fontSize: 12 }}>+ New</button>
      </div>

      {/* Quick entities (explore mode) */}
      {viewMode === 'explore' && !focusEntity && topEntities.length > 0 && (
        <div style={{ margin: '12px 0', padding: '12px 16px', background: 'var(--bg-card, rgba(30,30,50,0.5))', borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Top entities — click to explore</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {topEntities.map(([name, deg]) => (
              <button
                key={name}
                onClick={() => handleFocusEntity(name)}
                style={{
                  padding: '4px 12px', borderRadius: 16, fontSize: 12, cursor: 'pointer',
                  background: 'rgba(99,102,241,0.15)', color: '#818cf8',
                  border: '1px solid rgba(99,102,241,0.3)',
                }}
              >
                {name} <span style={{ opacity: 0.6 }}>({deg})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Confidence slider + legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '8px 0 12px', padding: '8px 12px', background: 'var(--bg-card, rgba(30,30,50,0.5))', borderRadius: 'var(--radius)', fontSize: 13 }}>
        <label style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', fontSize: 12 }}>
          Conf ≥ {confidenceThreshold.toFixed(2)}
        </label>
        <input type="range" min="0" max="1" step="0.05" value={confidenceThreshold}
          onChange={e => setConfidenceThreshold(parseFloat(e.target.value))} style={{ flex: 1, maxWidth: 200 }} />
        {agentIds.length > 1 && (
          <div style={{ display: 'flex', gap: 8, marginLeft: 8, flexWrap: 'wrap' }}>
            {agentIds.slice(0, 6).map(aid => (
              <span key={aid} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: getAgentColor(aid, agentColorMap.current), display: 'inline-block' }} />
                <span style={{ color: 'var(--text-muted)' }}>{aid.length > 10 ? aid.slice(0, 9) + '…' : aid}</span>
              </span>
            ))}
            {focusEntity && <span style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
              <span style={{ color: '#f59e0b' }}>focus</span>
            </span>}
          </div>
        )}
      </div>

      {/* Graph */}
      {visibleRelations.length > 0 ? (
        <div className="card" style={{ marginBottom: 16, position: 'relative' }}>
          <div ref={containerRef} style={{ height: 'calc(100vh - 280px)', minHeight: 400, background: '#0f0f1a', borderRadius: 8 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
            <span>Click node to highlight · Double-click to explore · Scroll to zoom · Drag to pan</span>
            {focusEntity && <span>Exploring: <strong style={{ color: '#f59e0b' }}>{focusEntity}</strong> (depth {expandDepth})</span>}
          </div>
        </div>
      ) : viewMode === 'explore' && !focusEntity ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🕸️</div>
          <div style={{ fontSize: 15, color: 'var(--text-muted)' }}>Search for an entity or click one above to start exploring</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 40, textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 15, color: 'var(--text-muted)' }}>No relations match current filters</div>
        </div>
      )}

      {/* Selected node panel */}
      {selectedNode && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>📍 {selectedNode}</h3>
            <div style={{ display: 'flex', gap: 6 }}>
              {selectedNode !== focusEntity && (
                <button className="btn" onClick={() => handleFocusEntity(selectedNode)} style={{ fontSize: 11 }}>
                  🔍 Explore this
                </button>
              )}
              <button className="btn" onClick={() => { setSelectedNode(null); setNodeMemories([]); }} style={{ fontSize: 11 }}>✕</button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Connections */}
            <div>
              <h4 style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                Connections ({selectedRelations.length})
              </h4>
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                {selectedRelations.map(r => {
                  const other = r.subject === selectedNode ? r.object : r.subject;
                  const direction = r.subject === selectedNode ? '→' : '←';
                  return (
                    <div key={r.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0',
                      borderBottom: '1px solid var(--border)', fontSize: 12,
                    }}>
                      <span style={{ color: '#818cf8', minWidth: 60, fontSize: 11 }}>{r.predicate}</span>
                      <span>{direction}</span>
                      <span
                        style={{ cursor: 'pointer', color: 'var(--primary)', fontWeight: 500 }}
                        onClick={() => handleFocusEntity(other)}
                      >{other}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>
                        {r.confidence?.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Related memories */}
            <div>
              <h4 style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Related Memories</h4>
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                {loadingMemories ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{t('common.loading')}</div>
                ) : nodeMemories.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No memories found</div>
                ) : (
                  nodeMemories.slice(0, 5).map((m: any) => (
                    <div key={m.id} style={{ padding: 8, marginBottom: 4, background: 'rgba(99,102,241,0.05)', borderRadius: 6, fontSize: 12 }}>
                      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                        <span className={`badge ${m.layer}`} style={{ fontSize: 10 }}>{m.layer}</span>
                        <span className="badge" style={{ fontSize: 10, background: 'rgba(59,130,246,0.2)', color: '#60a5fa' }}>{m.category}</span>
                      </div>
                      <div style={{ color: 'var(--text)' }}>{m.content?.slice(0, 120)}{m.content?.length > 120 ? '…' : ''}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Relation table */}
      {(viewMode === 'full' || focusEntity) && visibleRelations.length > 0 && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 600 }}>
            <thead>
              <tr>
                <th>Subject</th><th>Predicate</th><th>Object</th>
                <th>Conf</th><th>Source</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visibleRelations.slice(tablePage * tableLimit, (tablePage + 1) * tableLimit).map(r => (
                <tr key={r.id}>
                  <td style={{ cursor: 'pointer', color: 'var(--primary)' }}
                    onClick={() => handleFocusEntity(r.subject)}>{r.subject}</td>
                  <td style={{ fontSize: 12, color: '#818cf8' }}>{r.predicate}</td>
                  <td style={{ cursor: 'pointer', color: 'var(--primary)' }}
                    onClick={() => handleFocusEntity(r.object)}>{r.object}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <div style={{ width: 32, height: 3, background: 'var(--border)', borderRadius: 2 }}>
                        <div style={{ width: `${(r.confidence ?? 0) * 100}%`, height: '100%', background: 'var(--primary)', borderRadius: 2 }} />
                      </div>
                      <span style={{ fontSize: 11 }}>{r.confidence?.toFixed(2)}</span>
                    </div>
                  </td>
                  <td>{sourceBadge(r.source)}</td>
                  <td><button className="btn danger" onClick={() => handleDelete(r.id)} style={{ fontSize: 10, padding: '2px 6px' }}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleRelations.length > tableLimit && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 }}>
              <button className="btn" disabled={tablePage === 0} onClick={() => setTablePage(p => p - 1)}>←</button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 12px' }}>
                {tablePage + 1} / {Math.ceil(visibleRelations.length / tableLimit)}
              </span>
              <button className="btn" disabled={(tablePage + 1) * tableLimit >= visibleRelations.length}
                onClick={() => setTablePage(p => p + 1)}>→</button>
            </div>
          )}
        </div>
      )}

      {/* Create modal */}
      {creating && (
        <div className="modal-overlay" onClick={() => setCreating(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{t('relations.newRelationTitle')}</h2>
            <div className="form-group">
              <label>Subject</label>
              <input value={newRel.subject} onChange={e => setNewRel({ ...newRel, subject: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Predicate</label>
              <input value={newRel.predicate} onChange={e => setNewRel({ ...newRel, predicate: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Object</label>
              <input value={newRel.object} onChange={e => setNewRel({ ...newRel, object: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Confidence ({newRel.confidence.toFixed(2)})</label>
              <input type="range" min="0" max="1" step="0.05" value={newRel.confidence}
                onChange={e => setNewRel({ ...newRel, confidence: parseFloat(e.target.value) })} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn primary" onClick={handleCreate}
                disabled={!newRel.subject || !newRel.predicate || !newRel.object}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
