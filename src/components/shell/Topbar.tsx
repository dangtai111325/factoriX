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
} from 'lucide-react';
import { useApp } from '../../store/AppContext';

interface PlantSite {
  id: string;
  name: string;
  zone: string;
  status: 'operational' | 'warning' | 'maintenance';
  assetsCount: number;
}

const PLANT_SITES: PlantSite[] = [
  {
    id: 'plant-01',
    name: 'Plant 01 · CNC Machining',
    zone: 'Riverside Main Facility',
    status: 'operational',
    assetsCount: 18,
  },
  {
    id: 'plant-02',
    name: 'Plant 02 · Robotic Welding',
    zone: 'East Wing Automation Hall',
    status: 'operational',
    assetsCount: 24,
  },
  {
    id: 'plant-03',
    name: 'Plant 03 · Paint & Coating',
    zone: 'North Chemical Processing',
    status: 'warning',
    assetsCount: 12,
  },
  {
    id: 'plant-04',
    name: 'Plant 04 · Final Assembly',
    zone: 'South Logistics Hub',
    status: 'maintenance',
    assetsCount: 32,
  },
];

export const Topbar: React.FC = () => {
  const { isStreaming, setIsStreaming, setSearchOpen } = useApp();
  const [activeSite, setActiveSite] = useState<PlantSite>(PLANT_SITES[0]);
  const [siteDropdownOpen, setSiteDropdownOpen] = useState(false);
  const [daemonPopoverOpen, setDaemonPopoverOpen] = useState(false);

  const siteDropdownRef = useRef<HTMLDivElement>(null);
  const daemonRef = useRef<HTMLDivElement>(null);

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

  return (
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
                  activeSite.status === 'operational'
                    ? 'bg-[#0DBA67]'
                    : activeSite.status === 'warning'
                    ? 'bg-[#FFAA23]'
                    : 'bg-[#94A3B8]'
                }`}
              />
              <span>{activeSite.name}</span>
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
                    {PLANT_SITES.length} Sites
                  </span>
                </div>

                <div className="space-y-0.5 px-1">
                  {PLANT_SITES.map((site) => {
                    const isCurrent = site.id === activeSite.id;
                    return (
                      <button
                        key={site.id}
                        type="button"
                        onClick={() => {
                          setActiveSite(site);
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

        {/* Live streaming status pill */}
        <div className="flex items-center gap-2 pl-3 border-l border-[#E2E8F0]">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide ${
              isStreaming
                ? 'bg-[#E9FBF1] text-[#0DBA67] border border-[#B6F0D1]'
                : 'bg-[#FFF3DA] text-[#B96B00] border border-[#FFE2A4]'
            }`}
          >
            <Radio className={`w-3.5 h-3.5 ${isStreaming ? 'animate-pulse text-[#0DBA67]' : ''}`} />
            {isStreaming ? 'STREAMING 100ms' : 'PAUSED'}
          </span>

          <button
            type="button"
            onClick={() => setIsStreaming(!isStreaming)}
            className="p-1 rounded-md text-[#657794] hover:text-[#111B37] hover:bg-[#F1F5FA] transition-colors"
            title={isStreaming ? 'Pause live telemetry stream' : 'Resume live stream'}
          >
            {isStreaming ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 text-[#0DBA67]" />}
          </button>
        </div>

        {/* Global Collector Daemon Telemetry Health Pill (From Images 30, 34, 40, 42) */}
        <div className="relative hidden xl:block" ref={daemonRef}>
          <button
            type="button"
            onClick={() => setDaemonPopoverOpen(!daemonPopoverOpen)}
            className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[#F6F8FC] hover:bg-[#EDF2F7] border border-[#D4DFEC] text-[11px] text-[#334568] transition-colors"
            title="Click to view Edge Collector Daemon health details"
          >
            <span className="w-2 h-2 rounded-full bg-[#0DBA67] animate-pulse" />
            <span className="font-semibold text-[#111B37]">Collector Daemon</span>
            <span className="text-[#94A3B8]">·</span>
            <span className="font-mono text-[#0DBA67] font-bold">1,248 msgs/s</span>
            <span className="text-[#94A3B8]">·</span>
            <span className="font-mono text-[#657794]">18ms</span>
          </button>

          {/* Popover Card */}
          {daemonPopoverOpen && (
            <div className="absolute left-0 top-full mt-2 w-80 rounded-xl bg-white border border-[#D4DFEC] shadow-2xl p-4 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
              <div className="flex items-center justify-between pb-2 border-b border-[#E3EAF3]">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[#0DBA67]" />
                  <span className="text-[13px] font-bold text-[#111B37]">Edge Daemon Health</span>
                </div>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#E9FBF1] text-[#0DBA67]">
                  PID 4102
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 py-3 text-[12px]">
                <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                  <span className="text-[10px] text-[#94A3B8] uppercase font-bold block">Throughput</span>
                  <span className="text-[15px] font-extrabold text-[#111B37] font-mono">1,248</span>
                  <span className="text-[10px] text-[#657794] block">msgs / second</span>
                </div>
                <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                  <span className="text-[10px] text-[#94A3B8] uppercase font-bold block">Queue Depth</span>
                  <span className="text-[15px] font-extrabold text-[#0DBA67] font-mono">0.4%</span>
                  <span className="text-[10px] text-[#657794] block">42 / 10,000 pkts</span>
                </div>
                <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                  <span className="text-[10px] text-[#94A3B8] uppercase font-bold block">Ingestion Latency</span>
                  <span className="text-[15px] font-extrabold text-[#111B37] font-mono">18 ms</span>
                  <span className="text-[10px] text-[#657794] block">p99: 34 ms</span>
                </div>
                <div className="p-2.5 rounded-lg bg-[#F9FAFD] border border-[#E3EAF3]">
                  <span className="text-[10px] text-[#94A3B8] uppercase font-bold block">Daemon Uptime</span>
                  <span className="text-[15px] font-extrabold text-[#111B37] font-mono">4d 18h</span>
                  <span className="text-[10px] text-[#0DBA67] font-bold block">0 errors</span>
                </div>
              </div>

              <div className="pt-2 border-t border-[#E3EAF3] flex items-center justify-between text-[11px] text-[#657794]">
                <span>Active Channels: <strong>4 Gateways</strong></span>
                <span className="text-[#1D63BD] font-semibold hover:underline cursor-pointer">
                  View Diagnostics →
                </span>
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
          className="relative w-10 h-10 rounded-lg border border-[#E3EAF3] bg-white hover:bg-[#F9FAFD] flex items-center justify-center text-[#334568] transition-colors"
          title="System notifications"
        >
          <Bell className="w-4 h-4" />
          <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-[#EF1B24] ring-2 ring-white" />
        </button>

        {/* User Identity Profile */}
        <div className="flex items-center gap-3 pl-2 border-l border-[#E2E8F0]">
          <div className="w-9 h-9 rounded-full bg-[#FFF0F1] border border-[#FAC6C9] flex items-center justify-center text-[#EF1B24] font-bold text-[13px]">
            <UserRound className="w-4 h-4" />
          </div>
          <div className="flex flex-col text-left">
            <span className="text-[13px] font-semibold text-[#111B37] leading-tight">
              Local Operator
            </span>
            <span className="text-[11px] text-[#657794]">Plant Automation</span>
          </div>
        </div>
      </div>
    </header>
  );
};
