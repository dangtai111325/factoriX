import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  House,
  Box,
  Database,
  Activity,
  Monitor,
  LayoutDashboard,
  Bell,
  FileText,
  Settings,
  ChevronDown,
  RotateCcw,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';

interface NavChild {
  label: string;
  path: string;
}

interface NavGroup {
  id: string;
  label: string;
  icon: React.ElementType;
  path?: string;
  children?: NavChild[];
  isFuture?: boolean;
}

const navConfig: NavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: House,
    path: '/overview',
  },
  {
    id: 'factory',
    label: 'Factory Model',
    icon: Box,
    children: [
      { label: 'Structure', path: '/factory/structure' },
      { label: 'Layout', path: '/factory/layout' },
      { label: 'Knowledge Graph', path: '/factory/graph' },
    ],
  },
  {
    id: 'acquisition',
    label: 'Acquisition',
    icon: Database,
    children: [
      { label: 'Connections', path: '/acquisition/connections' },
      { label: 'Add Data', path: '/acquisition/add-data' },
      { label: 'Protocol Studio', path: '/acquisition/studio/opcua' },
    ],
  },
  {
    id: 'signals',
    label: 'Signals',
    icon: Activity,
    children: [
      { label: 'Catalog', path: '/signals' },
      { label: 'Calculated', path: '/signals/calculated' },
      { label: 'Output Groups', path: '/signals/output-groups' },
    ],
  },
  {
    id: 'live',
    label: 'Live Operations',
    icon: Monitor,
    children: [
      { label: 'Monitor', path: '/live/monitor' },
      { label: 'Diagnostics', path: '/live/diagnostics' },
      { label: 'Activity Log', path: '/live/activity' },
    ],
  },
];

const futureNavs: NavGroup[] = [
  { id: 'dashboards', label: 'Dashboards', icon: LayoutDashboard, path: '/dashboards', isFuture: true },
  { id: 'storage', label: 'Storage', icon: Database, path: '/storage', isFuture: true },
  { id: 'alarms', label: 'Alarms & Events', icon: Bell, path: '/alarms', isFuture: true },
  { id: 'reports', label: 'Reports', icon: FileText, path: '/reports', isFuture: true },
  { id: 'admin', label: 'Administration', icon: Settings, path: '/administration', isFuture: true },
];

export const Sidebar: React.FC = () => {
  const location = useLocation();
  const { resetToReference } = useApp();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    factory: true,
    acquisition: true,
    signals: true,
    live: true,
  });

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const isGroupActive = (group: NavGroup): boolean => {
    if (group.path && location.pathname === group.path) return true;
    if (group.children) {
      return group.children.some((c) => location.pathname.startsWith(c.path));
    }
    return false;
  };

  return (
    <aside className="fx-sidebar select-none">
      {/* Brand Header */}
      <div className="h-[62px] px-5 flex items-center justify-between border-b border-[#E3EAF3]">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="FactoriX" className="h-7 w-auto object-contain" />
          <div className="flex flex-col">
            <span className="text-[15px] font-bold tracking-tight text-[#111B37]">
              Factori<span className="text-[#EF1B24]">X</span>
            </span>
            <span className="text-[10px] uppercase font-semibold tracking-wider text-[#657794]">
              Industrial IoT
            </span>
          </div>
        </div>
      </div>

      {/* Navigation Groups */}
      <div className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <div className="text-[11px] font-semibold text-[#94A3B8] uppercase px-3 pb-1 tracking-wider">
          Core Collector
        </div>

        {navConfig.map((group) => {
          const Icon = group.icon;
          const active = isGroupActive(group);
          const hasChildren = group.children && group.children.length > 0;
          const isOpen = openGroups[group.id] ?? false;

          if (!hasChildren && group.path) {
            return (
              <NavLink
                key={group.id}
                to={group.path}
                className={({ isActive }) =>
                  `flex items-center gap-3.5 px-3 py-2.5 rounded-lg text-[14px] font-medium transition-all ${
                    isActive
                      ? 'bg-[#FFF0F1] text-[#EF1B24] font-semibold border-l-4 border-[#EF1B24]'
                      : 'text-[#334568] hover:bg-[#F9FAFD] hover:text-[#111B37]'
                  }`
                }
              >
                <Icon className={`w-5 h-5 ${active ? 'text-[#EF1B24]' : 'text-[#657794]'}`} />
                <span>{group.label}</span>
              </NavLink>
            );
          }

          return (
            <div key={group.id} className="space-y-0.5">
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-[14px] font-medium transition-colors ${
                  active
                    ? 'text-[#EF1B24] font-semibold bg-[#FFF0F1]/60'
                    : 'text-[#334568] hover:bg-[#F9FAFD]'
                }`}
              >
                <div className="flex items-center gap-3.5">
                  <Icon className={`w-5 h-5 ${active ? 'text-[#EF1B24]' : 'text-[#657794]'}`} />
                  <span>{group.label}</span>
                </div>
                <ChevronDown
                  className={`w-4 h-4 text-[#94A3B8] transition-transform duration-200 ${
                    isOpen ? 'rotate-180 text-[#EF1B24]' : ''
                  }`}
                />
              </button>

              {isOpen && group.children && (
                <div className="ml-5 pl-3 border-l border-[#E2E8F0] space-y-0.5 py-1">
                  {group.children.map((child) => (
                    <NavLink
                      key={child.path}
                      to={child.path}
                      className={({ isActive }) =>
                        `flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                          isActive
                            ? 'text-[#EF1B24] font-bold bg-[#FFF0F1]'
                            : 'text-[#657794] hover:text-[#111B37] hover:bg-[#F9FAFD]'
                        }`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              isActive ? 'bg-[#EF1B24]' : 'bg-transparent border border-[#CBD5E1]'
                            }`}
                          />
                          <span>{child.label}</span>
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Future Modules Section */}
        <div className="pt-4 pb-1">
          <div className="text-[11px] font-semibold text-[#94A3B8] uppercase px-3 pb-1 tracking-wider flex items-center justify-between">
            <span>Planned Modules</span>
            <span className="text-[10px] lowercase px-1.5 py-0.2 rounded bg-[#F1F5FA] text-[#657794]">
              roadmap
            </span>
          </div>
        </div>

        {futureNavs.map((mod) => {
          const Icon = mod.icon;
          return (
            <NavLink
              key={mod.id}
              to={mod.path!}
              className={({ isActive }) =>
                `flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
                  isActive
                    ? 'bg-[#FFF0F1] text-[#EF1B24] font-semibold'
                    : 'text-[#657794] hover:bg-[#F9FAFD] hover:text-[#111B37]'
                }`
              }
            >
              <div className="flex items-center gap-3">
                <Icon className="w-4 h-4 text-[#94A3B8]" />
                <span>{mod.label}</span>
              </div>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#F1F5FA] text-[#94A3B8]">
                Later
              </span>
            </NavLink>
          );
        })}
      </div>

      {/* Footer Reset & Operator Info */}
      <div className="p-3 border-t border-[#E3EAF3] bg-[#F9FAFD]/60">
        <button
          type="button"
          onClick={() => {
            if (confirm('Reset to reference dataset from V7 design handoff?')) {
              resetToReference();
            }
          }}
          className="w-full mb-2 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg text-[12px] font-medium text-[#657794] border border-[#D4DFEC] hover:bg-white hover:text-[#111B37] transition-colors"
          title="Restore reference data from 15 design handoff screenshots"
        >
          <RotateCcw className="w-3.5 h-3.5 text-[#94A3B8]" />
          <span>Reset Reference Data</span>
        </button>
        <div className="flex items-center justify-between px-2 text-[11px] text-[#94A3B8]">
          <span>Design Handoff V7</span>
          <span className="font-mono text-[#0DBA67]">● Local Mode</span>
        </div>
      </div>
    </aside>
  );
};
