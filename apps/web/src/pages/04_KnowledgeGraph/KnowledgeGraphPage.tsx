import React, { useState } from 'react';
import {
  Share2,
  Filter,
  Search,
  Maximize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Sparkles,
  GitBranch,
  Activity,
  Layers,
  ArrowRight,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';

export const KnowledgeGraphPage: React.FC = () => {
  const { resources, signals, connections, selectedResourceId, setSelectedResourceId } = useApp();
  const [selectedNodeId, setSelectedNodeId] = useState<string>('node-center');
  const [depth, setDepth] = useState<'1-hop' | '2-hop'>('1-hop');
  const [activeFilter, setActiveFilter] = useState<string>('all');

  const currentResource =
    resources.find((r) => r.id === selectedResourceId) ||
    resources.find((r) => r.type === 'machine') ||
    resources[0];

  if (!currentResource) {
    return (
      <div className="space-y-3">
        <h1 className="fx-page-title">Knowledge Graph</h1>
        <p className="fx-page-subtitle">The graph is drawn from the factory model. Create an enterprise and its children first.</p>
      </div>
    );
  }

  // Dynamic incoming nodes (Parent Line / Plant / Gateway)
  const parentResource = resources.find((r) => r.id === currentResource.parentId);
  const incomingNodes = [
    ...(parentResource
      ? [{
          id: 'node-parent',
          name: parentResource.name,
          type: parentResource.type.toUpperCase(),
          category: 'incoming',
          code: parentResource.code,
          status: 'active',
        }]
      : []),
    ...connections.slice(0, 3).map((item) => ({
      id: item.id,
      name: item.name,
      type: item.protocol.toUpperCase(),
      category: 'incoming',
      code: item.endpoint || item.protocol,
      status: item.status,
    })),
  ];

  // Dynamic outgoing nodes (Signals bound to this resource)
  const machineSignals = signals.filter(
    (s) => s.resourceId === currentResource.id || s.resourcePath.includes(currentResource.name)
  );
  const outgoingNodes = machineSignals.map(
    (s) => ({
      id: `node-${s.id}`,
      name: s.name,
      type: 'TELEMETRY_SIGNAL',
      category: 'outgoing',
      code: s.tag,
      status: 'active',
      value: `${s.currentValue} ${s.unit || ''}`,
    })
  );

  const centerNode = {
    id: 'node-center',
    name: currentResource.name,
    type: currentResource.type.toUpperCase(),
    category: 'center',
    code: currentResource.code,
    status: currentResource.status,
  };

  const selectedNode =
    selectedNodeId === 'node-center'
      ? centerNode
      : incomingNodes.find((n) => n.id === selectedNodeId) ||
        outgoingNodes.find((n) => n.id === selectedNodeId) ||
        centerNode;

  // Related signals for inspector
  const relatedSignals = machineSignals.length > 0 ? machineSignals : signals.slice(0, 4);

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1: Heading */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Knowledge Graph</h1>
          <p className="fx-page-subtitle">
            Contextual asset graph, ontology relationships, and multi-tier telemetry dependencies.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button variant="secondary" icon={<Sparkles className="w-4 h-4 text-[#EF1B24]" />}>
            Auto Layout
          </Button>
          <Button variant="secondary" icon={<RotateCcw className="w-4 h-4 text-[#657794]" />}>
            Reset Graph
          </Button>
        </div>
      </div>

      {/* Region 2: Graph Filters Toolbar */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-[12px] font-bold text-[#657794] uppercase tracking-wider">
              Ego Depth:
            </span>
            <div className="bg-[#F1F5FA] p-1 rounded-lg flex items-center border border-[#D4DFEC]">
              <button
                type="button"
                onClick={() => setDepth('1-hop')}
                className={`px-3 py-1 rounded-md text-[12px] font-bold transition-all ${
                  depth === '1-hop' ? 'bg-white text-[#EF1B24] shadow-sm' : 'text-[#657794]'
                }`}
              >
                1-Hop Direct
              </button>
              <button
                type="button"
                onClick={() => setDepth('2-hop')}
                className={`px-3 py-1 rounded-md text-[12px] font-bold transition-all ${
                  depth === '2-hop' ? 'bg-white text-[#EF1B24] shadow-sm' : 'text-[#657794]'
                }`}
              >
                2-Hop Neighborhood
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-[#657794] font-semibold">Filter Relations:</span>
            {['all', 'part_of', 'feeds', 'powers', 'collects'].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setActiveFilter(f)}
                className={`px-2.5 py-1 rounded-md capitalize font-semibold transition-colors ${
                  activeFilter === f
                    ? 'bg-[#FFF0F1] text-[#EF1B24] border border-[#FAC6C9]'
                    : 'bg-[#F9FAFD] text-[#657794] hover:bg-[#F1F5FA]'
                }`}
              >
                {f.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Main Graph Grid: Canvas (Reg 3, 4, 5, 6) & Inspector (Reg 7) */}
      <div className="grid grid-cols-12 gap-3.5">
        {/* Graph Canvas (Col 8) */}
        <div className="col-span-12 lg:col-span-8 space-y-3.5">
          <div className="h-[520px] rounded-xl border border-[#D4DFEC] bg-white relative overflow-hidden shadow-sm flex items-center justify-center">
            {/* SVG Interactive Canvas */}
            <svg className="w-full h-full">
              {/* Edges from Incoming to Center */}
              {incomingNodes.map((node, idx) => {
                const y = 80 + idx * 110;
                return (
                  <g key={node.id}>
                    <path
                      d={`M 220 ${y} C 360 ${y}, 360 250, 480 250`}
                      fill="none"
                      stroke="#CBD5E1"
                      strokeWidth="2"
                    />
                    <circle cx="350" cy={(y + 250) / 2} r="3" fill="#2A82E7" />
                  </g>
                );
              })}

              {/* Edges from Center to Outgoing */}
              {outgoingNodes.map((node, idx) => {
                const y = 80 + idx * 110;
                return (
                  <g key={node.id}>
                    <path
                      d={`M 620 250 C 740 250, 740 ${y}, 840 ${y}`}
                      fill="none"
                      stroke="#CBD5E1"
                      strokeWidth="2"
                    />
                    <circle cx="730" cy={(250 + y) / 2} r="3" fill="#0DBA67" />
                  </g>
                );
              })}
            </svg>

            {/* Region 5: Incoming Node Cards (Left) */}
            <div className="absolute left-6 top-8 space-y-7 w-48">
              {incomingNodes.map((node) => (
                <div
                  key={node.id}
                  onClick={() => setSelectedNodeId(node.id)}
                  className={`p-3 rounded-xl bg-white border cursor-pointer transition-all shadow-sm ${
                    selectedNodeId === node.id
                      ? 'border-[#2A82E7] ring-2 ring-[#EEF5FF]'
                      : 'border-[#E3EAF3] hover:border-[#94A3B8]'
                  }`}
                >
                  <div className="text-[12px] font-bold text-[#111B37] truncate">{node.name}</div>
                  <div className="text-[10px] font-semibold text-[#657794] uppercase tracking-wider mt-0.5">
                    {node.type}
                  </div>
                </div>
              ))}
            </div>

            {/* Region 4: Center Ego Node (CNC 01) */}
            <div
              onClick={() => setSelectedNodeId('node-center')}
              className={`absolute p-4 rounded-xl bg-white border-2 cursor-pointer transition-all shadow-md w-52 text-center select-none ${
                selectedNodeId === 'node-center'
                  ? 'border-[#EF1B24] ring-4 ring-[#FFF0F1]'
                  : 'border-[#D4DFEC]'
              }`}
            >
              <div className="w-9 h-9 rounded-full bg-[#FFF0F1] border border-[#FAC6C9] mx-auto flex items-center justify-center text-[#EF1B24] font-bold mb-2">
                <GitBranch className="w-5 h-5" />
              </div>
              <h3 className="text-[14px] font-extrabold text-[#111B37]">{centerNode.name}</h3>
              <p className="text-[11px] font-mono text-[#657794] mt-0.5">{currentResource.code}</p>
              <div className="mt-2 pt-2 border-t border-[#F1F5FA] flex items-center justify-center gap-1.5 text-[11px] font-bold text-[#0DBA67]">
                <span className="w-2 h-2 rounded-full bg-[#0DBA67]" />
                <span>{signals.filter((item) => item.resourceId === currentResource.id).length} signals</span>
              </div>
            </div>

            {/* Region 6: Outgoing Node Cards (Right) */}
            <div className="absolute right-6 top-8 space-y-7 w-48">
              {outgoingNodes.map((node) => (
                <div
                  key={node.id}
                  onClick={() => setSelectedNodeId(node.id)}
                  className={`p-3 rounded-xl bg-white border cursor-pointer transition-all shadow-sm ${
                    selectedNodeId === node.id
                      ? 'border-[#0DBA67] ring-2 ring-[#E9FBF1]'
                      : 'border-[#E3EAF3] hover:border-[#94A3B8]'
                  }`}
                >
                  <div className="text-[12px] font-bold text-[#111B37] truncate">{node.name}</div>
                  <div className="text-[10px] font-semibold text-[#657794] uppercase tracking-wider mt-0.5">
                    {node.type}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Region 8: Related Signals Table */}
          <Card title="Mapped Signals for Center Asset">
            <table className="fx-table">
              <thead>
                <tr>
                  <th>Signal Tag</th>
                  <th>Parameter Name</th>
                  <th>Type</th>
                  <th>Current Value</th>
                  <th>Quality</th>
                </tr>
              </thead>
              <tbody>
                {relatedSignals.map((s) => (
                  <tr key={s.id}>
                    <td className="font-mono text-[12px] font-bold text-[#111B37]">{s.tag}</td>
                    <td className="text-[12px] text-[#334568]">{s.name}</td>
                    <td className="text-[11px] uppercase font-semibold text-[#657794]">{s.dataType}</td>
                    <td className="font-extrabold text-[#111B37] tabular-nums text-[13px]">
                      {s.currentValue} <span className="font-normal text-[11px] text-[#657794]">{s.unit}</span>
                    </td>
                    <td>
                      <Badge variant="good">{s.quality}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>

        {/* Region 7: Node Detail Inspector (Col 4) */}
        <div className="col-span-12 lg:col-span-4 space-y-3.5">
          <Card title="Node Metadata Inspector" className="h-[730px] overflow-y-auto">
            <div className="space-y-4">
              <div>
                <span className="text-[11px] font-bold uppercase text-[#94A3B8]">Entity Identifier</span>
                <h3 className="text-[16px] font-extrabold text-[#111B37] mt-0.5">{selectedNode.name}</h3>
                <span className="inline-block mt-1 px-2 py-0.5 rounded bg-[#F1F5FA] font-mono text-[11px] text-[#657794]">
                  {selectedNode.id}
                </span>
              </div>

              <div className="pt-3 border-t border-[#E3EAF3] space-y-2 text-[12px]">
                <span className="text-[11px] font-bold uppercase text-[#94A3B8]">Classification</span>
                <div className="flex justify-between py-1 border-b border-[#F1F5FA]">
                  <span className="text-[#657794]">Ontology Type:</span>
                  <span className="font-bold text-[#111B37] uppercase">{selectedNode.type}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-[#F1F5FA]">
                  <span className="text-[#657794]">Relationship Role:</span>
                  <span className="font-bold text-[#2A82E7] capitalize">{selectedNode.category}</span>
                </div>
              </div>

              <div className="pt-3 border-t border-[#E3EAF3] space-y-2">
                <span className="text-[11px] font-bold uppercase text-[#94A3B8]">Direct Neighbors</span>
                <p className="text-[12px] text-[#657794]">
                  Parent: {resources.find((item) => item.id === currentResource.parentId)?.name || 'root'} · Signals: {signals.filter((item) => item.resourceId === currentResource.id).length} · Connections: {connections.length}
                </p>
                <Button size="sm" variant="secondary" className="w-full mt-2" icon={<ArrowRight className="w-3.5 h-3.5" />}>
                  Explore Full Line Graph
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
