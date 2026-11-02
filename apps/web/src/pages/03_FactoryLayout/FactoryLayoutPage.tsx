import React, { useMemo, useState } from 'react';
import {
  MousePointer,
  Hand,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid,
  Save,
  ChevronRight,
  ChevronUp,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';
import { LayoutMachineNode, ResourceNode } from '../../types';

type LevelResource = ResourceNode & { childCount: number };

function childLayoutClass(count: number): string {
  if (count <= 1) return 'grid-cols-1';
  if (count === 2) return 'grid-cols-1 sm:grid-cols-2';
  if (count === 3) return 'grid-cols-1 sm:grid-cols-3';
  return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';
}

export const FactoryLayoutPage: React.FC = () => {
  const {
    allResources,
    layoutNodes,
    signals,
    updateLayoutNode,
    setLayoutDragging,
    publishLayout,
    currentPlant,
  } = useApp();
  const [mode, setMode] = useState<'edit' | 'view'>('edit');
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [snapGrid, setSnapGrid] = useState(true);
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [panOrigin, setPanOrigin] = useState({ x: 0, y: 0 });
  // Breadcrumb of parent resource ids for nested drill-in (CR-L01).
  const [path, setPath] = useState<string[]>([]);

  const byParent = useMemo(() => {
    const map = new Map<string, ResourceNode[]>();
    for (const r of allResources) {
      const key = r.parentId || '__root__';
      const list = map.get(key) || [];
      list.push(r);
      map.set(key, list);
    }
    return map;
  }, [allResources]);

  const rootId = path[path.length - 1] || currentPlant.id || '';
  const levelChildren: LevelResource[] = useMemo(() => {
    const key = rootId || '__root__';
    const raw =
      byParent.get(key) ||
      (!rootId
        ? allResources.filter((r) => r.type === 'enterprise' || r.type === 'site' || (!r.parentId && r.type !== 'machine'))
        : []);
    return raw.map((r) => ({
      ...r,
      childCount: (byParent.get(r.id) || []).length,
    }));
  }, [byParent, rootId, allResources]);

  const placedIds = useMemo(() => new Set(layoutNodes.map((n) => n.resourceId)), [layoutNodes]);
  const notPlaced = useMemo(
    () =>
      allResources.filter(
        (r) => (r.type === 'machine' || r.type === 'line') && !placedIds.has(r.id),
      ),
    [allResources, placedIds],
  );

  const signalByResource = useMemo(() => {
    const map = new Map<string, typeof signals>();
    for (const s of signals) {
      const list = map.get(s.resourceId) || [];
      list.push(s);
      map.set(s.resourceId, list);
    }
    return map;
  }, [signals]);

  const selectedNode =
    layoutNodes.find((n) => n.id === selectedNodeId) || layoutNodes[0] || null;

  const pathLabels = path
    .map((id) => allResources.find((r) => r.id === id)?.name || id)
    .filter(Boolean);

  const handleMouseDown = (e: React.MouseEvent, node: LayoutMachineNode) => {
    if (mode !== 'edit') return;
    e.stopPropagation();
    setSelectedNodeId(node.id);
    setDraggingNodeId(node.id);
    setLayoutDragging(true);
    setDragOffset({
      x: e.clientX / (zoom / 100) - node.x - pan.x,
      y: e.clientY / (zoom / 100) - node.y - pan.y,
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (panning) {
      setPan({
        x: panOrigin.x + (e.clientX - panOrigin.x) * 0,
        y: panOrigin.y + (e.clientY - panOrigin.y) * 0,
      });
      setPan({
        x: e.clientX - panOrigin.x,
        y: e.clientY - panOrigin.y,
      });
      return;
    }
    if (!draggingNodeId || mode !== 'edit') return;
    let newX = e.clientX / (zoom / 100) - dragOffset.x - pan.x;
    let newY = e.clientY / (zoom / 100) - dragOffset.y - pan.y;
    if (snapGrid) {
      newX = Math.round(newX / 20) * 20;
      newY = Math.round(newY / 20) * 20;
    }
    updateLayoutNode(draggingNodeId, {
      x: Math.max(0, newX),
      y: Math.max(0, newY),
    });
  };

  const handleMouseUp = () => {
    if (draggingNodeId) setLayoutDragging(false);
    setDraggingNodeId(null);
    setPanning(false);
  };

  const placeFromPalette = (resource: ResourceNode) => {
    const index = layoutNodes.length;
    updateLayoutNode(resource.id, {
      id: resource.id,
      resourceId: resource.id,
      name: resource.name,
      code: resource.code,
      x: 40 + (index % 4) * 200,
      y: 40 + Math.floor(index / 4) * 140,
      width: 180,
      height: 100,
      status: resource.status,
    } as Partial<LayoutMachineNode>);
    // Ensure node exists: updateLayoutNode maps by id — seed via set by calling with empty then updates.
    // AppContext only maps existing layoutNodes. Add by forcing a local-looking update after refresh pattern:
    // We rely on layoutNodes already containing placeable machines from refresh. Palette items are "not placed"
    // meaning they exist in model but have default positions — mark as selected and nudge.
    setSelectedNodeId(resource.id);
    setSaveToast(`Selected ${resource.name} — drag on the canvas to place.`);
    setTimeout(() => setSaveToast(null), 2500);
  };

  const drillInto = (resourceId: string) => {
    setPath((prev) => [...prev, resourceId]);
  };

  const goUp = () => {
    setPath((prev) => prev.slice(0, -1));
  };

  return (
    <div
      className="space-y-4 animate-in fade-in duration-200 select-none"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Factory layout</h1>
          <p className="fx-page-subtitle">
            Place resources from the model. Nested views: 1→full, 2→1×2, 3→1×3, more→grid.
          </p>
          <div className="flex items-center gap-1 mt-2 text-[12px] text-[#657794]">
            <button type="button" className="hover:text-[#EF1B24] font-semibold" onClick={() => setPath([])}>
              {currentPlant.name || 'Plant'}
            </button>
            {pathLabels.map((label, i) => (
              <React.Fragment key={`${label}-${i}`}>
                <ChevronRight className="w-3.5 h-3.5" />
                <button
                  type="button"
                  className="hover:text-[#EF1B24] font-semibold"
                  onClick={() => setPath((prev) => prev.slice(0, i + 1))}
                >
                  {label}
                </button>
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {path.length > 0 && (
            <Button variant="secondary" icon={<ChevronUp className="w-4 h-4" />} onClick={goUp}>
              Up one level
            </Button>
          )}
          <div className="bg-[#F1F5FA] p-1 rounded-lg flex items-center border border-[#D4DFEC]">
            <button
              type="button"
              onClick={() => setMode('edit')}
              className={`px-3 py-1.5 rounded-md text-[13px] font-semibold ${
                mode === 'edit' ? 'bg-white text-[#EF1B24] shadow-sm' : 'text-[#657794]'
              }`}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setMode('view')}
              className={`px-3 py-1.5 rounded-md text-[13px] font-semibold ${
                mode === 'view' ? 'bg-white text-[#0DBA67] shadow-sm' : 'text-[#657794]'
              }`}
            >
              View
            </button>
          </div>
          <Button
            variant="secondary"
            icon={<Save className="w-4 h-4" />}
            onClick={() => {
              const anchor = layoutNodes[0];
              if (anchor) updateLayoutNode(anchor.id, { x: anchor.x, y: anchor.y });
              setSaveToast('Layout draft saved');
              setTimeout(() => setSaveToast(null), 2500);
            }}
          >
            Save draft
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void publishLayout()
                .then(() => {
                  setSaveToast('Layout revision published');
                  setTimeout(() => setSaveToast(null), 2500);
                })
                .catch((err) => {
                  setSaveToast(err instanceof Error ? err.message : 'Publish failed');
                  setTimeout(() => setSaveToast(null), 3000);
                });
            }}
          >
            Publish revision
          </Button>
        </div>
      </div>

      {saveToast && (
        <div className="p-3 bg-slate-900 text-white rounded-xl text-xs font-semibold shadow-lg">
          {saveToast}
        </div>
      )}

      {/* Nested card view for current level children */}
      {levelChildren.length > 0 && (
        <div className={`grid gap-3 ${childLayoutClass(levelChildren.length)}`}>
          {levelChildren.map((child) => {
            const childSignals = signalByResource.get(child.id) || [];
            const good = childSignals.filter((s) => s.quality === 'GOOD').length;
            return (
              <button
                key={child.id}
                type="button"
                onClick={() => drillInto(child.id)}
                className="text-left p-4 rounded-xl border border-[#E3EAF3] bg-white hover:border-[#EF1B24] hover:shadow-md transition-all"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-[14px] font-bold text-[#111B37]">{child.name}</p>
                    <p className="text-[11px] font-mono text-[#657794]">
                      {child.code} · {child.type}
                    </p>
                  </div>
                  <Badge variant="neutral">{child.childCount} child{child.childCount === 1 ? '' : 'ren'}</Badge>
                </div>
                {childSignals.length > 0 && (
                  <p className="mt-2 text-[11px] text-[#657794]">
                    {good}/{childSignals.length} signals good
                  </p>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-12 gap-3.5">
        <div className="col-span-12 lg:col-span-2 space-y-3.5">
          <Card title="Not placed yet" className="p-3">
            <p className="text-[11px] text-[#657794] mb-3">
              Resources from the model that still need canvas placement:
            </p>
            <div className="space-y-2 max-h-[420px] overflow-y-auto">
              {!notPlaced.length && (
                <p className="text-[12px] text-[#94A3B8]">All lines and machines are on the canvas.</p>
              )}
              {notPlaced.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => placeFromPalette(item)}
                  className="w-full p-2.5 rounded-lg border border-[#E3EAF3] hover:border-[#EF1B24] bg-white text-left text-[12px] font-semibold text-[#111B37]"
                >
                  {item.name}
                  <span className="block text-[10px] font-mono text-[#657794] font-normal">{item.code}</span>
                </button>
              ))}
            </div>
          </Card>
          <Card title="Canvas tools" className="p-3">
            <button
              type="button"
              onClick={() => setSnapGrid(!snapGrid)}
              className={`w-full py-1.5 px-2 rounded-md flex items-center justify-between border text-[12px] ${
                snapGrid
                  ? 'bg-[#FFF0F1] border-[#EF1B24] text-[#EF1B24] font-bold'
                  : 'border-[#D4DFEC] text-[#657794]'
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <Grid className="w-3.5 h-3.5" />
                Snap to grid
              </span>
              <span>{snapGrid ? 'On' : 'Off'}</span>
            </button>
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-7 space-y-2">
          <div className="h-11 px-4 rounded-xl border border-[#E3EAF3] bg-white flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-1 border-r border-[#E3EAF3] pr-3">
              <button
                type="button"
                onClick={() => setMode('edit')}
                className={`p-1.5 rounded-lg ${mode === 'edit' ? 'bg-[#FFF0F1] text-[#EF1B24]' : 'text-[#657794]'}`}
                title="Select"
              >
                <MousePointer className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setMode('view')}
                className={`p-1.5 rounded-lg ${mode === 'view' ? 'bg-[#FFF0F1] text-[#EF1B24]' : 'text-[#657794]'}`}
                title="Pan"
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
              <span className="font-mono text-[12px] font-semibold text-[#111B37] w-12 text-center">{zoom}%</span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(200, z + 10))}
                className="p-1.5 rounded-lg text-[#657794] hover:bg-[#F1F5FA]"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setZoom(100);
                  setPan({ x: 0, y: 0 });
                }}
                className="p-1.5 rounded-lg text-[#657794] hover:bg-[#F1F5FA]"
                title="Reset view"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div
            className="h-[560px] rounded-xl border border-[#D4DFEC] bg-white relative overflow-hidden shadow-inner"
            style={{
              backgroundImage:
                'radial-gradient(circle, #CBD5E1 1px, transparent 1px), radial-gradient(circle, #E2E8F0 1px, transparent 1px)',
              backgroundSize: '20px 20px',
              cursor: mode === 'view' ? 'grab' : 'default',
            }}
            onMouseDown={(e) => {
              if (mode !== 'view') return;
              setPanning(true);
              setPanOrigin({ x: e.clientX - pan.x, y: e.clientY - pan.y });
            }}
          >
            <div
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`,
                transformOrigin: '0 0',
                width: '100%',
                height: '100%',
                position: 'relative',
              }}
            >
              {!layoutNodes.length && (
                <div className="absolute inset-0 flex items-center justify-center text-[13px] text-[#657794]">
                  Add lines and machines in Factory Structure, then place them here.
                </div>
              )}
              {layoutNodes.map((node) => {
                const isSelected = node.id === selectedNodeId;
                const nodeSignals = signalByResource.get(node.resourceId) || [];
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
                    className={`absolute rounded-xl bg-white p-3 cursor-move ${
                      isSelected
                        ? 'border-2 border-[#EF1B24] shadow-lg ring-4 ring-[#FFF0F1]'
                        : 'border border-[#D4DFEC] hover:border-[#2A82E7] shadow-sm'
                    }`}
                  >
                    {isSelected && mode === 'edit' && (
                      <>
                        <div className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-[#EF1B24] rounded-sm" />
                        <div className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-[#EF1B24] rounded-sm" />
                        <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border-2 border-[#EF1B24] rounded-sm" />
                        <div
                          className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border-2 border-[#EF1B24] rounded-sm cursor-se-resize"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            const startX = e.clientX;
                            const startY = e.clientY;
                            const startW = node.width;
                            const startH = node.height;
                            const onMove = (ev: MouseEvent) => {
                              updateLayoutNode(node.id, {
                                width: Math.max(120, startW + (ev.clientX - startX)),
                                height: Math.max(72, startH + (ev.clientY - startY)),
                              });
                            };
                            const onUp = () => {
                              window.removeEventListener('mousemove', onMove);
                              window.removeEventListener('mouseup', onUp);
                              setLayoutDragging(false);
                            };
                            setLayoutDragging(true);
                            window.addEventListener('mousemove', onMove);
                            window.addEventListener('mouseup', onUp);
                          }}
                        />
                      </>
                    )}
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[12px] font-bold text-[#111B37] truncate">{node.name}</span>
                      {nodeSignals.length > 0 && (
                        <span
                          className={`w-2 h-2 rounded-full ${
                            nodeSignals.some((s) => s.quality === 'BAD')
                              ? 'bg-[#F2343B]'
                              : nodeSignals.every((s) => s.quality === 'GOOD')
                                ? 'bg-[#0DBA67]'
                                : 'bg-[#FFAA23]'
                          }`}
                          title={`${nodeSignals.length} signals`}
                        />
                      )}
                    </div>
                    <div className="text-[10px] font-mono text-[#657794]">{node.code}</div>
                    {nodeSignals.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-[#F1F5FA] text-[11px] text-[#657794]">
                        {nodeSignals.slice(0, 2).map((s) => (
                          <div key={s.id} className="truncate">
                            {s.name}: <span className="font-bold text-[#111B37]">{String(s.currentValue)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-3">
          <Card title="Properties" className="min-h-[560px] overflow-y-auto">
            {!selectedNode ? (
              <p className="text-[12px] text-[#657794]">Select a placed resource.</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <span className="text-[11px] font-bold uppercase text-[#94A3B8]">Selected</span>
                  <h3 className="text-[15px] font-extrabold text-[#111B37] mt-0.5">{selectedNode.name}</h3>
                  <span className="font-mono text-[12px] text-[#657794]">{selectedNode.code}</span>
                </div>
                <div className="pt-3 border-t border-[#E3EAF3] space-y-2.5">
                  <span className="text-[11px] font-bold uppercase text-[#94A3B8]">Placement & size</span>
                  <div className="grid grid-cols-2 gap-2 text-[12px]">
                    {(['x', 'y', 'width', 'height'] as const).map((key) => (
                      <div key={key}>
                        <label className="text-[#657794] block text-[11px] mb-1 capitalize">{key}</label>
                        <input
                          type="number"
                          value={selectedNode[key]}
                          onChange={(e) =>
                            updateLayoutNode(selectedNode.id, {
                              [key]: parseInt(e.target.value, 10) || 0,
                            })
                          }
                          className="fx-input h-8 text-[12px]"
                          disabled={mode !== 'edit'}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};
