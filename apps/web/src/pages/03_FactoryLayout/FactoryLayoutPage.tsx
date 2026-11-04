import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Edit3,
  Eye,
  RotateCcw,
  Plus,
  ChevronRight,
  Home,
  CheckCircle2,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { useApp } from '../../store/AppContext';
import { ResourceNode } from '../../types';
import { calculateAutoGrid, ItemGeometry } from './AutoGrid';
import { ResourceCard } from './ResourceCard';
import { ResourceDetailPanel } from './ResourceDetailPanel';
import { useLayoutPersistence, LevelDraft } from './useLayoutPersistence';
import { AddResourceModal } from '../../components/modals/AddResourceModal';

export const FactoryLayoutPage: React.FC = () => {
  const { scopedResources, signals, refresh } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();

  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [selectedLeafId, setSelectedLeafId] = useState<string | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(100);

  // Custom placement overrides for active level: Record<childId, ItemGeometry>
  const [customGeometries, setCustomGeometries] = useState<Record<string, ItemGeometry>>({});
  const [isCustomMode, setIsCustomMode] = useState(false);

  // Active dragging / resizing state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ id: string; corner: string } | null>(null);
  const dragStartRef = useRef<{ clientX: number; clientY: number; initGeom: ItemGeometry } | null>(null);

  // Layout persistence hook
  const { saveStatus, lastSavedTime, saveLevel } = useLayoutPersistence('default-layout', 1);

  // Current level derived from URL (?level=<id>)
  const levelParam = searchParams.get('level');

  // Hierarchy map: id -> ResourceNode
  const resourceMap = useMemo(() => {
    const map = new Map<string, ResourceNode>();
    scopedResources.forEach((r) => map.set(r.id, r));
    return map;
  }, [scopedResources]);

  // Root resources (resources with no parent or parent not in current scope)
  const rootResources = useMemo(() => {
    return scopedResources.filter((r) => !r.parentId && !r.parent_id);
  }, [scopedResources]);

  // Current level resource (null means root)
  const currentLevel = useMemo(() => {
    if (!levelParam) return null;
    return resourceMap.get(levelParam) || null;
  }, [levelParam, resourceMap]);

  // Direct children of current level
  const directChildren = useMemo(() => {
    if (!currentLevel) {
      // If root, show top-level enterprises/sites
      return rootResources.length > 0 ? rootResources : scopedResources.slice(0, 1);
    }
    return scopedResources.filter(
      (r) => r.parentId === currentLevel.id || r.parent_id === currentLevel.id
    );
  }, [currentLevel, rootResources, scopedResources]);

  const childIds = useMemo(() => directChildren.map((c) => c.id), [directChildren]);

  // Build breadcrumb trail from root to current level
  const breadcrumbs = useMemo(() => {
    const trail: ResourceNode[] = [];
    let curr = currentLevel;
    while (curr) {
      trail.unshift(curr);
      const parentId: string | null = curr.parentId || curr.parent_id || null;
      curr = parentId ? resourceMap.get(parentId) || null : null;
    }
    return trail;
  }, [currentLevel, resourceMap]);

  // Reset custom placement when level changes
  useEffect(() => {
    setCustomGeometries({});
    setIsCustomMode(false);
    setSelectedLeafId(null);
  }, [levelParam]);

  // Keyboard navigation: Backspace navigates to parent
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only process when not typing in an input
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      if (e.key === 'Backspace') {
        if (breadcrumbs.length > 1) {
          e.preventDefault();
          const parent = breadcrumbs[breadcrumbs.length - 2];
          setSearchParams({ level: parent.id });
        } else if (breadcrumbs.length === 1) {
          e.preventDefault();
          setSearchParams({});
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [breadcrumbs, setSearchParams]);

  // Container dimensions
  const containerW = 1200;
  const containerH = 675; // 16:9 aspect ratio

  // Calculated auto geometries for direct children
  const autoGeometries = useMemo(() => {
    return calculateAutoGrid(childIds, containerW, containerH);
  }, [childIds]);

  // Final geometry per child: custom or auto
  const effectiveGeometries = useMemo(() => {
    const result: Record<string, ItemGeometry> = {};
    childIds.forEach((id) => {
      if (isCustomMode && customGeometries[id]) {
        result[id] = customGeometries[id];
      } else {
        result[id] = autoGeometries[id] || { x: 0, y: 0, w: 0.33, h: 0.5 };
      }
    });
    return result;
  }, [childIds, isCustomMode, customGeometries, autoGeometries]);

  // Children not placed yet (in custom mode)
  const unplacedChildren = useMemo(() => {
    if (!isCustomMode) return [];
    return directChildren.filter((c) => !customGeometries[c.id]);
  }, [directChildren, isCustomMode, customGeometries]);

  // Roll-up statistics helper
  const getRollup = (resourceId: string) => {
    const descendants: ResourceNode[] = [];
    const findDescendants = (id: string) => {
      scopedResources.forEach((r) => {
        if (r.parentId === id || r.parent_id === id) {
          descendants.push(r);
          findDescendants(r.id);
        }
      });
    };
    findDescendants(resourceId);

    const descIds = new Set(descendants.map((d) => d.id));
    const descSignals = signals.filter(
      (s) => descIds.has(s.resourceId || s.resource_id || '')
    );

    const good = descSignals.filter((s) => s.quality?.toUpperCase() === 'GOOD').length;
    const bad = descSignals.filter((s) => s.quality?.toUpperCase() === 'BAD').length;

    return {
      totalMachines: descendants.length,
      goodCount: good,
      badCount: bad,
      hasSignals: descSignals.length > 0,
    };
  };

  // Dragging and resizing mouse handlers
  const handleMouseDownMove = (childId: string, e: React.MouseEvent) => {
    if (mode !== 'edit') return;
    setDraggingId(childId);
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      initGeom: { ...effectiveGeometries[childId] },
    };
    setIsCustomMode(true);
  };

  const handleMouseDownResize = (childId: string, corner: string, e: React.MouseEvent) => {
    if (mode !== 'edit') return;
    e.stopPropagation();
    setResizing({ id: childId, corner });
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      initGeom: { ...effectiveGeometries[childId] },
    };
    setIsCustomMode(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragStartRef.current) return;

    const dx = (e.clientX - dragStartRef.current.clientX) / containerW;
    const dy = (e.clientY - dragStartRef.current.clientY) / containerH;

    if (draggingId) {
      const init = dragStartRef.current.initGeom;
      let newX = Math.max(0, Math.min(1 - init.w, init.x + dx));
      let newY = Math.max(0, Math.min(1 - init.h, init.y + dy));
      // Snap to 8px grid
      const snapPx = 8;
      newX = Math.round((newX * containerW) / snapPx) * (snapPx / containerW);
      newY = Math.round((newY * containerH) / snapPx) * (snapPx / containerH);

      const nextGeom: ItemGeometry = {
        ...init,
        x: Number(Math.max(0, Math.min(1 - init.w, newX)).toFixed(4)),
        y: Number(Math.max(0, Math.min(1 - init.h, newY)).toFixed(4)),
      };

      const nextCustom = { ...effectiveGeometries, [draggingId]: nextGeom };
      setCustomGeometries(nextCustom);

      if (currentLevel) {
        saveLevel(currentLevel.id, { mode: 'custom', items: nextCustom });
      }
    } else if (resizing) {
      const init = dragStartRef.current.initGeom;
      let newW = Math.max(0.1, Math.min(1 - init.x, init.w + dx));
      let newH = Math.max(0.1, Math.min(1 - init.y, init.h + dy));

      if (e.shiftKey) {
        // Shift + drag preserves aspect ratio (TC-UI-LD-14)
        const ratio = init.w / init.h;
        newH = newW / ratio;
      }

      const nextGeom: ItemGeometry = {
        ...init,
        w: Number(Math.min(1 - init.x, newW).toFixed(4)),
        h: Number(Math.min(1 - init.y, newH).toFixed(4)),
      };

      const nextCustom = { ...effectiveGeometries, [resizing.id]: nextGeom };
      setCustomGeometries(nextCustom);

      if (currentLevel) {
        saveLevel(currentLevel.id, { mode: 'custom', items: nextCustom });
      }
    }
  };

  const handleMouseUp = () => {
    setDraggingId(null);
    setResizing(null);
    dragStartRef.current = null;
  };

  const handleResetToAuto = () => {
    setCustomGeometries({});
    setIsCustomMode(false);
    if (currentLevel) {
      saveLevel(currentLevel.id, { mode: 'auto', items: {} });
    }
  };

  const selectedLeafResource = selectedLeafId ? resourceMap.get(selectedLeafId) : null;

  return (
    <div
      className="space-y-4 animate-in fade-in duration-200 select-none pb-8"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Top Header: Breadcrumbs + Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          {/* Breadcrumb Navigation (§5.2 & TC-UI-LD-01..07) */}
          <nav aria-label="Hierarchy Breadcrumb" className="flex items-center gap-1.5 text-xs font-semibold text-[#64748B] mb-1">
            <button
              type="button"
              onClick={() => setSearchParams({})}
              className={`hover:text-[#0B2545] transition-colors flex items-center gap-1 ${
                !currentLevel ? 'text-[#0B2545] font-bold' : ''
              }`}
            >
              <Home className="w-3.5 h-3.5" />
              <span>All</span>
            </button>
            {breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1;
              return (
                <React.Fragment key={crumb.id}>
                  <ChevronRight className="w-3.5 h-3.5 text-[#CBD5E1]" />
                  <button
                    type="button"
                    onClick={() => setSearchParams({ level: crumb.id })}
                    className={`hover:text-[#0B2545] transition-colors truncate max-w-[140px] ${
                      isLast ? 'text-[#0B2545] font-bold' : ''
                    }`}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              );
            })}
          </nav>
          <h1 className="text-xl md:text-2xl font-black text-[#0B2545] tracking-tight">
            {currentLevel ? currentLevel.name : 'Factory Layout Designer'}
          </h1>
        </div>

        {/* Top Controls: View/Edit toggle + Reset Auto + Save status indicator */}
        <div className="flex items-center gap-3">
          {/* Saving Indicator (TC-UI-LD-13) */}
          {mode === 'edit' && (
            <div className="text-xs flex items-center gap-1.5 font-medium text-[#64748B] mr-2">
              {saveStatus === 'saving' && (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#134074]" />
                  <span>Saving…</span>
                </>
              )}
              {saveStatus === 'saved' && (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#10B981]" />
                  <span>Saved · {lastSavedTime}</span>
                </>
              )}
              {saveStatus === 'error' && (
                <>
                  <AlertCircle className="w-3.5 h-3.5 text-[#EF4444]" />
                  <span>Could not save · Retrying</span>
                </>
              )}
            </div>
          )}

          {mode === 'edit' && isCustomMode && (
            <button
              type="button"
              onClick={handleResetToAuto}
              className="px-3 py-1.5 rounded-lg border border-[#CBD5E1] bg-white text-xs font-semibold text-[#475569] hover:text-[#0B2545] hover:bg-[#F8FAFC] flex items-center gap-1.5 shadow-sm transition-all"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset to auto layout</span>
            </button>
          )}

          <div className="bg-[#F1F5F9] p-1 rounded-xl flex items-center border border-[#E2E8F0]">
            <button
              type="button"
              onClick={() => setMode('view')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                mode === 'view'
                  ? 'bg-white text-[#0B2545] shadow-sm'
                  : 'text-[#64748B] hover:text-[#0B2545]'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>View</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('edit')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                mode === 'edit'
                  ? 'bg-white text-[#134074] shadow-sm'
                  : 'text-[#64748B] hover:text-[#0B2545]'
              }`}
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Edit layout</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Layout Workspace: Optional Left Tray (Edit mode) + Canvas + Optional Right Panel (Leaf Inspector) */}
      <div className="flex gap-4 items-start relative min-h-[700px]">
        {/* Left Tray: "Not placed yet" (Only in Edit mode) (TC-UI-LD-12, 21, 22) */}
        {mode === 'edit' && (
          <div className="w-64 bg-white border border-[#E2E8F0] rounded-2xl p-4 shadow-sm shrink-0 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#475569]">
                Not placed yet ({unplacedChildren.length})
              </h3>
            </div>

            <div className="space-y-2 max-h-[460px] overflow-y-auto">
              {unplacedChildren.length === 0 ? (
                <div className="p-4 text-center border border-dashed border-[#CBD5E1] rounded-xl text-xs text-[#94A3B8]">
                  All resources at this level are placed on canvas.
                </div>
              ) : (
                unplacedChildren.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => {
                      // Click places unplaced item onto canvas
                      const nextGeom: ItemGeometry = { x: 0.1, y: 0.1, w: 0.33, h: 0.5 };
                      setCustomGeometries((prev) => ({ ...prev, [item.id]: nextGeom }));
                    }}
                    className="p-3 rounded-xl border border-[#E2E8F0] hover:border-[#134074] bg-[#F8FAFC] hover:bg-white cursor-pointer transition-all shadow-sm"
                  >
                    <div className="text-xs font-bold text-[#0B2545] truncate">{item.name}</div>
                    <div className="text-[10px] font-mono text-[#64748B]">{item.code}</div>
                  </div>
                ))
              )}
            </div>

            {/* "+ Add resource here" button (TC-UI-LD-22) */}
            <button
              type="button"
              onClick={() => setIsAddModalOpen(true)}
              className="w-full py-2 px-3 rounded-xl bg-[#0B2545] hover:bg-[#134074] text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition-all"
            >
              <Plus className="w-4 h-4" />
              <span>+ Add resource here</span>
            </button>
          </div>
        )}

        {/* Center Canvas Container with Zoom & Pan (§5.2 & TC-UI-LD-19, 20) */}
        <div className="flex-1 bg-white border border-[#E2E8F0] rounded-2xl overflow-hidden shadow-sm flex flex-col">
          {/* Zoom & Canvas Toolbar */}
          <TransformWrapper
            initialScale={1}
            minScale={0.25}
            maxScale={4}
            centerOnInit
            wheel={{ step: 0.1 }}
            onTransform={(ref: any) => setZoomLevel(Math.round(ref.state.scale * 100))}
          >
            {({ zoomIn, zoomOut, resetTransform }) => (
              <>
                <div className="h-12 px-4 border-b border-[#E2E8F0] flex items-center justify-between bg-[#F8FAFC]">
                  <div className="flex items-center gap-2 text-xs font-bold text-[#475569]">
                    <span>Floor View</span>
                    <span className="text-[#94A3B8]">·</span>
                    <span className="text-[#64748B] font-mono font-normal">
                      {directChildren.length} elements
                    </span>
                  </div>

                  {/* Zoom Controls */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => zoomOut()}
                      aria-label="Zoom out"
                      className="p-1.5 rounded-lg text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] transition-colors"
                    >
                      <ZoomOut className="w-4 h-4" />
                    </button>
                    <span className="font-mono text-xs font-bold text-[#0B2545] w-12 text-center">
                      {zoomLevel}%
                    </span>
                    <button
                      type="button"
                      onClick={() => zoomIn()}
                      aria-label="Zoom in"
                      className="p-1.5 rounded-lg text-[#64748B] hover:text-[#0B2545] hover:bg-[#E2E8F0] transition-colors"
                    >
                      <ZoomIn className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => resetTransform()}
                      className="px-2.5 py-1 rounded-lg text-xs font-semibold text-[#475569] hover:text-[#0B2545] hover:bg-[#E2E8F0] flex items-center gap-1 transition-colors ml-1"
                      title="Fit to container"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                      <span>Fit</span>
                    </button>
                  </div>
                </div>

                {/* 16:9 Canvas Stage with Dot Grid */}
                <div className="flex-1 overflow-hidden relative cursor-default bg-[#F8FAFC]">
                  <TransformComponent
                    wrapperStyle={{ width: '100%', height: '680px' }}
                    contentStyle={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <div
                      style={{
                        width: `${containerW}px`,
                        height: `${containerH}px`,
                        backgroundImage: 'radial-gradient(circle, #CBD5E1 1px, transparent 1px)',
                        backgroundSize: '24px 24px',
                      }}
                      className="relative border border-[#E2E8F0] bg-white rounded-xl shadow-inner overflow-hidden select-none"
                    >
                      {directChildren.length === 0 ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-[#94A3B8] p-6 text-center">
                          <p className="text-sm font-semibold">No equipment placed here yet.</p>
                          <p className="text-xs text-[#94A3B8] mt-1">
                            Click "+ Add resource here" in Edit mode or create them in Factory Structure.
                          </p>
                        </div>
                      ) : (
                        directChildren.map((child) => {
                          const geom = effectiveGeometries[child.id] || { x: 0, y: 0, w: 0.33, h: 0.5 };
                          const childSubs = scopedResources.filter(
                            (r) => r.parentId === child.id || r.parent_id === child.id
                          );
                          const isLeaf = childSubs.length === 0;

                          return (
                            <ResourceCard
                              key={child.id}
                              resource={child}
                              childrenCount={childSubs.length}
                              childTypeLabel={
                                childSubs.length > 0 ? `${childSubs[0].type}s` : 'items'
                              }
                              signals={signals}
                              rollup={getRollup(child.id)}
                              geometry={geom}
                              containerWidth={containerW}
                              containerHeight={containerH}
                              isEditMode={mode === 'edit'}
                              isSelected={selectedLeafId === child.id}
                              onDrillDown={() => setSearchParams({ level: child.id })}
                              onSelectLeaf={() => setSelectedLeafId(child.id)}
                              onMouseDownMove={(e) => handleMouseDownMove(child.id, e)}
                              onMouseDownResize={(e, corner) => handleMouseDownResize(child.id, corner, e)}
                            />
                          );
                        })
                      )}
                    </div>
                  </TransformComponent>
                </div>
              </>
            )}
          </TransformWrapper>
        </div>

        {/* Right Details Panel for Leaf Card (§5.2 step 5 & TC-UI-LD-11) */}
        {selectedLeafResource && (
          <ResourceDetailPanel
            resource={selectedLeafResource}
            signals={signals}
            onClose={() => setSelectedLeafId(null)}
          />
        )}
      </div>

      {/* Add Resource Modal (TC-UI-LD-22) */}
      <AddResourceModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        parentId={currentLevel ? currentLevel.id : null}
        parentName={currentLevel ? currentLevel.name : 'Root'}
        parentPath={currentLevel ? currentLevel.code : '(root)'}
        onAddResource={async (newRes) => {
          setIsAddModalOpen(false);
          await refresh();
        }}
      />
    </div>
  );
};
