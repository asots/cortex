import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { listRelations, createRelation, deleteRelation, search, findPath } from '../api/client.js';
import { useI18n } from '../i18n/index.js';
import { toLocal } from '../utils/time.js';
import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import louvain from 'graphology-communities-louvain';

// Draw a dark pill-shaped label
function drawPillLabel(
  context: CanvasRenderingContext2D,
  x: number, y: number,
  label: string,
  fontSize: number,
  fontWeight: string,
  bgColor: string,
  borderColor: string,
  textColor: string,
): void {
  const font = `${fontWeight} ${fontSize}px "Inter", "SF Pro", -apple-system, sans-serif`;
  context.font = font;

  const textWidth = context.measureText(label).width;
  const padding = 6;
  const bgHeight = fontSize + 8;
  const bgWidth = textWidth + padding * 2;
  const top = y - bgHeight / 2;
  const radius = bgHeight / 2;

  // Pill background
  context.fillStyle = bgColor;
  context.beginPath();
  context.moveTo(x + radius, top);
  context.lineTo(x + bgWidth - radius, top);
  context.arc(x + bgWidth - radius, top + radius, radius, -Math.PI / 2, Math.PI / 2);
  context.lineTo(x + radius, top + bgHeight);
  context.arc(x + radius, top + radius, radius, Math.PI / 2, -Math.PI / 2);
  context.closePath();
  context.fill();

  // Border
  context.strokeStyle = borderColor;
  context.lineWidth = 0.5;
  context.stroke();

  // Text
  context.fillStyle = textColor;
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(label, x + padding, y + 1);
}

// Custom label renderer
function drawCustomLabel(
  context: CanvasRenderingContext2D,
  data: any,
  settings: any,
): void {
  if (!data.label) return;
  const size = settings.labelSize || 12;
  const x = data.x + data.size + 4;
  drawPillLabel(context, x, data.y, data.label, size, '600',
    'rgba(15, 15, 30, 0.85)', 'rgba(99, 102, 241, 0.25)', '#e2e8f0');
}

// Custom edge label — always horizontal, dark pill background, never upside-down
function drawCustomEdgeLabel(
  context: CanvasRenderingContext2D,
  edgeData: any,
  sourceData: any,
  targetData: any,
  settings: any,
): void {
  if (!edgeData.label) return;

  const size = settings.edgeLabelSize || 10;
  const midX = (sourceData.x + targetData.x) / 2;
  const midY = (sourceData.y + targetData.y) / 2;

  // Measure text to center the pill
  const font = `500 ${size}px "Inter", "SF Pro", -apple-system, sans-serif`;
  context.font = font;
  const textWidth = context.measureText(edgeData.label).width;
  const pillWidth = textWidth + 12;

  drawPillLabel(context, midX - pillWidth / 2, midY, edgeData.label, size, '500',
    'rgba(15, 15, 30, 0.9)', 'rgba(129, 140, 248, 0.3)', '#a5b4fc');
}

// Custom hover label renderer — same style but slightly brighter
function drawCustomHover(
  context: CanvasRenderingContext2D,
  data: any,
  settings: any,
): void {
  // Draw the node circle with glow
  context.beginPath();
  context.arc(data.x, data.y, data.size + 2, 0, Math.PI * 2);
  context.fillStyle = 'rgba(99, 102, 241, 0.15)';
  context.fill();
  context.closePath();

  // Draw the node itself
  context.beginPath();
  context.arc(data.x, data.y, data.size, 0, Math.PI * 2);
  context.fillStyle = data.color;
  context.fill();
  context.closePath();

  // Label
  if (!data.label) return;
  const size = (settings.labelSize || 12) + 1;
  const x = data.x + data.size + 4;
  drawPillLabel(context, x, data.y, data.label, size, '700',
    'rgba(15, 15, 35, 0.92)', 'rgba(99, 102, 241, 0.4)', '#f1f5f9');
}

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

type ViewMode = 'explore' | 'full' | 'communities';

// Community colors — distinct, saturated
const COMMUNITY_COLORS = [
  '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#3b82f6',
  '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#06b6d4',
  '#84cc16', '#e11d48', '#0ea5e9', '#a855f7', '#10b981',
  '#fb923c', '#38bdf8', '#c084fc', '#4ade80', '#fbbf24',
];

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
  const [expandedCommunity, setExpandedCommunity] = useState<number | null>(null);
  const [pathFrom, setPathFrom] = useState('');
  const [pathTo, setPathTo] = useState('');
  const [pathResult, setPathResult] = useState<{ entity: string; predicate?: string }[] | null>(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [showPathPanel, setShowPathPanel] = useState(false);
  const [tablePage, setTablePage] = useState(0);
  const tableLimit = 20;

  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);

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

  // Edge colors by predicate type
  const predicateColors = useMemo(() => {
    const PRED_PALETTE: Record<string, string> = {
      'uses': '#3b82f6',      // blue
      'owns': '#22c55e',      // green
      'manages': '#f59e0b',   // amber
      'created': '#8b5cf6',   // purple
      'belongs_to': '#06b6d4', // cyan
      'interested_in': '#ec4899', // pink
      'prefers': '#f97316',   // orange
      'works_at': '#14b8a6',  // teal
      'lives_in': '#84cc16',  // lime
      'not_uses': '#ef4444',  // red
      'related_to': '#64748b', // slate
    };
    const map = new Map<string, string>();
    for (const r of relations) {
      const pred = r.predicate.toLowerCase().replace(/\s+/g, '_');
      if (!map.has(r.predicate)) {
        map.set(r.predicate, PRED_PALETTE[pred] || PRED_PALETTE[pred.replace(/_/g, ' ')] || '#64748b');
      }
    }
    return map;
  }, [relations]);

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

  // Max neighbors per node in explore mode (prevents starburst)
  const MAX_NEIGHBORS = 25;

  // Community detection for full graph
  const communities = useMemo(() => {
    if (filteredRelations.length === 0) return { assignments: new Map<string, number>(), groups: new Map<number, string[]>() };

    const g = new Graph({ multi: false, type: 'undirected' });
    for (const r of filteredRelations) {
      if (!g.hasNode(r.subject)) g.addNode(r.subject);
      if (!g.hasNode(r.object)) g.addNode(r.object);
      if (!g.hasEdge(r.subject, r.object)) g.addEdge(r.subject, r.object);
    }

    let assignments: Record<string, number> = {};
    try {
      assignments = louvain(g, { resolution: 1.2 });
    } catch {
      // Fallback: all in one community
      g.forEachNode(n => { assignments[n] = 0; });
    }

    const assignMap = new Map<string, number>();
    const groups = new Map<number, string[]>();
    for (const [entity, community] of Object.entries(assignments)) {
      assignMap.set(entity, community);
      if (!groups.has(community)) groups.set(community, []);
      groups.get(community)!.push(entity);
    }

    // Sort each group: highest degree first
    for (const [, members] of groups) {
      members.sort((a, b) => (nodeDegree.get(b) || 0) - (nodeDegree.get(a) || 0));
    }

    return { assignments: assignMap, groups };
  }, [filteredRelations, nodeDegree]);

  // Compute visible relations based on mode
  const visibleRelations = useMemo(() => {
    if (viewMode === 'full') return filteredRelations;

    // Communities mode: show aggregated super-nodes, or expanded community
    if (viewMode === 'communities') {
      if (expandedCommunity !== null) {
        // Show only edges within or touching this community
        const members = new Set(communities.groups.get(expandedCommunity) || []);
        return filteredRelations.filter(r => members.has(r.subject) || members.has(r.object));
      }
      // Super-node mode: handled in rendering
      return filteredRelations;
    }

    if (!focusEntity) return [];

    // BFS expansion with per-node neighbor limit
    const visited = new Set<string>([focusEntity]);
    const queue = [focusEntity];

    for (let depth = 0; depth < expandDepth; depth++) {
      const nextQueue: string[] = [];
      for (const entity of queue) {
        // Gather all candidate neighbors with their confidence
        const candidates: { entity: string; confidence: number }[] = [];
        for (const r of filteredRelations) {
          if (r.subject === entity && !visited.has(r.object)) {
            candidates.push({ entity: r.object, confidence: r.confidence ?? 0.5 });
          }
          if (r.object === entity && !visited.has(r.subject)) {
            candidates.push({ entity: r.subject, confidence: r.confidence ?? 0.5 });
          }
        }
        // Sort by confidence descending, take top N
        candidates.sort((a, b) => b.confidence - a.confidence);
        const limited = candidates.slice(0, MAX_NEIGHBORS);
        for (const c of limited) {
          if (!visited.has(c.entity)) {
            visited.add(c.entity);
            nextQueue.push(c.entity);
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

  // Path query
  const handlePathQuery = async () => {
    if (!pathFrom || !pathTo) return;
    setPathLoading(true);
    try {
      const res = await findPath(pathFrom, pathTo);
      setPathResult(res.path || []);
      // Switch to full view to see the path
      if (res.path?.length > 0) {
        setViewMode('full');
      }
    } catch { setPathResult([]); }
    setPathLoading(false);
  };

  // Entities on the current path (for highlighting)
  const pathEntities = useMemo(() => {
    if (!pathResult) return new Set<string>();
    return new Set(pathResult.filter((p: any) => p.entity).map((p: any) => p.entity));
  }, [pathResult]);

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

    // Communities super-node mode
    if (viewMode === 'communities' && expandedCommunity === null && communities.groups.size > 0) {
      const graph = new Graph({ multi: true, type: 'directed' });
      graphRef.current = graph;

      // Create super-nodes for each community
      const sortedGroups = [...communities.groups.entries()]
        .sort((a, b) => b[1].length - a[1].length);

      for (const [communityId, members] of sortedGroups) {
        const color = COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length]!;
        const top3 = members.slice(0, 3).join(', ');
        const label = members.length <= 3 ? top3 : `${top3} +${members.length - 3}`;
        const size = 8 + Math.sqrt(members.length) * 6;
        graph.addNode(`community_${communityId}`, {
          label,
          size,
          color,
          x: Math.random() * 100,
          y: Math.random() * 100,
          communityId,
        });
      }

      // Count inter-community edges
      const interEdges = new Map<string, number>();
      for (const r of filteredRelations) {
        const c1 = communities.assignments.get(r.subject);
        const c2 = communities.assignments.get(r.object);
        if (c1 !== undefined && c2 !== undefined && c1 !== c2) {
          const key = c1 < c2 ? `${c1}_${c2}` : `${c2}_${c1}`;
          interEdges.set(key, (interEdges.get(key) || 0) + 1);
        }
      }

      for (const [key, count] of interEdges) {
        const [c1, c2] = key.split('_');
        const n1 = `community_${c1}`;
        const n2 = `community_${c2}`;
        if (graph.hasNode(n1) && graph.hasNode(n2)) {
          graph.addEdge(n1, n2, {
            size: 1 + Math.log(count + 1),
            color: 'rgba(120, 120, 180, 0.3)',
            label: `${count}`,
          });
        }
      }

      // Layout
      if (graph.order > 0) {
        forceAtlas2.assign(graph, {
          iterations: 200,
          settings: { gravity: 2, scalingRatio: 30, strongGravityMode: true, linLogMode: true },
        });
      }

      const renderer = new Sigma(graph, containerRef.current, {
        renderEdgeLabels: true,
        defaultEdgeType: 'arrow',
        labelRenderedSizeThreshold: 0,
        labelSize: 11,
        labelWeight: '600',
        labelColor: { color: '#e2e8f0' },
        edgeLabelColor: { color: '#7c8194' },
        edgeLabelSize: 9,
        defaultDrawNodeLabel: drawCustomLabel,
        defaultDrawNodeHover: drawCustomHover,
        defaultDrawEdgeLabel: drawCustomEdgeLabel,
      });
      rendererRef.current = renderer;

      // Click to expand community
      renderer.on('clickNode', ({ node }) => {
        const attrs = graph.getNodeAttributes(node);
        if (attrs.communityId !== undefined) {
          setExpandedCommunity(attrs.communityId);
        }
      });

      return () => { renderer.kill(); rendererRef.current = null; graphRef.current = null; };
    }

    if (visibleRelations.length === 0) {
      if (rendererRef.current) { rendererRef.current.kill(); rendererRef.current = null; }
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
      // In communities mode: color by community. Otherwise: color by agent.
      const communityId = communities.assignments.get(entity);
      const color = isFocus ? '#f59e0b'
        : (viewMode === 'communities' && communityId !== undefined)
          ? COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length]!
          : getAgentColor(getNodeAgent(entity), agentColorMap.current);

      graph.addNode(entity, {
        label: entity,
        size,
        color,
        x: Math.random() * 100,
        y: Math.random() * 100,
      });
    }

    // Add edges — thinner, softer, colored by predicate type
    for (const r of visibleRelations) {
      const conf = r.confidence ?? 0.5;
      const predColor = predicateColors.get(r.predicate) || '#64748b';
      const hex = predColor;
      const rr = parseInt(hex.slice(1, 3), 16);
      const gg = parseInt(hex.slice(3, 5), 16);
      const bb = parseInt(hex.slice(5, 7), 16);
      const alpha = Math.max(0.15, conf * 0.4);

      graph.addEdge(r.subject, r.object, {
        label: r.predicate,
        size: 0.5 + conf * 1,
        color: `rgba(${rr}, ${gg}, ${bb}, ${alpha})`,
        type: 'arrow',
      });
    }

    // Static layout — high iteration count for stable result, no jitter
    if (graph.order > 0) {
      const nodeCount = graph.order;
      forceAtlas2.assign(graph, {
        iterations: 300,
        settings: {
          gravity: 3,
          scalingRatio: nodeCount > 30 ? 20 : 12,
          barnesHutOptimize: nodeCount > 30,
          strongGravityMode: true,
          slowDown: 10,
          linLogMode: true,
          adjustSizes: true,
        },
      });
    }

    // Track hovered node for dynamic label display
    let hoveredNode: string | null = null;

    // Renderer
    const renderer = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: true,
      defaultEdgeType: 'arrow',
      labelRenderedSizeThreshold: 0, // Let nodeReducer fully control label visibility
      labelSize: 12,
      labelWeight: '600',
      labelColor: { color: '#e2e8f0' },
      edgeLabelColor: { color: '#a5b4fc' },
      edgeLabelSize: 11,
      defaultDrawNodeLabel: drawCustomLabel,
        defaultDrawNodeHover: drawCustomHover,
        defaultDrawEdgeLabel: drawCustomEdgeLabel,
      nodeReducer: (node, data) => {
        const res = { ...data };
        const deg = visDegree.get(node) || 0;
        const isFocus = node === focusEntity;
        const isSelected = node === selectedNode;
        const isHovered = node === hoveredNode;

        const isOnPath = pathEntities.has(node);

        // Label visibility: show for focus, selected, hovered, path, or high-degree
        const showLabel = isFocus || isSelected || isHovered || isOnPath || deg >= 8;
        if (!showLabel) {
          res.label = '';
        }

        // When a node is selected: only show selected + its neighbors
        if (selectedNode) {
          const isConnected = visibleRelations.some(
            r => (r.subject === selectedNode && r.object === node) ||
                 (r.object === selectedNode && r.subject === node)
          );
          if (isSelected) {
            res.highlighted = true;
            res.zIndex = 1;
            res.label = data.label;
            res.color = '#f59e0b'; // Gold for selected
            res.size = (data.size || 8) + 4;
          } else if (isConnected) {
            res.label = data.label; // Show neighbor labels
            res.size = (data.size || 5) + 2;
          } else {
            res.hidden = true; // Completely hide unrelated nodes
          }
        }

        // Path highlight
        if (pathEntities.size > 0 && !selectedNode) {
          if (isOnPath) {
            res.color = '#f59e0b';
            res.size = (data.size || 8) + 4;
            res.label = data.label;
            res.zIndex = 1;
          } else {
            res.color = 'rgba(42, 46, 58, 0.3)';
            res.label = '';
          }
        }

        // Hovered node: show only hovered + neighbors, hide rest
        if (hoveredNode && !selectedNode && pathEntities.size === 0) {
          const isConnectedToHover = visibleRelations.some(
            r => (r.subject === hoveredNode && r.object === node) ||
                 (r.object === hoveredNode && r.subject === node)
          );
          if (isHovered) {
            res.highlighted = true;
            res.label = data.label;
            res.size = (data.size || 8) + 3;
          } else if (isConnectedToHover) {
            res.label = data.label;
            res.size = (data.size || 5) + 1;
          } else {
            res.hidden = true;
          }
        }

        return res;
      },
      edgeReducer: (edge, data) => {
        const res = { ...data };
        const source = graph.source(edge);
        const target = graph.target(edge);

        // Default: hide edge labels (too noisy when all visible)
        res.label = '';

        if (pathEntities.size > 0 && !selectedNode) {
          if (pathEntities.has(source) && pathEntities.has(target)) {
            res.color = 'rgba(245, 158, 11, 0.8)';
            res.size = 1.5;
            res.label = data.label; // Show predicate on path
          } else {
            res.color = 'rgba(100, 100, 140, 0.03)';
          }
        } else if (selectedNode) {
          if (source === selectedNode || target === selectedNode) {
            res.color = 'rgba(129, 140, 248, 0.7)';
            res.size = 1.2;
            res.label = data.label; // Show predicate on selected edges
          } else {
            res.hidden = true;
          }
        } else if (hoveredNode) {
          if (source === hoveredNode || target === hoveredNode) {
            res.color = 'rgba(167, 139, 250, 0.85)';
            res.size = 1.5;
            res.zIndex = 1;
            res.label = data.label; // Show predicate on hover edges
          } else {
            res.hidden = true;
          }
        }

        return res;
      },
    });

    // Hover events for dynamic label display
    renderer.on('enterNode', ({ node }) => {
      hoveredNode = node;
      renderer.refresh();
    });
    renderer.on('leaveNode', () => {
      hoveredNode = null;
      renderer.refresh();
    });
    rendererRef.current = renderer;

    renderer.on('clickNode', ({ node }) => {
      // Fly camera to clicked node
      const nodePos = graph.getNodeAttributes(node);
      renderer.getCamera().animate(
        { x: nodePos.x, y: nodePos.y, ratio: 0.3 },
        { duration: 400 }
      );

      setSelectedNode(prev => {
        if (prev === node) { setNodeMemories([]); return null; }
        loadNodeMemories(node);
        return node;
      });
    });

    renderer.on('doubleClickNode', ({ node }) => {
      handleFocusEntity(node);
    });

    renderer.on('clickStage', () => {
      setSelectedNode(null);
      setNodeMemories([]);
      // Reset camera to show full graph
      renderer.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 300 });
    });

    // Static layout only — no animated worker (prevents jitter)
    // The sync forceAtlas2.assign above already computed positions

    return () => {
      renderer.kill();
      rendererRef.current = null;
      graphRef.current = null;
    };
  }, [visibleRelations, selectedNode, focusEntity, viewMode, communities, expandedCommunity]);

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
          {([
            { mode: 'explore' as ViewMode, icon: '🔍', label: 'Explorer' },
            { mode: 'communities' as ViewMode, icon: '🫧', label: 'Communities' },
            { mode: 'full' as ViewMode, icon: '🌐', label: 'Full' },
          ]).map(({ mode, icon, label }) => (
            <button
              key={mode}
              onClick={() => { setViewMode(mode); setExpandedCommunity(null); if (mode === 'explore' && !focusEntity && topEntities.length > 0) handleFocusEntity(topEntities[0]![0]); }}
              style={{
                padding: '4px 12px', fontSize: 12, border: 'none', cursor: 'pointer',
                background: viewMode === mode ? 'var(--primary)' : 'transparent',
                color: viewMode === mode ? '#fff' : 'var(--text-muted)',
              }}
            >{icon} {label}</button>
          ))}
        </div>

        {/* Back button for expanded community */}
        {viewMode === 'communities' && expandedCommunity !== null && (
          <button className="btn" onClick={() => setExpandedCommunity(null)} style={{ fontSize: 12 }}>
            ← Back to communities
          </button>
        )}

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
        <button className="btn" onClick={() => setShowPathPanel(!showPathPanel)} style={{ fontSize: 12 }}>
          🛤️ Path
        </button>
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
        {/* Edge type legend */}
        {predicateColors.size > 0 && (
          <div style={{ display: 'flex', gap: 8, marginLeft: 8, flexWrap: 'wrap' }}>
            {[...predicateColors.entries()].slice(0, 6).map(([pred, color]) => (
              <span key={pred} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10 }}>
                <span style={{ width: 12, height: 2, background: color, display: 'inline-block', borderRadius: 1 }} />
                <span style={{ color: 'var(--text-muted)' }}>{pred}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Path query panel */}
      {showPathPanel && (
        <div style={{ margin: '8px 0 12px', padding: '12px 16px', background: 'var(--bg-card, rgba(30,30,50,0.5))', borderRadius: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>🛤️ Shortest Path:</span>
          <input
            value={pathFrom}
            onChange={e => setPathFrom(e.target.value)}
            placeholder="From entity..."
            style={{ flex: '1 1 120px', maxWidth: 180, fontSize: 12, padding: '4px 8px' }}
          />
          <span style={{ color: 'var(--text-muted)' }}>→</span>
          <input
            value={pathTo}
            onChange={e => setPathTo(e.target.value)}
            placeholder="To entity..."
            style={{ flex: '1 1 120px', maxWidth: 180, fontSize: 12, padding: '4px 8px' }}
          />
          <button className="btn primary" onClick={handlePathQuery} disabled={pathLoading || !pathFrom || !pathTo} style={{ fontSize: 12 }}>
            {pathLoading ? '...' : 'Find'}
          </button>
          {pathResult && pathResult.length > 0 && (
            <button className="btn" onClick={() => { setPathResult(null); setPathFrom(''); setPathTo(''); }} style={{ fontSize: 11 }}>✕ Clear</button>
          )}
          {pathResult && pathResult.length > 0 && (
            <div style={{ width: '100%', marginTop: 6, fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              {pathResult.map((p: any, i: number) => (
                <span key={i} style={{
                  padding: '2px 8px', borderRadius: 4, fontSize: 11,
                  background: p.entity ? 'rgba(245, 158, 11, 0.2)' : 'transparent',
                  color: p.entity ? '#f59e0b' : '#818cf8',
                  fontWeight: p.entity ? 600 : 400,
                  cursor: p.entity ? 'pointer' : 'default',
                }} onClick={() => p.entity && handleFocusEntity(p.entity)}>
                  {p.entity || `→ ${p.predicate} →`}
                </span>
              ))}
            </div>
          )}
          {pathResult && pathResult.length === 0 && (
            <span style={{ fontSize: 12, color: '#ef4444' }}>No path found</span>
          )}
        </div>
      )}

      {/* Graph */}
      {visibleRelations.length > 0 ? (
        <div className="card" style={{ marginBottom: 16, position: 'relative' }}>
          <div ref={containerRef} style={{ height: 'calc(100vh - 280px)', minHeight: 400, background: '#0f0f1a', borderRadius: 8 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
            <span>Click node to focus · Click empty area to reset · Double-click to explore · Scroll to zoom</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {focusEntity && <span>Exploring: <strong style={{ color: '#f59e0b' }}>{focusEntity}</strong> (depth {expandDepth})</span>}
              {(selectedNode || (rendererRef.current && rendererRef.current.getCamera().ratio < 0.9)) && (
                <button className="btn" onClick={() => {
                  setSelectedNode(null);
                  setNodeMemories([]);
                  if (rendererRef.current) {
                    rendererRef.current.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 300 });
                  }
                }} style={{ fontSize: 10, padding: '2px 8px' }}>
                  ↺ Reset View
                </button>
              )}
            </div>
          </div>
        </div>
      ) : viewMode === 'communities' && expandedCommunity === null ? (
        null /* Communities super-node graph handles its own rendering */
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
