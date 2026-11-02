import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RotateCcw, Share2 } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';
import { api } from '../../api/client';

type GraphNode = {
  id: string;
  name: string;
  code?: string;
  type_key?: string;
  type?: string;
};

type GraphEdge = {
  id: string;
  from_id: string;
  to_id: string;
  relation_code: string;
};

const RELATION_LABELS: Record<string, string> = {
  CONTAINS: 'contains',
  PART_OF: 'part of',
  INSTALLED_AT: 'runs on',
  MONITORED_BY: 'collected via',
  CONNECTED_TO: 'connected to',
  FEEDS: 'feeds',
};

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'PART_OF,CONTAINS', label: 'Part of' },
  { key: 'MONITORED_BY,CONNECTED_TO', label: 'Collected via' },
  { key: 'INSTALLED_AT', label: 'Runs on' },
];

function relationLabel(code: string): string {
  return RELATION_LABELS[code] || code.replace(/_/g, ' ').toLowerCase();
}

export const KnowledgeGraphPage: React.FC = () => {
  const { resources, selectedResourceId, setSelectedResourceId } = useApp();
  const [depth, setDepth] = useState<1 | 2>(1);
  const [filterKey, setFilterKey] = useState('all');
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState('');

  const centerId =
    selectedResourceId ||
    resources.find((r) => r.type === 'machine')?.id ||
    resources[0]?.id ||
    '';

  const loadGraph = useCallback(async () => {
    if (!centerId) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const relationTypes = filterKey === 'all' ? '' : filterKey;
      const qs = new URLSearchParams({
        resource_id: centerId,
        depth: String(depth),
      });
      if (relationTypes) qs.set('relation_types', relationTypes);
      const page = await api<{ nodes: GraphNode[]; edges: GraphEdge[] }>(
        `/api/v1/graph/neighbors?${qs.toString()}`,
      );
      setNodes(page.nodes || []);
      setEdges(page.edges || []);
      setSelectedNodeId(centerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load graph');
      setNodes([]);
      setEdges([]);
    } finally {
      setLoading(false);
    }
  }, [centerId, depth, filterKey]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  const center = nodes.find((n) => n.id === centerId) || nodes[0];
  const others = nodes.filter((n) => n.id !== centerId);

  const layout = useMemo(() => {
    const cx = 320;
    const cy = 240;
    const positions = new Map<string, { x: number; y: number }>();
    if (center) positions.set(center.id, { x: cx, y: cy });
    const radius = depth === 1 ? 160 : 200;
    others.forEach((node, index) => {
      const angle = (2 * Math.PI * index) / Math.max(others.length, 1) - Math.PI / 2;
      positions.set(node.id, {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    });
    return positions;
  }, [center, others, depth]);

  const selected =
    nodes.find((n) => n.id === selectedNodeId) ||
    center ||
    null;

  const neighborEdges = edges.filter(
    (e) => e.from_id === selectedNodeId || e.to_id === selectedNodeId,
  );

  if (!resources.length) {
    return (
      <div className="space-y-3">
        <h1 className="fx-page-title">Knowledge graph</h1>
        <p className="fx-page-subtitle">
          The graph is drawn from the factory model. Create an enterprise and its children first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Knowledge graph</h1>
          <p className="fx-page-subtitle">
            Neighbors from the model API — part of, collected via, runs on.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button variant="secondary" icon={<RotateCcw className="w-4 h-4" />} onClick={() => void loadGraph()}>
            Reload
          </Button>
        </div>
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-[12px] font-bold text-[#657794] uppercase tracking-wider">Depth</span>
            <div className="bg-[#F1F5FA] p-1 rounded-lg flex items-center border border-[#D4DFEC]">
              <button
                type="button"
                onClick={() => setDepth(1)}
                className={`px-3 py-1 rounded-md text-[12px] font-bold ${
                  depth === 1 ? 'bg-white text-[#EF1B24] shadow-sm' : 'text-[#657794]'
                }`}
              >
                1 hop
              </button>
              <button
                type="button"
                onClick={() => setDepth(2)}
                className={`px-3 py-1 rounded-md text-[12px] font-bold ${
                  depth === 2 ? 'bg-white text-[#EF1B24] shadow-sm' : 'text-[#657794]'
                }`}
              >
                2 hops
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[12px] flex-wrap">
            <span className="text-[#657794] font-semibold">Filter</span>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilterKey(f.key)}
                className={`px-2.5 py-1 rounded-md border text-[12px] font-semibold ${
                  filterKey === f.key
                    ? 'bg-[#FFF0F1] border-[#FAC6C9] text-[#EF1B24]'
                    : 'bg-white border-[#D4DFEC] text-[#657794]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {error && <p className="text-[12px] text-[#F2343B]">{error}</p>}

      <div className="grid grid-cols-12 gap-3.5">
        <Card className="col-span-12 lg:col-span-8 p-0 overflow-hidden relative h-[520px]">
          {loading && (
            <div className="absolute inset-0 z-10 bg-white/60 flex items-center justify-center text-[13px] text-[#657794]">
              Loading neighbors…
            </div>
          )}
          {!loading && !nodes.length && (
            <div className="h-full flex items-center justify-center text-[13px] text-[#657794]">
              No graph relations for this resource yet.
            </div>
          )}
          <svg className="w-full h-full" viewBox="0 0 640 480">
            <defs>
              <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="#94A3B8" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const from = layout.get(String(edge.from_id));
              const to = layout.get(String(edge.to_id));
              if (!from || !to) return null;
              const mx = (from.x + to.x) / 2;
              const my = (from.y + to.y) / 2;
              return (
                <g key={edge.id}>
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke="#CBD5E1"
                    strokeWidth={1.5}
                    markerEnd="url(#arrow)"
                  />
                  <rect x={mx - 36} y={my - 10} width={72} height={18} rx={4} fill="#F8FAFC" stroke="#E2E8F0" />
                  <text
                    x={mx}
                    y={my + 3}
                    textAnchor="middle"
                    fontSize="9"
                    fill="#657794"
                    fontWeight="600"
                  >
                    {relationLabel(edge.relation_code)}
                  </text>
                </g>
              );
            })}
            {nodes.map((node) => {
              const pos = layout.get(node.id);
              if (!pos) return null;
              const isCenter = node.id === centerId;
              const isSelected = node.id === selectedNodeId;
              return (
                <g
                  key={node.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    setSelectedNodeId(node.id);
                    setSelectedResourceId(node.id);
                  }}
                >
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={isCenter ? 36 : 28}
                    fill={isCenter ? '#FFF0F1' : '#FFFFFF'}
                    stroke={isSelected ? '#EF1B24' : isCenter ? '#EF1B24' : '#D4DFEC'}
                    strokeWidth={isSelected || isCenter ? 2.5 : 1.5}
                  />
                  <text
                    x={pos.x}
                    y={pos.y - 2}
                    textAnchor="middle"
                    fontSize="10"
                    fontWeight="700"
                    fill="#111B37"
                  >
                    {(node.name || '').slice(0, 14)}
                  </text>
                  <text x={pos.x} y={pos.y + 11} textAnchor="middle" fontSize="8" fill="#657794">
                    {(node.type_key || node.type || '').toString()}
                  </text>
                </g>
              );
            })}
          </svg>
        </Card>

        <Card title="Inspector" className="col-span-12 lg:col-span-4 min-h-[520px]">
          {!selected ? (
            <p className="text-[12px] text-[#657794]">Select a node.</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <Share2 className="w-4 h-4 text-[#EF1B24] mt-0.5" />
                <div>
                  <p className="text-[15px] font-bold text-[#111B37]">{selected.name}</p>
                  <p className="text-[11px] font-mono text-[#657794]">
                    {selected.code || selected.id}
                  </p>
                </div>
              </div>
              <Badge variant="neutral">{selected.type_key || selected.type || 'resource'}</Badge>
              <div>
                <p className="text-[11px] font-bold uppercase text-[#94A3B8] mb-1.5">Relations</p>
                {!neighborEdges.length && (
                  <p className="text-[12px] text-[#657794]">No edges at this depth/filter.</p>
                )}
                <ul className="space-y-1.5">
                  {neighborEdges.map((edge) => {
                    const otherId =
                      String(edge.from_id) === selected.id ? String(edge.to_id) : String(edge.from_id);
                    const other = nodes.find((n) => n.id === otherId);
                    return (
                      <li key={edge.id}>
                        <button
                          type="button"
                          className="w-full text-left text-[12px] p-2 rounded-lg border border-[#E3EAF3] hover:border-[#EF1B24]"
                          onClick={() => {
                            setSelectedResourceId(otherId);
                            setSelectedNodeId(otherId);
                          }}
                        >
                          <span className="font-semibold text-[#EF1B24]">
                            {relationLabel(edge.relation_code)}
                          </span>{' '}
                          <span className="text-[#111B37]">{other?.name || otherId}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <p className="text-[11px] text-[#94A3B8]">
                Click a neighbor to make it the center node.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};
