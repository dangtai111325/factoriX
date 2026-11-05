import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Search,
  Bell,
  UserRound,
  ChevronDown,
  Check,
  Radio,
  Lock,
  Info,
  LogOut,
  AlertCircle,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { useAuth } from '../../features/auth';
import { ChangePasswordModal } from '../modals/ChangePasswordModal';
import { AboutFactorixModal } from '../modals/AboutFactorixModal';

const ROUTE_BREADCRUMBS: Record<string, { group?: string; title: string }> = {
  '/overview': { title: 'Overview' },
  '/factory/structure': { group: 'Factory Model', title: 'Hierarchy Structure' },
  '/factory/layout': { group: 'Factory Model', title: 'Layout Designer' },
  '/factory/graph': { group: 'Factory Model', title: 'Factory Graph' },
  '/collector/connections': { group: 'Data Collector', title: 'Connections' },
  '/collector/signals': { group: 'Data Collector', title: 'Data Acquisition' },
  '/collector/edges': { group: 'Data Collector', title: 'Edge Collectors' },
  '/collector/diagnostics': { group: 'Data Collector', title: 'Diagnostics' },
  '/collector/add-data': { group: 'Data Collector', title: 'Data Acquisition' },
  '/models': { group: 'Data Models', title: 'All Model' },
  '/dashboards': { group: 'Coming soon', title: 'Dashboards' },
  '/historian': { group: 'Coming soon', title: 'Historian & Storage' },
  '/alarms': { group: 'Coming soon', title: 'Alarms & Events' },
  '/analytics': { group: 'Coming soon', title: 'Analytics' },
  '/reports': { group: 'Coming soon', title: 'Reports' },
  '/administration': { group: 'Coming soon', title: 'Administration' },
};

export const Topbar: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { setSearchOpen, resources, edges } = useApp();
  const { state, signOut } = useAuth();

  const [siteDropdownOpen, setSiteDropdownOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const siteDropdownRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const operatorName =
    state.status === 'authenticated'
      ? state.user.full_name || state.user.login
      : 'Administrator';

  // Breadcrumbs
  const breadcrumb = useMemo(() => {
    const matched = ROUTE_BREADCRUMBS[location.pathname];
    if (matched) return matched;
    if (location.pathname.startsWith('/factory/structure')) {
      return { group: 'Factory Model', title: 'Hierarchy Structure' };
    }
    if (location.pathname.startsWith('/collector/signals')) {
      return { group: 'Data Collector', title: 'Signals' };
    }
    if (location.pathname.startsWith('/collector/diagnostics')) {
      return { group: 'Data Collector', title: 'Diagnostics' };
    }
    if (location.pathname.startsWith('/collector/connections')) {
      return { group: 'Data Collector', title: 'Connections' };
    }
    if (location.pathname.startsWith('/models')) {
      return { group: 'Data Models', title: 'Model Catalog' };
    }
    return { title: 'FactoriX' };
  }, [location.pathname]);

  // Sites and Scope
  const sites = useMemo(() => {
    return resources.filter((r) => r.type === 'site');
  }, [resources]);

  const [selectedScope, setSelectedScope] = useState<string>(() => {
    try {
      return localStorage.getItem('fx.scope') || 'all';
    } catch {
      return 'all';
    }
  });

  const handleSelectScope = (scopeId: string) => {
    setSelectedScope(scopeId);
    try {
      localStorage.setItem('fx.scope', scopeId);
    } catch {}
    setSiteDropdownOpen(false);
  };

  const selectedSite = useMemo(() => {
    if (selectedScope === 'all') return null;
    return sites.find((s) => s.id === selectedScope) || null;
  }, [selectedScope, sites]);

  // Count resources for current scope
  const scopedResourceCount = useMemo(() => {
    if (selectedScope === 'all') {
      return resources.length;
    }
    // Count site and descendants
    const site = sites.find((s) => s.id === selectedScope);
    if (!site) return resources.length;
    const found = new Set<string>([site.id]);
    let added = true;
    while (added) {
      added = false;
      for (const r of resources) {
        if (r.parentId && found.has(r.parentId) && !found.has(r.id)) {
          found.add(r.id);
          added = true;
        }
      }
    }
    return found.size;
  }, [selectedScope, sites, resources]);

  // Data Collection Edge status (TC-UI-NAV-08)
  const enrolledEdges = useMemo(() => {
    return edges.filter((e) => e.enrollmentStatus === 'ENROLLED');
  }, [edges]);

  const onlineEdges = useMemo(() => {
    return enrolledEdges.filter(
      (e) => e.health === 'ONLINE' || e.health === 'HEALTHY' || e.health === 'ACTIVE',
    );
  }, [enrolledEdges]);

  const offlineEdge = useMemo(() => {
    return enrolledEdges.find(
      (e) => e.health === 'OFFLINE' || e.health === 'DEGRADED',
    );
  }, [enrolledEdges]);

  // Close dropdowns on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (siteDropdownRef.current && !siteDropdownRef.current.contains(e.target as Node)) {
        setSiteDropdownOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Toast timer
  useEffect(() => {
    if (!toastMessage) return;
    const t = setTimeout(() => setToastMessage(null), 3000);
    return () => clearTimeout(t);
  }, [toastMessage]);

  return (
    <>
      {/* Offline banner if an enrolled edge is offline */}
      {offlineEdge && (
        <div className="bg-[#EF1B24] text-white text-[12px] font-semibold px-4 py-1.5 flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>
              Data collection for{' '}
              {sites.find((s) => s.id === offlineEdge.siteId)?.name || offlineEdge.name}{' '}
              is offline
              {offlineEdge.lastHeartbeat
                ? ` since ${new Date(offlineEdge.lastHeartbeat).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : ''}
            </span>
          </div>
          <button
            type="button"
            onClick={() => navigate('/collector/edges')}
            className="underline hover:text-white/80 text-[11px] font-bold"
          >
            Open Edge Collectors →
          </button>
        </div>
      )}

      <header className="fx-topbar select-none relative z-30">
        {/* Left: Breadcrumbs & Plant Selector */}
        <div className="flex items-center gap-3">
          {/* Breadcrumbs */}
          <div className="flex items-center gap-2 text-[13px] text-[#657794]">
            {breadcrumb.group && (
              <>
                <span className="font-medium text-[#475569]">{breadcrumb.group}</span>
                <span className="text-[#CBD5E1]">›</span>
              </>
            )}
            <span className="font-bold text-[#111B37]">{breadcrumb.title}</span>
          </div>

          <span className="text-[#CBD5E1] mx-1">|</span>

          {/* Plant / Scope Selector */}
          <div className="relative" ref={siteDropdownRef}>
            <button
              type="button"
              onClick={() => setSiteDropdownOpen(!siteDropdownOpen)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#EEF5FF] text-[#0B2545] hover:bg-[#E1EDFC] text-[12px] font-semibold border border-[#BED7F7] transition-colors shadow-2xs"
              title="Filter by industrial site or view all sites"
            >
              <span className="text-[#64748B] font-normal">Plant:</span>
              <span className="font-bold">
                {selectedSite ? `${selectedSite.name}` : 'All sites'}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-[#0B2545]" />
            </button>

            {/* Scope Dropdown */}
            {siteDropdownOpen && (
              <div className="absolute left-0 top-full mt-1.5 w-64 rounded-xl bg-white border border-[#D4DFEC] shadow-xl py-2 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                <div className="px-3 pb-2 mb-1 border-b border-[#E3EAF3] flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[#94A3B8]">
                    Scope
                  </span>
                  <span className="text-[10px] bg-[#F1F5FA] px-1.5 py-0.5 rounded text-[#657794] font-semibold">
                    {sites.length} {sites.length === 1 ? 'site' : 'sites'} · {scopedResourceCount}{' '}
                    {scopedResourceCount === 1 ? 'resource' : 'resources'}
                  </span>
                </div>

                <div className="space-y-0.5 px-1">
                  <button
                    type="button"
                    onClick={() => handleSelectScope('all')}
                    className={`w-full text-left px-3 py-2 rounded-lg flex items-center justify-between transition-colors ${
                      selectedScope === 'all'
                        ? 'bg-[#EEF5FF] text-[#0B2545] font-semibold'
                        : 'hover:bg-[#F9FAFD] text-[#334568]'
                    }`}
                  >
                    <div>
                      <p className="text-[12px] font-bold">All sites</p>
                      <p className="text-[10px] text-[#94A3B8]">Entire enterprise model</p>
                    </div>
                    {selectedScope === 'all' && <Check className="w-4 h-4 text-[#0B2545]" />}
                  </button>

                  {sites.map((site) => {
                    const isSelected = selectedScope === site.id;
                    return (
                      <button
                        key={site.id}
                        type="button"
                        onClick={() => handleSelectScope(site.id)}
                        className={`w-full text-left px-3 py-2 rounded-lg flex items-center justify-between transition-colors ${
                          isSelected
                            ? 'bg-[#EEF5FF] text-[#0B2545] font-semibold'
                            : 'hover:bg-[#F9FAFD] text-[#334568]'
                        }`}
                      >
                        <div>
                          <p className="text-[12px] font-bold">{site.name}</p>
                          <p className="text-[10px] text-[#94A3B8]">{site.code}</p>
                        </div>
                        {isSelected && <Check className="w-4 h-4 text-[#0B2545]" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Data Collection Edge Status Chip (TC-UI-NAV-08) */}
          <button
            type="button"
            onClick={() => navigate('/collector/edges')}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide border border-[#D4DFEC] bg-white hover:bg-[#F8FAFC] transition-colors"
            title="Click to view Edge Collectors status"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                enrolledEdges.length > 0 && onlineEdges.length === enrolledEdges.length
                  ? 'bg-[#10B981]'
                  : 'bg-[#EF1B24]'
              }`}
            />
            <span className="text-[#334568]">
              {onlineEdges.length}/{enrolledEdges.length || 0} edges online
            </span>
          </button>
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-3">
          {/* Global Search Bar (Ctrl+K) */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="w-[260px] h-[36px] px-3 rounded-lg border border-[#D4DFEC] bg-white flex items-center justify-between text-[13px] text-[#94A3B8] hover:border-[#0B2545] hover:text-[#334568] transition-colors shadow-2xs"
          >
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-[#657794]" />
              <span>Search model, signals…</span>
            </div>
            <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-[#F1F5FA] border border-[#CBD5E1] rounded text-[#657794]">
              Ctrl K
            </kbd>
          </button>

          {/* Activity / Notification Bell */}
          <button
            type="button"
            onClick={() => navigate('/collector/diagnostics?tab=activity')}
            className="w-9 h-9 rounded-lg border border-[#E3EAF3] bg-white hover:bg-[#F9FAFD] flex items-center justify-center text-[#334568] transition-colors"
            title="System activity & audit log"
            aria-label="Activity log"
          >
            <Bell className="w-4 h-4" />
          </button>

          {/* User Menu Dropdown */}
          <div className="relative pl-2 border-l border-[#E2E8F0]" ref={userMenuRef}>
            <button
              type="button"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-2.5 p-1 rounded-lg hover:bg-[#F8FAFC] transition-colors"
            >
              <div className="w-8 h-8 rounded-full bg-[#0B2545] text-white flex items-center justify-center text-[12px] font-bold">
                <UserRound className="w-4 h-4" />
              </div>
              <div className="flex flex-col text-left">
                <span className="text-[12px] font-bold text-[#111B37] leading-tight">
                  {operatorName}
                </span>
                <span className="text-[10px] text-[#657794]">Administrator</span>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
            </button>

            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-52 rounded-xl bg-white border border-[#D4DFEC] shadow-xl py-1.5 z-50 animate-in fade-in slide-in-from-top-1 duration-150 text-[13px]">
                <div className="px-3 py-2 border-b border-[#F1F5F9]">
                  <p className="font-semibold text-[#111B37] truncate">{operatorName}</p>
                  <p className="text-[11px] text-[#64748B] truncate">Administrator</p>
                </div>

                <div className="py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setUserMenuOpen(false);
                      setChangePasswordOpen(true);
                    }}
                    className="w-full text-left px-3 py-2 flex items-center gap-2 text-[#334568] hover:bg-[#F8FAFC]"
                  >
                    <Lock className="w-4 h-4 text-[#64748B]" />
                    <span>Change password</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setUserMenuOpen(false);
                      setAboutModalOpen(true);
                    }}
                    className="w-full text-left px-3 py-2 flex items-center gap-2 text-[#334568] hover:bg-[#F8FAFC]"
                  >
                    <Info className="w-4 h-4 text-[#64748B]" />
                    <span>About FactoriX</span>
                  </button>
                </div>

                <div className="pt-1 border-t border-[#F1F5F9]">
                  <button
                    type="button"
                    onClick={() => {
                      setUserMenuOpen(false);
                      void signOut().then(() => {
                        window.location.assign('/login');
                      });
                    }}
                    className="w-full text-left px-3 py-2 flex items-center gap-2 text-[#EF1B24] hover:bg-[#FFF5F5]"
                  >
                    <LogOut className="w-4 h-4 text-[#EF1B24]" />
                    <span>Sign out</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Modals */}
      <ChangePasswordModal
        isOpen={changePasswordOpen}
        onClose={() => setChangePasswordOpen(false)}
        onSuccessToast={(msg) => setToastMessage(msg)}
      />

      <AboutFactorixModal
        isOpen={aboutModalOpen}
        onClose={() => setAboutModalOpen(false)}
      />

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 bg-[#0B2545] text-white text-[13px] font-semibold px-4 py-2.5 rounded-lg shadow-xl animate-in fade-in duration-200">
          {toastMessage}
        </div>
      )}
    </>
  );
};
