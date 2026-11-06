import React, { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  House,
  Box,
  Database,
  Layers,
  LayoutDashboard,
  Bell,
  LineChart,
  FileText,
  Settings,
  ChevronDown,
  RotateCcw,
  LogOut,
} from 'lucide-react';
import { useAuth } from '../../features/auth';
import { RevertToZeroModal } from '../modals/RevertToZeroModal';
import factorixLogo from '../../assets/factorix_brand_logo.png';

interface NavChild {
  label: string;
  path: string;
  soon?: boolean;
}

interface NavGroup {
  id: string;
  label: string;
  icon: React.ElementType;
  path?: string;
  soon?: boolean;
  children?: NavChild[];
}

const mainNav: NavGroup[] = [
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
      { label: 'Hierarchy Structure', path: '/factory/structure' },
      { label: 'Knowledge Graph', path: '/factory/graph' },
    ],
  },
  {
    id: 'collector',
    label: 'Data Collector',
    icon: Database,
    children: [
      { label: 'Connections', path: '/collector/connections' },
      { label: 'Signals', path: '/collector/signals' },
    ],
  },
  {
    id: 'models',
    label: 'Data Models',
    icon: Layers,
    children: [
      { label: 'Model Catalog', path: '/models' },
    ],
  },
];

const COMING_SOON_KEY = 'fx.sidebar.comingSoon.v2';
const COMING_SOON_GROUPS_KEY = 'fx.sidebar.comingSoonSubGroups.v2';

const comingSoonNav: NavGroup[] = [
  {
    id: 'dashboards',
    label: 'Dashboards',
    icon: LayoutDashboard,
    path: '/dashboards',
    soon: true,
    children: [
      { label: 'Dashboard Library', path: '/dashboards/library' },
      { label: 'Dashboard Builder', path: '/dashboards/builder' },
      { label: 'Widget Library', path: '/dashboards/widgets' },
    ],
  },
  {
    id: 'historian',
    label: 'Historian & Storage',
    icon: Database,
    path: '/historian',
    soon: true,
    children: [
      { label: 'Data Explorer', path: '/historian/explorer' },
      { label: 'Storage Policies', path: '/historian/policies' },
      { label: 'Retention & Export', path: '/historian/retention' },
    ],
  },
  {
    id: 'alarms',
    label: 'Alarms & Events',
    icon: Bell,
    path: '/alarms',
    soon: true,
    children: [
      { label: 'Alarm Rules', path: '/alarms/rules' },
      { label: 'Active Alarms', path: '/alarms/active' },
      { label: 'Event History', path: '/alarms/history' },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    icon: LineChart,
    path: '/analytics',
    soon: true,
    children: [
      { label: 'Analysis Workspace', path: '/analytics/workspace' },
      { label: 'Advanced Trends', path: '/analytics/advanced' },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    icon: FileText,
    path: '/reports',
    soon: true,
    children: [
      { label: 'Report Library', path: '/reports/library' },
      { label: 'Report Builder', path: '/reports/builder' },
      { label: 'Schedules', path: '/reports/schedules' },
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    icon: Settings,
    path: '/administration',
    soon: true,
    children: [
      { label: 'General Settings', path: '/administration/general' },
      { label: 'Users & Roles', path: '/administration/users' },
      { label: 'Integrations', path: '/administration/integrations' },
      { label: 'Audit Log', path: '/administration/audit' },
    ],
  },
];

export const Sidebar: React.FC = () => {
  const location = useLocation();
  const { signOut } = useAuth();
  const [revertModalOpen, setRevertModalOpen] = useState(false);

  // Group open state persistence
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('fx.sidebar.groups');
      if (saved) return JSON.parse(saved);
    } catch {
      // fallback
    }
    return { factory: true, collector: true, models: true };
  });

  // "Coming soon" section: collapsed by default so the released modules stay in view. The choice is
  // remembered per browser (".v2" keys: earlier builds stored "open" for everyone by default).
  const [comingSoonOpen, setComingSoonOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COMING_SOON_KEY) === 'true';
    } catch {
      return false;
    }
  });

  // Coming soon sub-groups: collapsed by default as well.
  const [openComingSoonSubGroups, setOpenComingSoonSubGroups] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem(COMING_SOON_GROUPS_KEY);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, boolean>;
      }
    } catch {
      // Unreadable storage: fall back to everything collapsed.
    }
    return {};
  });

  useEffect(() => {
    try {
      localStorage.setItem('fx.sidebar.groups', JSON.stringify(openGroups));
    } catch {
      // Storage unavailable (private mode, quota): the state simply is not remembered.
    }
  }, [openGroups]);

  useEffect(() => {
    try {
      localStorage.setItem(COMING_SOON_KEY, String(comingSoonOpen));
    } catch {
      // Storage unavailable: not remembered.
    }
  }, [comingSoonOpen]);

  useEffect(() => {
    const isAnyComingSoon = comingSoonNav.some(
      (item) =>
        location.pathname === item.path ||
        Boolean(item.children?.some((c) => location.pathname === c.path)) ||
        location.pathname.startsWith(item.path + '/')
    );
    if (isAnyComingSoon) {
      setComingSoonOpen(true);
      // Reveal the active sub-module as well.
      const activeGroup = comingSoonNav.find(
        (item) => Boolean(item.children?.some((c) => location.pathname === c.path)),
      );
      if (activeGroup) {
        setOpenComingSoonSubGroups((prev) => (prev[activeGroup.id] ? prev : { ...prev, [activeGroup.id]: true }));
      }
    }
  }, [location.pathname]);

  useEffect(() => {
    try {
      localStorage.setItem(COMING_SOON_GROUPS_KEY, JSON.stringify(openComingSoonSubGroups));
    } catch {
      // Storage unavailable: not remembered.
    }
  }, [openComingSoonSubGroups]);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleComingSoonSubGroup = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenComingSoonSubGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const isChildActive = (path: string): boolean => {
    if (path === '/collector/signals') {
      return (
        location.pathname === '/collector/signals' ||
        location.pathname === '/signals' ||
        location.pathname === '/live/monitor'
      );
    }
    if (path === '/collector/connections') {
      return (
        location.pathname === '/collector/connections' ||
        location.pathname === '/acquisition/connections'
      );
    }
    if (path === '/models') {
      return location.pathname === '/models';
    }
    return location.pathname === path;
  };

  const isGroupActive = (group: NavGroup): boolean => {
    if (group.path) {
      if (group.path === '/models') {
        return location.pathname.startsWith('/models') || location.pathname.startsWith('/signals/output-groups');
      }
      return location.pathname === group.path;
    }
    if (group.children) {
      // Pages of a group that are not menu items (e.g. the Add Data wizard under /collector/...) mark the
      // group as active without highlighting an unrelated child.
      const prefixes = Array.from(new Set(group.children.map((c) => c.path.split('/').slice(0, 2).join('/')).filter((p) => p.length > 1)));
      return (
        group.children.some((c) => isChildActive(c.path)) ||
        prefixes.some((prefix) => location.pathname.startsWith(`${prefix}/`))
      );
    }
    return false;
  };

  // Reveal the group of the current page (e.g. Data Collector while the Add Data wizard is open).
  useEffect(() => {
    const activeGroup = mainNav.find((group) => group.children?.length && isGroupActive(group));
    if (activeGroup) setOpenGroups((prev) => (prev[activeGroup.id] ? prev : { ...prev, [activeGroup.id]: true }));
    // isGroupActive only depends on the location.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  return (
    <>
      <aside className="fx-sidebar select-none flex flex-col" aria-label="Main navigation">
        {/* Brand Header: Logo only in red/white tone per user request */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="h-[62px] px-5 flex items-center border-b border-[#E3EAF3] shrink-0">
            <img src={factorixLogo} alt="FactoriX" className="h-8 w-auto object-contain" />
          </div>

          {/* Navigation Links: scroll inside, never under the footer */}
          <nav className="px-3 py-4 space-y-1 overflow-y-auto flex-1 min-h-0">
            {mainNav.map((group) => {
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
                          ? 'bg-[#FEF2F2] text-[#EF1B24] font-semibold border-l-4 border-[#EF1B24]'
                          : 'text-[#334568] hover:bg-[#FFF5F5] hover:text-[#EF1B24]'
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
                    aria-expanded={isOpen}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-[14px] font-medium transition-colors ${
                      active
                        ? 'text-[#EF1B24] font-semibold bg-[#FEF2F2]/60'
                        : 'text-[#334568] hover:bg-[#FFF5F5] hover:text-[#EF1B24]'
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
                      {group.children.map((child) => {
                        const childActive = isChildActive(child.path);
                        return (
                          <NavLink
                            key={child.path}
                            to={child.path}
                            className={`flex items-center justify-between px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                              childActive
                                ? 'text-[#EF1B24] font-bold bg-[#FEF2F2]'
                                : 'text-[#657794] hover:text-[#EF1B24] hover:bg-[#FFF5F5]'
                            }`}
                          >
                            <div className="flex items-center gap-2.5">
                              <span
                                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                  childActive ? 'bg-[#EF1B24]' : 'bg-transparent border border-[#CBD5E1]'
                                }`}
                              />
                              <span className="whitespace-nowrap">{child.label}</span>
                            </div>
                            {child.soon && (
                              <span className="text-[9px] font-medium px-1.5 py-0.2 rounded bg-[#FEF2F2] text-[#EF1B24] border border-[#FECACA] flex-shrink-0">
                                Soon
                              </span>
                            )}
                          </NavLink>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Coming Soon Group with Full Navigation Tree & Red Tone */}
            <div className="pt-3">
              <button
                type="button"
                onClick={() => setComingSoonOpen(!comingSoonOpen)}
                aria-expanded={comingSoonOpen}
                className="w-full flex items-center justify-between px-3 py-2 text-[13px] font-semibold text-[#64748B] hover:text-[#EF1B24] hover:bg-[#FFF5F5] rounded-lg transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <span>Coming soon</span>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#FEF2F2] text-[#EF1B24] border border-[#FECACA]">
                    Soon
                  </span>
                </div>
                <ChevronDown
                  className={`w-4 h-4 text-[#94A3B8] transition-transform duration-200 ${
                    comingSoonOpen ? 'rotate-180 text-[#EF1B24]' : ''
                  }`}
                />
              </button>

              {comingSoonOpen && (
                <div className="ml-2 pl-2 border-l border-[#E2E8F0] space-y-1 py-1">
                  {comingSoonNav.map((item) => {
                    const Icon = item.icon;
                    const isSubOpen = openComingSoonSubGroups[item.id] ?? false;
                    const hasChildren = item.children && item.children.length > 0;
                    const itemActive =
                      location.pathname === item.path ||
                      Boolean(item.children?.some((c) => location.pathname === c.path));

                    return (
                      <div key={item.id} className="space-y-0.5">
                        <div className="flex items-center justify-between rounded-lg hover:bg-[#FFF5F5] transition-colors">
                          <NavLink
                            to={item.path || '#'}
                            className={({ isActive }) =>
                              `flex-1 min-w-0 flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[13px] transition-colors ${
                                isActive
                                  ? 'bg-[#FEF2F2] text-[#EF1B24] font-semibold'
                                  : 'text-[#64748B] hover:text-[#EF1B24]'
                              }`
                            }
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <Icon className={`w-4 h-4 flex-shrink-0 ${itemActive ? 'text-[#EF1B24]' : 'text-[#94A3B8]'}`} />
                              <span className="whitespace-nowrap">{item.label}</span>
                            </div>
                            <span className="flex-shrink-0 ml-1.5 text-[10px] font-medium px-1.5 py-0.2 rounded bg-[#FEF2F2] text-[#EF1B24] border border-[#FECACA]">
                              Soon
                            </span>
                          </NavLink>
                          {hasChildren && (
                            <button
                              type="button"
                              onClick={(e) => toggleComingSoonSubGroup(item.id, e)}
                              className="p-1 text-[#94A3B8] hover:text-[#EF1B24] transition-colors rounded flex-shrink-0 mr-0.5"
                              title={isSubOpen ? `Hide ${item.label} modules` : `Show ${item.label} modules`}
                              aria-label={isSubOpen ? `Hide ${item.label} modules` : `Show ${item.label} modules`}
                              aria-expanded={isSubOpen}
                            >
                              <ChevronDown
                                className={`w-3.5 h-3.5 transition-transform duration-200 ${
                                  isSubOpen ? 'rotate-180 text-[#EF1B24]' : ''
                                }`}
                              />
                            </button>
                          )}
                        </div>

                        {hasChildren && isSubOpen && (
                          <div className="ml-4 pl-2.5 border-l border-[#E2E8F0] space-y-0.5 py-0.5">
                            {item.children!.map((child) => {
                              const childActive = location.pathname === child.path;
                              return (
                                <NavLink
                                  key={child.path}
                                  to={child.path}
                                  className={`flex items-center gap-2 px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
                                    childActive
                                      ? 'text-[#EF1B24] font-bold bg-[#FEF2F2]'
                                      : 'text-[#64748B] hover:text-[#EF1B24] hover:bg-[#FFF5F5]'
                                  }`}
                                >
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full ${
                                      childActive ? 'bg-[#EF1B24]' : 'bg-transparent border border-[#CBD5E1]'
                                    }`}
                                  />
                                  <span className="truncate">{child.label}</span>
                                </NavLink>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* Footer Actions */}
        <div className="p-3 border-t border-[#E3EAF3] bg-[#F9FAFD] shrink-0">
          <button
            type="button"
            onClick={() => setRevertModalOpen(true)}
            className="w-full mb-2 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg text-[12px] font-medium text-[#EF1B24] border border-[#FAC6C9] hover:bg-white transition-colors"
            title="Deletes the installation, including all configurations and data."
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Revert To Zero</span>
          </button>

          <div className="flex items-center justify-between px-1 pt-1 text-[11px] text-[#657794]">
            <span className="font-medium text-[#94A3B8]">FactoriX 1.0.0</span>
            <button
              type="button"
              onClick={() => {
                void signOut().then(() => {
                  window.location.assign('/login');
                });
              }}
              className="flex items-center gap-1 hover:text-[#EF1B24] transition-colors font-medium"
            >
              <LogOut className="w-3 h-3" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </aside>

      <RevertToZeroModal
        isOpen={revertModalOpen}
        onClose={() => setRevertModalOpen(false)}
      />
    </>
  );
};
