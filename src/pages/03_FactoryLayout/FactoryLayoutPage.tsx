import React, { useState } from 'react';
import {
  MousePointer,
  Hand,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid,
  Undo2,
  Redo2,
  Save,
  Cpu,
  Boxes,
  Factory,
  RotateCw,
  Trash2,
  Plus,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';
import { LayoutMachineNode } from '../../types';

export const FactoryLayoutPage: React.FC = () => {
  const { layoutNodes, updateLayoutNode } = useApp();
  const [mode, setMode] = useState<'edit' | 'view'>('edit');
  const [selectedNodeId, setSelectedNodeId] = useState<string>('layout-node-1');
  const [zoom, setZoom] = useState<number>(100);
  const [snapGrid, setSnapGrid] = useState<boolean>(true);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const selectedNode = layoutNodes.find((n) => n.id === selectedNodeId) || layoutNodes[0];

  const handleMouseDown = (e: React.MouseEvent, node: LayoutMachineNode) => {
    if (mode !== 'edit') return;
    setSelectedNodeId(node.id);
    setDraggingNodeId(node.id);
    setDragOffset({
      x: e.clientX - node.x,
      y: e.clientY - node.y,
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!draggingNodeId || mode !== 'edit') return;
    let newX = e.clientX - dragOffset.x;
    let newY = e.clientY - dragOffset.y;
    if (snapGrid) {
      newX = Math.round(newX / 20) * 20;
      newY = Math.round(newY / 20) * 20;
    }
    updateLayoutNode(draggingNodeId, {
      x: Math.max(20, Math.min(newX, 850)),
      y: Math.max(20, Math.min(newY, 550)),
    });
  };

  const handleMouseUp = () => {
    setDraggingNodeId(null);
  };

  return (
    <div
      className="space-y-4 animate-in fade-in duration-200 select-none"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Region 1 & 2: Heading & Edit/View Toggles */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Factory Layout Designer</h1>
          <p className="fx-page-subtitle">
            Visual plant floor editor, physical placement, and real-time operational overlay.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="bg-[#F1F5FA] p-1 rounded-lg flex items-center border border-[#D4DFEC]">
            <button
              type="button"
              onClick={() => setMode('edit')}
              className={`px-3 py-1.5 rounded-md text-[13px] font-semibold transition-all ${
                mode === 'edit'
                  ? 'bg-white text-[#EF1B24] shadow-sm'
                  : 'text-[#657794] hover:text-[#111B37]'
              }`}
            >
              Edit Mode
            </button>
            <button
              type="button"
              onClick={() => setMode('view')}
              className={`px-3 py-1.5 rounded-md text-[13px] font-semibold transition-all ${
                mode === 'view'
                  ? 'bg-white text-[#0DBA67] shadow-sm'
                  : 'text-[#657794] hover:text-[#111B37]'
              }`}
            >
              Live Monitor View
            </button>
          </div>
          <Button variant="primary" icon={<Save className="w-4 h-4" />}>
            Save Layout Draft
          </Button>
        </div>
      </div>

      {/* Main Designer Grid: Palette (Reg 3, 8) - Canvas (Reg 4, 5, 6) - Inspector (Reg 7) */}
      <div className="grid grid-cols-12 gap-3.5">
        {/* Left: Component Palette (Region 3) */}
        <div className="col-span-12 lg:col-span-2 space-y-3.5">
          <Card title="Asset Palette" className="p-3">
            <p className="text-[11px] text-[#657794] mb-3">
              Drag or click to add equipment to canvas:
            </p>
            <div className="space-y-2">
              {[
                { name: 'CNC Milling Unit', icon: Cpu, type: 'machine' },
                { name: 'Stamping Press', icon: Factory, type: 'press' },
                { name: 'Transfer Robot', icon: Boxes, type: 'robot' },
                { name: 'Packaging Sealer', icon: Boxes, type: 'packaging' },
              ].map((item, idx) => {
                const Icon = item.icon;
                return (
                  <div
                    key={idx}
                    className="p-2.5 rounded-lg border border-[#E3EAF3] hover:border-[#EF1B24] bg-white cursor-pointer transition-all flex items-center gap-2.5 shadow-sm text-[12px] font-semibold text-[#111B37]"
                  >
                    <Icon className="w-4 h-4 text-[#EF1B24]" />
                    <span>{item.name}</span>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Region 8: Quick Action Tools */}
          <Card title="Canvas Tools" className="p-3">
            <div className="space-y-2 text-[12px]">
              <button
                type="button"
                onClick={() => setSnapGrid(!snapGrid)}
                className={`w-full py-1.5 px-2 rounded-md flex items-center justify-between border ${
                  snapGrid ? 'bg-[#FFF0F1] border-[#EF1B24] text-[#EF1B24] font-bold' : 'border-[#D4DFEC] text-[#657794]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Grid className="w-3.5 h-3.5" />
                  <span>Snap to Grid</span>
                </div>
                <span>{snapGrid ? 'ON' : 'OFF'}</span>
              </button>
            </div>
          </Card>
        </div>

        {/* Center: Canvas Toolbar (Region 4) & Floor Canvas (Region 5 & 6) */}
        <div className="col-span-12 lg:col-span-7 space-y-2">
          {/* Region 4: Canvas Toolbar */}
          <div className="h-11 px-4 rounded-xl border border-[#E3EAF3] bg-white flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-1 border-r border-[#E3EAF3] pr-3">
              <button
                type="button"
                className={`p-1.5 rounded-lg ${
                  mode === 'edit' ? 'bg-[#FFF0F1] text-[#EF1B24]' : 'text-[#657794]'
                }`}
                title="Select tool"
              >
                <MousePointer className="w-4 h-4" />
              </button>
              <button
                type="button"
                className={`p-1.5 rounded-lg ${
                  mode === 'view' ? 'bg-[#FFF0F1] text-[#EF1B24]' : 'text-[#657794]'
                }`}
                title="Pan canvas"
              >
                <Hand className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(50, z - 10))}
                className="p-1.5 rounded-lg text-[#657794] hover:bg-[#F1F5FA]"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="font-mono text-[12px] font-semibold text-[#111B37] w-12 text-center">
                {zoom}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(150, z + 10))}
                className="p-1.5 rounded-lg text-[#657794] hover:bg-[#F1F5FA]"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setZoom(100)}
                className="p-1.5 rounded-lg text-[#657794] hover:bg-[#F1F5FA]"
                title="Fit to Screen"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-1 border-l border-[#E3EAF3] pl-3">
              <button type="button" className="p-1.5 rounded-lg text-[#94A3B8] hover:text-[#111B37]">
                <Undo2 className="w-4 h-4" />
              </button>
              <button type="button" className="p-1.5 rounded-lg text-[#94A3B8] hover:text-[#111B37]">
                <Redo2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Region 5: Factory Floor Canvas with SVG Blueprint Reference */}
          <div
            className="h-[680px] rounded-xl border border-[#D4DFEC] bg-white relative overflow-hidden shadow-inner cursor-crosshair"
            style={{
              backgroundImage:
                'radial-gradient(circle, #CBD5E1 1px, transparent 1px), radial-gradient(circle, #E2E8F0 1px, transparent 1px)',
              backgroundSize: '20px 20px',
              backgroundPosition: '0 0, 10px 10px',
            }}
          >
            {/* Plant Blueprint Vector Lines in Background */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-20">
              <rect x="50" y="40" width="760" height="580" fill="none" stroke="#2A82E7" strokeWidth="2" strokeDasharray="6 4" />
              <line x1="50" y1="220" x2="810" y2="220" stroke="#2A82E7" strokeWidth="1.5" strokeDasharray="4 4" />
              <text x="70" y="65" fill="#2A82E7" fontSize="12" fontWeight="bold">ZONE A - MACHINING & FABRICATION</text>
              <text x="70" y="245" fill="#2A82E7" fontSize="12" fontWeight="bold">ZONE B - ASSEMBLY & PACKAGING</text>
            </svg>

            {/* Draggable Machine Cards (Region 6) */}
            {layoutNodes.map((node) => {
              const isSelected = node.id === selectedNodeId;
              return (
                <div
                  key={node.id}
                  onMouseDown={(e) => handleMouseDown(e, node)}
                  style={{
                    left: `${node.x}px`,
                    top: `${node.y}px`,
                    width: `${node.width}px`,
                    height: `${node.height}px`,
                  }}
                  className={`absolute rounded-xl bg-white p-3 cursor-move transition-shadow duration-75 select-none ${
                    isSelected
                      ? 'border-2 border-[#EF1B24] shadow-lg ring-4 ring-[#FFF0F1]'
                      : 'border border-[#D4DFEC] hover:border-[#2A82E7] shadow-sm'
                  }`}
                >
                  {/* Selected Handles */}
                  {isSelected && mode === 'edit' && (
                    <>
                      <div className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-[#EF1B24] rounded-sm" />
                      <div className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-[#EF1B24] rounded-sm" />
                      <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-[#EF1B24] rounded-sm" />
                      <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-[#EF1B24] rounded-sm" />
                    </>
                  )}

                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[12px] font-bold text-[#111B37] truncate">{node.name}</span>
                    <span
                      className={`w-2 h-2 rounded-full ${
                        node.status === 'running' ? 'bg-[#0DBA67]' : 'bg-[#FFAA23]'
                      }`}
                    />
                  </div>

                  <div className="text-[10px] font-mono text-[#657794]">{node.code}</div>

                  {/* Real-time Overlay Stats */}
                  <div className="mt-2 pt-2 border-t border-[#F1F5FA] grid grid-cols-2 gap-1 text-[11px]">
                    {node.temperature !== undefined && (
                      <div className="text-[#657794]">
                        T: <span className="font-extrabold text-[#EF1B24]">{node.temperature}°C</span>
                      </div>
                    )}
                    {node.speed !== undefined && (
                      <div className="text-[#657794]">
                        RPM: <span className="font-bold text-[#111B37]">{node.speed}</span>
                      </div>
                    )}
                    {node.pressure !== undefined && (
                      <div className="text-[#657794]">
                        P: <span className="font-bold text-[#2A82E7]">{node.pressure}b</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Properties Inspector (Region 7) */}
        <div className="col-span-12 lg:col-span-3 space-y-3.5">
          <Card title="Properties Inspector" className="h-[734px] overflow-y-auto">
            <div className="space-y-4">
              <div>
                <span className="text-[11px] font-bold uppercase text-[#94A3B8]">Selected Asset</span>
                <h3 className="text-[15px] font-extrabold text-[#111B37] mt-0.5">
                  {selectedNode.name}
                </h3>
                <span className="font-mono text-[12px] text-[#657794]">{selectedNode.code}</span>
              </div>

              {/* Geometry Dimensions */}
              <div className="pt-3 border-t border-[#E3EAF3] space-y-2.5">
                <span className="text-[11px] font-bold uppercase text-[#94A3B8]">Placement & Size</span>
                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  <div>
                    <label className="text-[#657794] block text-[11px] mb-1">X Position</label>
                    <input
                      type="number"
                      value={selectedNode.x}
                      onChange={(e) =>
                        updateLayoutNode(selectedNode.id, { x: parseInt(e.target.value) || 0 })
                      }
                      className="fx-input h-8 text-[12px]"
                    />
                  </div>
                  <div>
                    <label className="text-[#657794] block text-[11px] mb-1">Y Position</label>
                    <input
                      type="number"
                      value={selectedNode.y}
                      onChange={(e) =>
                        updateLayoutNode(selectedNode.id, { y: parseInt(e.target.value) || 0 })
                      }
                      className="fx-input h-8 text-[12px]"
                    />
                  </div>
                  <div>
                    <label className="text-[#657794] block text-[11px] mb-1">Width</label>
                    <input
                      type="number"
                      value={selectedNode.width}
                      onChange={(e) =>
                        updateLayoutNode(selectedNode.id, { width: parseInt(e.target.value) || 50 })
                      }
                      className="fx-input h-8 text-[12px]"
                    />
                  </div>
                  <div>
                    <label className="text-[#657794] block text-[11px] mb-1">Height</label>
                    <input
                      type="number"
                      value={selectedNode.height}
                      onChange={(e) =>
                        updateLayoutNode(selectedNode.id, { height: parseInt(e.target.value) || 50 })
                      }
                      className="fx-input h-8 text-[12px]"
                    />
                  </div>
                </div>
              </div>

              {/* Operational Telemetry Summary */}
              <div className="pt-3 border-t border-[#E3EAF3] space-y-2">
                <span className="text-[11px] font-bold uppercase text-[#94A3B8]">
                  Operational State
                </span>
                <div className="p-3 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3] space-y-1.5 text-[12px]">
                  <div className="flex justify-between">
                    <span className="text-[#657794]">Running Status:</span>
                    <Badge variant={selectedNode.status === 'running' ? 'good' : 'warning'}>
                      {selectedNode.status.toUpperCase()}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#657794]">Power Consumption:</span>
                    <span className="font-bold text-[#111B37]">{selectedNode.power || 15} kW</span>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
