import React, { useMemo, useState, useRef, useEffect } from 'react';
import { Search, Bell, UserRound, ChevronDown, Check, Menu } from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { useAuth } from '../../features/auth';
import { useLocation, useNavigate } from 'react-router-dom';

type TopbarProps = {
  onMenuClick?: () => void;
};

function breadcrumbFor(pathname: string): string {
  if (pathname.startsWith('/factory/structure')) return 'Factory Model › Structure';
  if (pathname.startsWith('/factory/layout')) return 'Factory Model › Layout';
  if (pathname.startsWith('/factory/graph')) return 'Factory Model › Knowledge Graph';
  if (pathname.startsWith('/acquisition/connections')) return 'Acquisition › Connections';
  if (pathname.startsWith('/acquisition/edges')) return 'Acquisition › Edges';
  if (pathname.startsWith('/acquisition/add-data')) return 'Acquisition › Add Data';
  if (pathname.startsWith('/signals/output-groups')) return 'Signals › Output Groups';
  if (pathname.startsWith('/signals')) return 'Signals › Catalog';
  if (pathname.startsWith('/live/monitor')) return 'Live › Monitor';
  if (pathname.startsWith('/live/diagnostics')) return 'Live › Diagnostics';
  if (pathname.startsWith('/live/activity')) return 'Live › Activity Log';
  if (pathname.startsWith('/administration')) return 'Administration';
  if (pathname.startsWith('/profile')) return 'Profile';
  if (pathname.startsWith('/overview')) return 'Overview';
  return 'FactoriX';
}

function relativeAge(iso?: string): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec} s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  return `${Math.floor(sec / 3600)} h ago`;
}

type AlertItem = { id: string; title: string; detail: string; href: string; unread: boolean };

export const Topbar: React.FC<TopbarProps> = ({ onMenuClick }) => {
  const {
    setSearchOpen,
    availablePlants,
    currentPlant,
    setCurrentPlant,
    resources,
    edges,
    siteNameById,
    signals,
    connections,
  } = useApp();
  const { state, signOut } = useAuth();
  const operatorName =
    state.status === 'authenticated'
      ? state.user.full_name || state.user.login
      : 'Administrator';
  const location = useLocation();
  const navigate = useNavigate();
  const [smtpConfigured, setSmtpConfigured] = useState<boolean | null>(null);

  const [siteDropdownOpen, setSiteDropdownOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [readIds, setReadIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('fx.alerts.read:v1');
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [lastOnlineAt, setLastOnlineAt] = useState(() => new Date());
  const siteDropdownRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/v1/auth/status', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        setSmtpConfigured(Boolean(body.smtp_configured ?? body.password_recovery_enabled));
      })
      .catch(() => {
        if (!cancelled) setSmtpConfigured(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const siteCount = resources.filter((r) => r.type === 'site').length;
  const offlineEdge = edges.find(
    (e) => e.enrollmentStatus === 'ENROLLED' && String(e.health || '').toUpperCase() === 'OFFLINE',
  );
  const offlineSiteName = offlineEdge && (siteNameById[offlineEdge.siteId] || offlineEdge.name);

  // CR-S03: up to 10 alerts from edge offline, connection error, signal BAD >5min
  const alerts = useMemo(() => {
    const items: AlertItem[] = [];
    for (const edge of edges) {
      if (edge.enrollmentStatus === 'ENROLLED' && String(edge.health || '').toUpperCase() === 'OFFLINE') {
        items.push({
          id: `edge-offline-${edge.id}`,
          title: 'Edge offline',
          detail: `${siteNameById[edge.siteId] || edge.name} · last seen ${relativeAge(edge.lastHeartbeat) || 'unknown'}`,
          href: '/acquisition/edges',
          unread: !readIds.has(`edge-offline-${edge.id}`),
        });
      }
    }
    for (const conn of connections) {
      if (conn.status === 'disconnected' || conn.status === 'warning') {
        items.push({
          id: `conn-${conn.id}`,
          title: 'Connection error',
          detail: `${conn.name} · ${conn.status}`,
          href: '/acquisition/connections',
          unread: !readIds.has(`conn-${conn.id}`),
        });
      }
    }
    const fiveMin = 5 * 60 * 1000;
    for (const sig of signals) {
      if (sig.quality !== 'BAD') continue;
      const ts = Date.parse(sig.lastUpdated || '');
      if (!Number.isFinite(ts) || Date.now() - ts < fiveMin) continue;
      items.push({
        id: `sig-bad-${sig.id}`,
        title: 'Signal BAD',
        detail: `${sig.name} · ${relativeAge(sig.lastUpdated)}`,
        href: '/live/monitor',
        unread: !readIds.has(`sig-bad-${sig.id}`),
      });
    }
    return items.slice(0, 10);
  }, [edges, connections, signals, siteNameById, readIds]);

  const unreadCount = alerts.filter((a) => a.unread).length;

  const persistRead = (next: Set<string>) => {
    setReadIds(next);
    try {
      localStorage.setItem('fx.alerts.read:v1', JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  };

  const markAllRead = () => {
    const next = new Set(readIds);
    alerts.forEach((a) => next.add(a.id));
    persistRead(next);
  };

  const markRead = (id: string) => {
    if (readIds.has(id)) return;
    const next = new Set(readIds);
    next.add(id);
    persistRead(next);
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (siteDropdownRef.current && !siteDropdownRef.current.contains(e.target as Node)) {
        setSiteDropdownOpen(false);
      }
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false);
      }
      if (userRef.current && !userRef.current.contains(e.target as Node)) {
        setUserOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const goOffline = () => setBrowserOnline(false);
    const goOnline = () => {
      setBrowserOnline(true);
      setLastOnlineAt(new Date());
    };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  return (
    <>
      {!browserOnline && (
        <div className="bg-[#111B37] text-white text-[12px] font-semibold px-4 py-2 text-center">
          Connection to appliance lost — data may be stale (last update{' '}
          {lastOnlineAt.toLocaleTimeString()})
        </div>
      )}
      {browserOnline && offlineEdge && (
        <div className="bg-[#FFF5F5] text-[#DB2028] text-[12px] font-semibold px-4 py-2 text-center border-b border-[#FAC6C9]">
          Data collection on {offlineSiteName || 'an edge'} is offline
          {offlineEdge.lastHeartbeat ? ` · last seen ${relativeAge(offlineEdge.lastHeartbeat)}` : ''}.{' '}
          <button
            type="button"
            className="underline font-bold"
            onClick={() => navigate('/acquisition/edges')}
          >
            Open Edges
          </button>
        </div>
      )}
      {smtpConfigured === false && (
        <div className="bg-[#FFF8E7] text-[#B96B00] text-[12px] font-semibold px-4 py-2 text-center border-b border-[#FFE2A4]">
          Password recovery is disabled until email is set up.{' '}
          <button
            type="button"
            className="underline font-bold"
            onClick={() => navigate('/administration')}
          >
            Open Administration
          </button>
        </div>
      )}
      <header className="fx-topbar select-none relative z-30">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            className="md:hidden w-9 h-9 rounded-lg border border-[#E3EAF3] bg-white flex items-center justify-center text-[#334568]"
            aria-label="Open navigation"
            onClick={onMenuClick}
          >
            <Menu className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2 text-[13px] text-[#657794] min-w-0">
            <span className="font-semibold text-[#111B37] truncate">{breadcrumbFor(location.pathname)}</span>
            <span className="text-[#CBD5E1]">·</span>

            <div className="relative" ref={siteDropdownRef}>
              <button
                type="button"
                onClick={() => setSiteDropdownOpen(!siteDropdownOpen)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#EEF5FF] text-[#1D63BD] hover:bg-[#E1EDFC] text-[12px] font-semibold border border-[#BED7F7] transition-colors"
                title="Switch plant"
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    currentPlant.status === 'operational'
                      ? 'bg-[#0DBA67]'
                      : currentPlant.status === 'warning'
                        ? 'bg-[#FFAA23]'
                        : 'bg-[#94A3B8]'
                  }`}
                />
                <span className="truncate max-w-[140px]">{currentPlant.name}</span>
                <ChevronDown className="w-3.5 h-3.5 text-[#1D63BD]" />
              </button>
              <span className="text-[11px] font-semibold text-[#657794] whitespace-nowrap">
                {siteCount || (currentPlant.id ? 1 : 0)} site
                {(siteCount || (currentPlant.id ? 1 : 0)) === 1 ? '' : 's'} · {resources.length} resource
                {resources.length === 1 ? '' : 's'}
              </span>

              {siteDropdownOpen && (
                <div className="absolute left-0 top-full mt-1.5 w-72 rounded-xl bg-white border border-[#D4DFEC] shadow-xl py-2 z-50">
                  <div className="px-3 pb-2 mb-1 border-b border-[#E3EAF3] flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[#94A3B8]">Plant</span>
                    <span className="text-[10px] bg-[#F1F5FA] px-1.5 py-0.5 rounded text-[#657794] font-semibold">
                      {siteCount} site{siteCount === 1 ? '' : 's'} · {resources.length} resource
                      {resources.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="space-y-0.5 px-1">
                    {availablePlants.map((site) => {
                      const isCurrent = site.id === currentPlant.id;
                      return (
                        <button
                          key={site.id}
                          type="button"
                          onClick={() => {
                            setCurrentPlant(site);
                            setSiteDropdownOpen(false);
                          }}
                          className={`w-full text-left px-3 py-2 rounded-lg flex items-center justify-between transition-colors ${
                            isCurrent
                              ? 'bg-[#EEF5FF] text-[#1D63BD]'
                              : 'hover:bg-[#F9FAFD] text-[#334568]'
                          }`}
                        >
                          <div>
                            <p className="text-[12px] font-bold leading-snug">{site.name}</p>
                            <p className="text-[10px] text-[#94A3B8] leading-tight">{site.zone}</p>
                          </div>
                          {isCurrent && <Check className="w-3.5 h-3.5 text-[#1D63BD]" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3.5 shrink-0">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="min-w-[180px] w-[220px] max-w-[240px] h-9 px-3 rounded-lg border border-[#D4DFEC] bg-white flex items-center justify-between text-[13px] text-[#94A3B8] hover:border-[#2A82E7] hover:text-[#334568] transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Search className="w-4 h-4 text-[#657794] shrink-0" />
              <span className="truncate">Search…</span>
            </div>
            <kbd className="px-1.5 py-0.5 text-[11px] font-mono bg-[#F1F5FA] border border-[#CBD5E1] rounded text-[#657794] shrink-0">
              Ctrl K
            </kbd>
          </button>

          <div className="relative" ref={bellRef}>
            <button
              type="button"
              onClick={() => setBellOpen(!bellOpen)}
              className="relative w-9 h-9 rounded-lg border border-[#E3EAF3] bg-white hover:bg-[#F9FAFD] flex items-center justify-center text-[#334568] transition-colors"
              title="Alerts"
              aria-label={unreadCount ? `${unreadCount} unread alerts` : 'Alerts'}
            >
              <Bell className="w-4 h-4" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-[#EF1B24] text-white text-[10px] font-bold flex items-center justify-center">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>
            {bellOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-80 rounded-xl bg-white border border-[#D4DFEC] shadow-xl z-50 overflow-hidden">
                <div className="px-3 py-2 border-b border-[#E3EAF3] flex items-center justify-between">
                  <span className="text-[12px] font-bold text-[#111B37]">Alerts</span>
                  <button
                    type="button"
                    className="text-[11px] font-semibold text-[#EF1B24] hover:underline"
                    onClick={markAllRead}
                  >
                    Mark all read
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {!alerts.length && (
                    <p className="p-4 text-[12px] text-[#657794]">No alerts right now.</p>
                  )}
                  {alerts.map((alert) => (
                    <button
                      key={alert.id}
                      type="button"
                      className={`w-full text-left px-3 py-2.5 border-b border-[#F1F5FA] hover:bg-[#F9FAFD] ${
                        alert.unread ? 'bg-[#FFF7F8]' : ''
                      }`}
                      onClick={() => {
                        markRead(alert.id);
                        setBellOpen(false);
                        navigate(alert.href);
                      }}
                    >
                      <div className="flex items-start gap-2">
                        {alert.unread && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#EF1B24] shrink-0" />}
                        <div className="min-w-0">
                          <p className="text-[12px] font-bold text-[#111B37]">{alert.title}</p>
                          <p className="text-[11px] text-[#657794] truncate">{alert.detail}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-[12px] font-semibold text-[#1D63BD] hover:bg-[#F9FAFD] border-t border-[#E3EAF3]"
                  onClick={() => {
                    setBellOpen(false);
                    navigate('/live/activity');
                  }}
                >
                  View all
                </button>
              </div>
            )}
          </div>

          <div className="relative pl-2 border-l border-[#E2E8F0]" ref={userRef}>
            <button
              type="button"
              className="flex items-center gap-3"
              onClick={() => setUserOpen(!userOpen)}
            >
              <div className="w-9 h-9 rounded-full bg-[#FFF0F1] border border-[#FAC6C9] flex items-center justify-center text-[#EF1B24] font-bold text-[13px]">
                <UserRound className="w-4 h-4" />
              </div>
              <div className="flex flex-col text-left hidden sm:flex">
                <span className="text-[13px] font-semibold text-[#111B37] leading-tight">
                  {operatorName || 'Administrator'}
                </span>
                <span className="text-[11px] text-[#657794]">Administrator</span>
              </div>
            </button>
            {userOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-48 rounded-xl bg-white border border-[#D4DFEC] shadow-xl py-1 z-50">
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-[12px] hover:bg-[#F9FAFD]"
                  onClick={() => {
                    setUserOpen(false);
                    navigate('/profile');
                  }}
                >
                  Profile
                </button>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-[12px] hover:bg-[#F9FAFD]"
                  onClick={() => {
                    setUserOpen(false);
                    navigate('/profile?tab=password');
                  }}
                >
                  Change password
                </button>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-[12px] hover:bg-[#F9FAFD]"
                  onClick={() => {
                    setUserOpen(false);
                    navigate('/administration');
                  }}
                >
                  Administration
                </button>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-[12px] hover:bg-[#F9FAFD]"
                  onClick={() => {
                    setUserOpen(false);
                    navigate('/about');
                  }}
                >
                  About
                </button>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-[12px] text-[#F2343B] hover:bg-[#FFF0F1]"
                  onClick={() => {
                    setUserOpen(false);
                    void signOut().then(() => window.location.assign('/login'));
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
    </>
  );
};
