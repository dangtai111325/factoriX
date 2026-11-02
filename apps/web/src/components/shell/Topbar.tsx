import React, { useState, useRef, useEffect } from 'react';
import {
  Search,
  Bell,
  Play,
  Pause,
  UserRound,
  Radio,
  ChevronDown,
  Building2,
  Check,
  Activity,
  Cpu,
  Layers,
  HardDrive,
  Info,
  Sparkles,
  AlertTriangle,
  RotateCw,
} from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { useAuth } from '../../features/auth';
import { useNavigate } from 'react-router-dom';
import { DemoScenario } from '../../types';

export const Topbar: React.FC = () => {
  const {
    isStreaming,
    setIsStreaming,
    setSearchOpen,
    availablePlants,
    currentPlant,
    setCurrentPlant,
    demoScenario,
    setDemoScenario,
    isDemoMode,
    collectorLabel,
  } = useApp();
  const { state } = useAuth();
  const operatorName =
    state.status === 'authenticated'
      ? state.user.full_name || state.user.login
      : 'Administrator';

  const [siteDropdownOpen, setSiteDropdownOpen] = useState(false);
  const [daemonPopoverOpen, setDaemonPopoverOpen] = useState(false);
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [lastOnlineAt, setLastOnlineAt] = useState(() => new Date());

  const siteDropdownRef = useRef<HTMLDivElement>(null);
  const daemonRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const collectorLower = collectorLabel.toLowerCase();
  const collectorEnrolled =
    !collectorLower.includes('waiting') &&
    !collectorLower.includes('not enrolled') &&
    !collectorLower.includes('no site');
  const collectorOffline =
    collectorLower.includes('offline') ||
    collectorLower.includes('unreachable') ||
    collectorLower.includes('down');
  const collectorHealthy =
    collectorEnrolled &&
    (collectorLower.includes('healthy') || collectorLower.includes('normal'));
  const collectorPidLabel = collectorEnrolled ? 'ENROLLED' : 'NOT ENROLLED';

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (siteDropdownRef.current && !siteDropdownRef.current.contains(e.target as Node)) {
        setSiteDropdownOpen(false);
      }
      if (daemonRef.current && !daemonRef.current.contains(e.target as Node)) {
        setDaemonPopoverOpen(false);
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
    <header className="fx-topbar select-none relative z-30">
      {/* Left: Breadcrumbs / Interactive Plant Switcher */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-[13px] text-[#657794]">
          <span className="font-semibold text-[#111B37]">FactoriX Industrial IoT</span>
          <span className="text-[#CBD5E1]">/</span>

          {/* Interactive Plant / Site Switcher Dropdown (From Images 32 & 46) */}
          <div className="relative" ref={siteDropdownRef}>
            <button
              type="button"
              onClick={() => setSiteDropdownOpen(!siteDropdownOpen)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#EEF5FF] text-[#1D63BD] hover:bg-[#E1EDFC] text-[12px] font-semibold border border-[#BED7F7] transition-colors shadow-2xs"
              title="Click to switch physical plant or line"
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
              <span>{currentPlant.name}</span>
              <ChevronDown className="w-3.5 h-3.5 text-[#1D63BD]" />
            </button>

            {/* Dropdown Menu */}
            {siteDropdownOpen && (
              <div className="absolute left-0 top-full mt-1.5 w-72 rounded-xl bg-white border border-[#D4DFEC] shadow-xl py-2 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                <div className="px-3 pb-2 mb-1 border-b border-[#E3EAF3] flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-[#94A3B8]">
                    Select Industrial Facility
                  </span>
                  <span className="text-[10px] bg-[#F1F5FA] px-1.5 py-0.5 rounded text-[#657794] font-semibold">
                    {availablePlants.length} Sites
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
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              site.status === 'operational'
                                ? 'bg-[#0DBA67]'
                                : site.status === 'warning'
                                ? 'bg-[#FFAA23]'
                                : 'bg-[#94A3B8]'
                            }`}
                          />
                          <div>
                            <p className="text-[12px] font-bold leading-snug">{site.name}</p>
                            <p className="text-[10px] text-[#94A3B8] leading-tight">{site.zone}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-[#657794] font-medium">
                            {site.assetsCount} assets
                          </span>
                          {isCurrent && <Check className="w-3.5 h-3.5 text-[#1D63BD]" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Global Demo Mode Pill (Review Section 10.A & FX-01) */}
        {isDemoMode && (
          <div className="flex items-center gap-1.5 pl-2 border-l border-[#E2E8F0]">
            <span
              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-[#FFF8E7] text-[#B96B00] text-[11px] font-bold border border-[#FFE2A4] shadow-2xs"
              title="Application is running with deterministic simulated telemetry"
            >
              <Sparkles className="w-3 h-3 text-[#B96B00]" />
              DEMO MODE
            </span>
          </div>
        )}

        {/* Visualization stream pause button (Review FX-17) */}
        <div className="flex items-center gap-2 pl-2 border-l border-[#E2E8F0]">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide ${
              !isStreaming
                ? 'bg-[#FFF3DA] text-[#B96B00] border border-[#FFE2A4]'
                : collectorHealthy
                ? 'bg-[#E9FBF1] text-[#0DBA67] border border-[#B6F0D1]'
                : 'bg-[#F1F5FA] text-[#657794] border border-[#D4DFEC]'
            }`}
            title={
              !isStreaming
                ? 'Visualization paused'
                : collectorHealthy
                ? 'UI refresh active with enrolled collector'
                : 'UI refresh active — collector not confirmed healthy'
            }
          >
            <Radio
              className={`w-3.5 h-3.5 ${
                isStreaming && collectorHealthy ? 'animate-pulse text-[#0DBA67]' : ''
              }`}
            />
            {!browserOnline ? 'OFFLINE' : isStreaming ? 'LIVE REFRESH' : 'PAUSED'}
          </span>

          <button
            type="button"
            onClick={() => setIsStreaming(!isStreaming)}
            className="p-1 rounded-md text-[#657794] hover:text-[#111B37] hover:bg-[#F1F5FA] transition-colors"
            title={isStreaming ? 'Pause Visualization (Freezes UI charts)' : 'Resume Live Visualization'}
          >
            {isStreaming ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 text-[#0DBA67]" />}
          </button>
        </div>

        {/* Global Collector Daemon Telemetry Health Pill (From Images 30, 34, 40, 42) */}
        <div className="relative hidden xl:block" ref={daemonRef}>
          <button
            type="button"
            onClick={() => setDaemonPopoverOpen(!daemonPopoverOpen)}
            className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] transition-colors border ${
              collectorOffline
                ? 'bg-[#FFF5F5] hover:bg-[#FFEBEB] border-[#FAC6C9] text-[#EF1B24]'
                : 'bg-[#F6F8FC] hover:bg-[#EDF2F7] border-[#D4DFEC] text-[#334568]'
            }`}
            title="Click to view Edge Collector Daemon health"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                collectorHealthy
                  ? 'bg-[#0DBA67] animate-pulse'
                  : collectorOffline
                  ? 'bg-[#EF1B24]'
                  : 'bg-[#94A3B8]'
              }`}
            />
            <span className="font-semibold text-[#111B37]">{collectorLabel}</span>
          </button>

          {/* Popover Card */}
          {daemonPopoverOpen && (
            <div className="absolute left-0 top-full mt-2 w-88 rounded-xl bg-white border border-[#D4DFEC] shadow-2xl p-4 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
              <div className="flex items-center justify-between pb-2 border-b border-[#E3EAF3]">
                <div className="flex items-center gap-2">
                  <Activity
                    className={`w-4 h-4 ${collectorHealthy ? 'text-[#0DBA67]' : 'text-[#94A3B8]'}`}
                  />
                  <span className="text-[13px] font-bold text-[#111B37]">Collector</span>
                </div>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    collectorEnrolled
                      ? 'bg-[#E9FBF1] text-[#0DBA67]'
                      : 'bg-[#F1F5FA] text-[#657794]'
                  }`}
                >
                  {collectorPidLabel}
                </span>
              </div>

              {/* Demo Scenario Controller (Review FX-06) */}
              {isDemoMode && <div className="mt-2.5 p-2.5 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0]">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-bold text-[#475569] uppercase tracking-wider">
                    Test Scenario Mode
                  </span>
                  <span className="text-[10px] text-[#64748B]">Deterministic Simulation</span>
                </div>
                <select
                  value={demoScenario}
                  onChange={(e) => setDemoScenario(e.target.value as DemoScenario)}
                  className="w-full text-[12px] font-semibold bg-white border border-[#CBD5E1] rounded-md px-2 py-1 text-[#1E293B] focus:outline-none focus:border-[#2A82E7]"
                >
                  <option value="healthy">🟢 Healthy (All Gateways Online)</option>
                  <option value="degraded_modbus">🟡 Modbus Exception (Illegal Address 0x02)</option>
                  <option value="timeout_opcua">🔴 OPC UA Browse Timeout (5000ms)</option>
                  <option value="auth_fail_mqtt">🔴 MQTT Auth Error (CONNACK 0x05)</option>
                  <option value="offline">⚫ Network Host Unreachable (ECONNREFUSED)</option>
                </select>
              </div>}

              <div className="grid grid-cols-2 gap-2.5 py-3 text-[12px]">
                <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                  <span className="text-[10px] text-[#94A3B8] uppercase font-bold block">Throughput</span>
                  <span className="text-[15px] font-extrabold text-[#111B37] font-mono">
                    —
                  </span>
                  <span className="text-[10px] text-[#657794] block">msgs / second</span>
                </div>
                <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                  <span className="text-[10px] text-[#94A3B8] uppercase font-bold block">Queue Depth</span>
                  <span className="text-[15px] font-extrabold text-[#0DBA67] font-mono">
                    —
                  </span>
                  <span className="text-[10px] text-[#657794] block">Ring Buffer</span>
                </div>
                <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                  <span className="text-[10px] text-[#94A3B8] uppercase font-bold block">Latency</span>
                  <span className="text-[15px] font-extrabold text-[#111B37] font-mono">
                    —
                  </span>
                  <span className="text-[10px] text-[#657794] block">Roundtrip Time</span>
                </div>
                <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                  <span className="text-[10px] text-[#94A3B8] uppercase font-bold block">Daemon Uptime</span>
                  <span className="text-[15px] font-extrabold text-[#111B37] font-mono">—</span>
                  <span className="text-[10px] text-[#0DBA67] font-bold block">Edge</span>
                </div>
              </div>

              <div className="pt-2 border-t border-[#E3EAF3] flex items-center justify-between text-[11px] text-[#657794]">
                <span>{collectorLabel}</span>
                <button
                  type="button"
                  onClick={() => {
                    setDaemonPopoverOpen(false);
                    navigate('/live/diagnostics');
                  }}
                  className="text-[#1D63BD] font-semibold hover:underline"
                >
                  View Diagnostics →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-3.5">
        {/* Global Search Bar */}
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="w-[280px] h-[38px] px-3 rounded-lg border border-[#D4DFEC] bg-white flex items-center justify-between text-[13px] text-[#94A3B8] hover:border-[#2A82E7] hover:text-[#334568] transition-colors shadow-2xs"
        >
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-[#657794]" />
            <span>Search signals, tags, assets...</span>
          </div>
          <kbd className="px-1.5 py-0.5 text-[11px] font-mono bg-[#F1F5FA] border border-[#CBD5E1] rounded text-[#657794]">
            Ctrl K
          </kbd>
        </button>

        {/* Notification Bell */}
        <button
          type="button"
          onClick={() => navigate('/live/activity')}
          className="relative w-10 h-10 rounded-lg border border-[#E3EAF3] bg-white hover:bg-[#F9FAFD] flex items-center justify-center text-[#334568] transition-colors"
          title="System notifications & activity log"
        >
          <Bell className="w-4 h-4" />
        </button>

        {/* User Identity Profile */}
        <div className="flex items-center gap-3 pl-2 border-l border-[#E2E8F0]">
          <div className="w-9 h-9 rounded-full bg-[#FFF0F1] border border-[#FAC6C9] flex items-center justify-center text-[#EF1B24] font-bold text-[13px]">
            <UserRound className="w-4 h-4" />
          </div>
          <div className="flex flex-col text-left">
            <span className="text-[13px] font-semibold text-[#111B37] leading-tight">
              {operatorName || 'Administrator'}
            </span>
            <span className="text-[11px] text-[#657794]">Administrator</span>
          </div>
        </div>
      </div>
    </header>
    </>
  );
};
