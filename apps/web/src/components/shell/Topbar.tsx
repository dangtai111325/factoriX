import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Search,
  Bell,
  UserRound,
  ChevronDown,
  Check,
  Lock,
  Info,
  LogOut,
  AlertCircle,
  Menu,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { useAuth } from '../../features/auth';
import { CollectorState, useCollectorHealth } from './collectorHealth';
import { ChangePasswordModal } from '../modals/ChangePasswordModal';
import { AboutFactorixModal } from '../modals/AboutFactorixModal';
import { ConnectivityBanner } from './ConnectivityBanner';
import { toggleSidebar, useSidebarOpen } from './sidebarState';

const ROUTE_BREADCRUMBS: Record<string, { group?: string; title: string }> = {
  '/overview': { title: 'Overview' },
  '/factory/structure': { group: 'Factory Model', title: 'Hierarchy Structure' },
  '/factory/graph': { group: 'Factory Model', title: 'Knowledge Graph' },
  '/collector/connections': { group: 'Data Collector', title: 'Connections' },
  '/collector/signals': { group: 'Data Collector', title: 'Signals' },
  '/collector/add-data': { group: 'Data Collector', title: 'Add Data' },
  '/models': { group: 'Data Models', title: 'Model Catalog' },
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
  const { setSearchOpen, resources } = useApp();
  const collector = useCollectorHealth();
  const { state, signOut } = useAuth();
  const navOpen = useSidebarOpen();
  const bannerRef = useRef<HTMLDivElement>(null);

  // Banners sit in a fixed stack under the top bar; their height pushes the page content down
  // (--fx-banner-height is read by .fx-main) instead of covering it.
  useEffect(() => {
    const el = bannerRef.current;
    if (!el) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty('--fx-banner-height', `${el.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.setProperty('--fx-banner-height', '0px');
    };
  }, []);

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

  // Data collector status (TC-UI-NAV-08): effective edge health, updated by polling and the live stream.
  // Only a collector that had reported before and then stopped raises the red banner.
  const offlineEdge = collector.offlineEdges[0];
  const pillDot: Record<CollectorState, string> = {
    loading: 'bg-[#CBD5E1]',
    not_configured: 'bg-[#94A3B8]',
    waiting: 'bg-[#94A3B8]',
    online: 'bg-[#10B981]',
    degraded: 'bg-[#F59E0B]',
    offline: 'bg-[#EF1B24]',
    unknown: 'bg-[#CBD5E1]',
  };

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

  // R4-UI-01: Esc closes the open menu and returns focus to its button.
  const userMenuButtonRef = useRef<HTMLButtonElement>(null);
  const siteButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!userMenuOpen && !siteDropdownOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (userMenuOpen) {
        setUserMenuOpen(false);
        userMenuButtonRef.current?.focus();
      }
      if (siteDropdownOpen) {
        setSiteDropdownOpen(false);
        siteButtonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [userMenuOpen, siteDropdownOpen]);

  // Toast timer
  useEffect(() => {
    if (!toastMessage) return;
    const t = setTimeout(() => setToastMessage(null), 3000);
    return () => clearTimeout(t);
  }, [toastMessage]);

  return (
    <>
      <div ref={bannerRef} className="fx-banner-stack">
      {/* R3-OV-01: browser offline / appliance unreachable / live stream interrupted. */}
      <ConnectivityBanner />
      {/* Offline banner if an enrolled edge is offline */}
      {offlineEdge && (
        <div className="bg-[#EF1B24] text-white text-[12px] font-semibold px-4 py-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 shadow-xs">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>
              Data collection for{' '}
              {sites.find((s) => s.id === offlineEdge.siteId)?.name || offlineEdge.name}{' '}
              stopped
              {offlineEdge.lastHeartbeat
                ? ` (last report at ${new Date(offlineEdge.lastHeartbeat).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
                : ''}
            </span>
          </div>
          <button
            type="button"
            onClick={() => navigate('/collector/connections')}
            className="underline hover:text-white/80 text-[11px] font-bold"
          >
            View connections
          </button>
        </div>
      )}
      </div>

      <header className="fx-topbar select-none relative z-30">
        {/* Left: Breadcrumbs & Plant Selector */}
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          {/* R3-UI-01: hamburger for the off-canvas navigation below 768 px. */}
          <button
            type="button"
            onClick={toggleSidebar}
            className="md:hidden -ml-1 p-2 rounded-lg text-[#334568] hover:bg-[#F1F5FA] shrink-0"
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            aria-controls="fx-main-navigation"
            aria-expanded={navOpen}
          >
            <Menu className="w-5 h-5" aria-hidden="true" />
          </button>
          {/* Breadcrumbs */}
          <div className="flex items-center gap-2 text-[13px] text-[#657794] min-w-0">
            {breadcrumb.group && (
              <>
                <span className="hidden md:inline font-medium text-[#475569] whitespace-nowrap">{breadcrumb.group}</span>
                <span className="hidden md:inline text-[#CBD5E1]">›</span>
              </>
            )}
            <span className="font-bold text-[#111B37] truncate">{breadcrumb.title}</span>
          </div>

          <span className="hidden md:inline text-[#CBD5E1] mx-1">|</span>

          {/* Plant / Scope Selector */}
          <div className="relative hidden md:block" ref={siteDropdownRef}>
            <button
              ref={siteButtonRef}
              type="button"
              onClick={() => setSiteDropdownOpen(!siteDropdownOpen)}
              aria-haspopup="listbox"
              aria-expanded={siteDropdownOpen}
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

          {/* Data Collection Status Chip */}
          <button
            type="button"
            onClick={() => navigate('/collector/connections')}
            className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide border border-[#D4DFEC] bg-white hover:bg-[#F8FAFC] transition-colors whitespace-nowrap shrink-0"
            title={`${collector.detail} Open Connections.`}
            aria-label={`Collector: ${collector.label}. ${collector.detail} Open Connections.`}
          >
            <span
              aria-hidden="true"
              className={`w-2 h-2 rounded-full ${pillDot[collector.state]}`}
            />
            <span className="hidden sm:inline text-[#334568]">
              Collector: {collector.state === 'waiting' ? 'waiting' : collector.state === 'unknown' ? 'unknown (no connection to appliance)' : collector.label.toLowerCase()}
            </span>
          </button>
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
          {/* Global Search Bar (Ctrl+K) */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search resources, signals, connections and data models (Ctrl+K)"
            aria-keyshortcuts="Control+K Meta+K"
            title="Search resources, signals, connections and data models (Ctrl+K)"
            className="w-9 lg:w-[200px] xl:w-[260px] 2xl:w-[340px] h-[36px] px-0 lg:px-3 shrink-0 whitespace-nowrap rounded-lg border border-[#D4DFEC] bg-white flex items-center justify-center lg:justify-between gap-2 text-[13px] text-[#94A3B8] hover:border-[#0B2545] hover:text-[#334568] transition-colors shadow-2xs"
          >
            {/* R4-UI-02: one line at every width; the label names data models too. */}
            <div className="flex items-center gap-2 min-w-0">
              <Search className="w-4 h-4 shrink-0 text-[#657794]" />
              <span className="hidden lg:inline xl:hidden truncate">Search…</span>
              <span className="hidden xl:inline 2xl:hidden truncate">Search signals, models…</span>
              <span className="hidden 2xl:inline truncate">Search resources, signals, models…</span>
            </div>
            <kbd className="hidden lg:inline shrink-0 px-1.5 py-0.5 text-[10px] font-mono bg-[#F1F5FA] border border-[#CBD5E1] rounded text-[#657794]">
              Ctrl K
            </kbd>
          </button>

          {/* Activity / Notification Bell */}
          <button
            type="button"
            onClick={() => navigate('/overview')}
            className="w-9 h-9 rounded-lg border border-[#E3EAF3] bg-white hover:bg-[#F9FAFD] flex items-center justify-center text-[#334568] transition-colors"
            title="Overview and recent activity"
            aria-label="Overview and recent activity"
          >
            <Bell className="w-4 h-4" />
          </button>

          {/* User Menu Dropdown */}
          <div className="relative pl-1 sm:pl-2 border-l border-[#E2E8F0]" ref={userMenuRef}>
            <button
              ref={userMenuButtonRef}
              type="button"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              aria-label={`Account menu for ${operatorName}`}
              className="flex items-center gap-2.5 p-1 rounded-lg hover:bg-[#F8FAFC] transition-colors"
            >
              <div className="w-8 h-8 rounded-full bg-[#0B2545] text-white flex items-center justify-center text-[12px] font-bold">
                <UserRound className="w-4 h-4" />
              </div>
              <div className="hidden md:flex flex-col text-left">
                <span className="text-[12px] font-bold text-[#111B37] leading-tight">
                  {operatorName}
                </span>
                <span className="text-[10px] text-[#657794]">Administrator</span>
              </div>
              <ChevronDown className="hidden sm:block w-3.5 h-3.5 text-[#64748B]" />
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
