import React, { useState } from 'react';
import {
  Plus,
  Upload,
  Download,
  Search,
  Building2,
  Building,
  Factory,
  Boxes,
  Cpu,
  ChevronRight,
  ChevronDown,
  Activity,
  Edit2,
  Trash2,
  ArrowRightLeft,
  Copy,
  Archive,
  Layers,
  FolderTree,
} from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { Badge } from '../../components/common/Badge';
import { useApp } from '../../store/AppContext';
import { machineActivities } from '../../fixtures/factoryData';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AddResourceModal } from '../../components/modals/AddResourceModal';
import { MoveResourceModal } from '../../components/modals/MoveResourceModal';

export const FactoryStructurePage: React.FC = () => {
  const { resources, selectedResourceId, setSelectedResourceId, addResource, moveResource } = useApp();
  const [searchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState('');
  const [moveToast, setMoveToast] = useState<{ message: string; undoParentId?: string } | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({
    'res-ent-01': true,
    'res-site-01': true,
    'res-plant-01': true,
    'res-line-01': true,
  });

  // Modal states (supports query param deep-linking)
  const [isAddModalOpen, setIsAddModalOpen] = useState(searchParams.get('modal') === 'add');
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(searchParams.get('modal') === 'move');

  const navigate = useNavigate();

  const toggleExpand = (id: string) => {
    setExpandedNodes((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const selectedResource =
    resources.find((r) => r.id === selectedResourceId) || resources[4]; // Default to CNC 01

  const getIconForType = (type: string) => {
    switch (type.toLowerCase()) {
      case 'enterprise':
      case 'site':
        return <Building2 className="w-4 h-4 text-[#2A82E7]" />;
      case 'plant':
        return <Factory className="w-4 h-4 text-[#8858EA]" />;
      case 'line':
      case 'zone':
        return <Boxes className="w-4 h-4 text-[#FFAA23]" />;
      default:
        return <Cpu className="w-4 h-4 text-[#EF1B24]" />;
    }
  };

  const childResources = resources.filter((r) => r.parentId === selectedResource.id);

  const handleCreateResource = (data: {
    name: string;
    type: string;
    parentPath: string;
    description: string;
    properties: Record<string, string>;
  }) => {
    addResource({
      name: data.name,
      parentId: selectedResource.id,
      type: data.type.toLowerCase() as any,
      attributes: data.properties,
    });
  };

  const handleMoveResource = (targetParentId: string) => {
    const oldParentId = selectedResource.parentId;
    const res = moveResource(selectedResource.id, targetParentId);
    if (!res.success) {
      alert(`Cannot move resource: ${res.error}`);
    } else {
      setExpandedNodes((prev) => ({ ...prev, [targetParentId]: true }));
      setMoveToast({
        message: `Successfully moved "${selectedResource.name}"`,
        undoParentId: oldParentId,
      });
      setTimeout(() => setMoveToast(null), 5000);
    }
  };

  const handleUndoMove = () => {
    if (moveToast?.undoParentId) {
      moveResource(selectedResource.id, moveToast.undoParentId);
      setMoveToast(null);
    }
  };

  const filteredResources = resources.filter((r) =>
    r.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {/* Region 1 & 2: Heading & Actions Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="fx-page-title">Factory Structure</h1>
          <p className="fx-page-subtitle">
            Enterprise asset topology, functional locations, and resource hierarchy.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="relative w-56">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-[#94A3B8]" />
            <input
              type="text"
              placeholder="Filter hierarchy..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="fx-input pl-9 h-9 text-[13px]"
            />
          </div>
          <Button
            variant="primary"
            icon={<Plus className="w-4 h-4" />}
            onClick={() => setIsAddModalOpen(true)}
          >
            Add Resource
          </Button>
          <Button
            variant="secondary"
            icon={<ArrowRightLeft className="w-4 h-4" />}
            onClick={() => setIsMoveModalOpen(true)}
          >
            Move
          </Button>
          <Button
            variant="secondary"
            icon={<Copy className="w-4 h-4" />}
            onClick={() => alert(`Duplicated ${selectedResource.name} with all child bindings`)}
          >
            Duplicate
          </Button>
          <Button
            variant="secondary"
            icon={<Archive className="w-4 h-4" />}
            onClick={() => alert(`Archived ${selectedResource.name}`)}
          >
            Archive
          </Button>
        </div>
      </div>

      {/* 3-Column Layout: Hierarchy Tree, Child Units, and Detail Inspector */}
      <div className="grid grid-cols-12 gap-3.5">
        {/* Region 3: Asset Hierarchy Tree */}
        <div className="col-span-12 lg:col-span-3">
          <Card className="h-[760px] flex flex-col p-0">
            <div className="px-4 py-3 border-b border-[#E3EAF3] flex items-center justify-between bg-[#F9FAFD]">
              <span className="text-[12px] font-bold text-[#111B37] uppercase tracking-wider">
                Hierarchy Tree
              </span>
              <span className="text-[11px] font-semibold text-[#657794]">
                {filteredResources.length} nodes
              </span>
            </div>
            <div className="p-3 overflow-y-auto flex-1 space-y-1">
              {filteredResources.map((res) => {
                const isSelected = res.id === selectedResourceId;
                const isExpanded = expandedNodes[res.id] ?? false;
                const depth =
                  res.type === 'enterprise'
                    ? 0
                    : res.type === 'site'
                    ? 1
                    : res.type === 'plant'
                    ? 2
                    : res.type === 'line'
                    ? 3
                    : 4;

                return (
                  <div
                    key={res.id}
                    style={{ paddingLeft: `${depth * 14}px` }}
                    className={`flex items-center justify-between py-1.5 px-2 rounded-lg cursor-pointer text-[13px] transition-colors ${
                      isSelected
                        ? 'bg-[#FFF0F1] text-[#EF1B24] font-bold border-l-2 border-[#EF1B24]'
                        : 'text-[#334568] hover:bg-[#F1F5FA]'
                    }`}
                    onClick={() => setSelectedResourceId(res.id)}
                  >
                    <div className="flex items-center gap-2 truncate">
                      {res.childrenCount ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(res.id);
                          }}
                          className="p-0.5 text-[#94A3B8] hover:text-[#111B37]"
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                        </button>
                      ) : (
                        <span className="w-4" />
                      )}
                      {getIconForType(res.type)}
                      <span className="truncate">{res.name}</span>
                    </div>
                    {res.signalsCount !== undefined && (
                      <span className="text-[11px] font-mono text-[#94A3B8]">
                        {res.signalsCount}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        {/* Region 4: Resources List in current container */}
        <div className="col-span-12 lg:col-span-4">
          <Card className="h-[760px] flex flex-col p-0">
            <div className="px-4 py-3 border-b border-[#E3EAF3] flex items-center justify-between bg-[#F9FAFD]">
              <span className="text-[12px] font-bold text-[#111B37] uppercase tracking-wider">
                Child Units ({childResources.length})
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={() => setIsAddModalOpen(true)}
              >
                Add Child
              </Button>
            </div>
            <div className="p-3 overflow-y-auto flex-1 space-y-2">
              {childResources.length === 0 ? (
                <div className="text-center py-12 text-[#94A3B8] text-[13px]">
                  No sub-resources configured under this unit.
                </div>
              ) : (
                childResources.map((child) => (
                  <div
                    key={child.id}
                    onClick={() => setSelectedResourceId(child.id)}
                    className="p-3 rounded-xl border border-[#E3EAF3] hover:border-[#EF1B24] cursor-pointer bg-white transition-all shadow-sm"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        {getIconForType(child.type)}
                        <span className="text-[13px] font-bold text-[#111B37]">{child.name}</span>
                      </div>
                      <Badge variant={child.status === 'running' ? 'good' : 'warning'}>
                        {child.status ? child.status.toUpperCase() : 'ONLINE'}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-[#657794] font-mono">
                      <span>{child.code || 'ASSET-NODE'}</span>
                      <span>{child.signalsCount || 0} signals linked</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>

        {/* Right Inspector: Details, Specification, Topology, Activity */}
        <div className="col-span-12 lg:col-span-5 space-y-3.5">
          {/* Selected Resource Header */}
          <Card className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-[18px] font-extrabold text-[#111B37]">
                    {selectedResource.name}
                  </h2>
                  <Badge variant={selectedResource.status === 'running' ? 'good' : 'warning'}>
                    {selectedResource.status ? selectedResource.status.toUpperCase() : 'ONLINE'}
                  </Badge>
                </div>
                <div className="text-[12px] font-mono text-[#657794] mt-1">
                  ID: <span className="text-[#111B37] font-semibold">{selectedResource.code || 'RES-01'}</span> ·
                  Type: <span className="uppercase text-[#2A82E7] font-bold">{selectedResource.type}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ArrowRightLeft className="w-3.5 h-3.5" />}
                  onClick={() => setIsMoveModalOpen(true)}
                >
                  Move
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Activity className="w-3.5 h-3.5" />}
                  onClick={() => navigate(`/acquisition/add-data?resourceId=${selectedResource.id}`)}
                >
                  Add Signals
                </Button>
              </div>
            </div>
          </Card>

          {/* Specification & Connectivity & Topology Context */}
          <div className="grid grid-cols-2 gap-3.5">
            <Card title="Specification & Attributes" className="h-[240px]">
              <div className="space-y-2 text-[12px]">
                {selectedResource.attributes && Object.keys(selectedResource.attributes).length > 0 ? (
                  Object.entries(selectedResource.attributes).map(([k, v]) => (
                    <div key={k} className="flex justify-between py-1 border-b border-[#F1F5FA]">
                      <span className="text-[#657794]">{k}</span>
                      <span className="font-semibold text-[#111B37]">{v}</span>
                    </div>
                  ))
                ) : (
                  <div className="space-y-2">
                    <div className="flex justify-between py-1 border-b border-[#F1F5FA]">
                      <span className="text-[#657794]">Manufacturer</span>
                      <span className="font-semibold text-[#111B37]">Mazak Corp</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-[#F1F5FA]">
                      <span className="text-[#657794]">Model</span>
                      <span className="font-semibold text-[#111B37]">Nexus-410A</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-[#F1F5FA]">
                      <span className="text-[#657794]">Firmware</span>
                      <span className="font-semibold text-[#111B37]">v4.12.8</span>
                    </div>
                  </div>
                )}
              </div>
            </Card>

            <Card title="Topology Context" className="h-[240px]">
              <div className="space-y-3 text-[12px]">
                <div>
                  <span className="text-[#94A3B8] block text-[11px] uppercase font-bold">
                    Canonical Path
                  </span>
                  <p className="font-mono text-[#111B37] font-medium text-[12px] mt-0.5">
                    FactoriX / BinhDuong / Plant01 / {selectedResource.name}
                  </p>
                </div>
                <div className="pt-2 border-t border-[#E3EAF3]">
                  <span className="text-[#94A3B8] block text-[11px] uppercase font-bold">
                    Bound Telemetry
                  </span>
                  <div className="flex items-baseline gap-2 mt-1">
                    <span className="text-[20px] font-extrabold text-[#111B37]">
                      {selectedResource.signalsCount || 4}
                    </span>
                    <span className="text-[#657794]">active collector tags</span>
                  </div>
                </div>
                <div className="pt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full text-[11px]"
                    icon={<Layers className="w-3 h-3" />}
                    onClick={() => navigate('/factory/layout')}
                  >
                    Layout View
                  </Button>
                </div>
              </div>
            </Card>
          </div>

          {/* Recent Activities Table */}
          <Card title="Asset Change & Synchronization Log">
            <div className="overflow-x-auto">
              <table className="fx-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Operator</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {machineActivities.map((act) => (
                    <tr key={act.id}>
                      <td className="font-mono text-[11px] text-[#94A3B8]">{act.timestamp}</td>
                      <td className="font-semibold text-[#111B37] text-[12px]">{act.type}</td>
                      <td className="text-[#657794] text-[12px]">{act.user}</td>
                      <td className="text-[#334568] text-[12px]">{act.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>

      {/* Interactive Modals */}
      <AddResourceModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        parentPath={`FactoriX Corporation > East Manufacturing > Plant 01 > ${selectedResource.name}`}
        onAddResource={handleCreateResource}
      />

      <MoveResourceModal
        isOpen={isMoveModalOpen}
        onClose={() => setIsMoveModalOpen(false)}
        selectedResource={selectedResource}
        allResources={resources}
        onMoveResource={handleMoveResource}
      />

      {/* Undo Toast Notification (Review FX-03) */}
      {moveToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-900 text-white shadow-2xl border border-slate-700 animate-in slide-in-from-bottom-4 duration-200">
          <span className="text-xs font-semibold">{moveToast.message}</span>
          {moveToast.undoParentId && (
            <button
              type="button"
              onClick={handleUndoMove}
              className="text-xs font-bold text-amber-400 hover:text-amber-300 underline ml-2"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
};
