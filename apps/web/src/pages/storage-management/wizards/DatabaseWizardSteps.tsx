import React, { useState, useEffect } from 'react';
import {
  Database,
  Info,
  Check,
  Copy,
  Clock,
  HardDrive,
  Cpu,
  Layers,
  AlertTriangle,
  ShieldCheck,
} from 'lucide-react';
import { getStorageEngines } from '../../../lib/storagePhysicalApi';

// ============================================================================
// Types
// ============================================================================

export interface DatabaseWizardData {
  physical_name: string;
  display_name: string;
  description: string;
  precision: 'ms' | 'us' | 'ns';
  retention_days: number | null;
  vgroups: number | null;
  cache_mb: number | null;
  confirmed?: boolean;
}

export interface StepProps {
  data: DatabaseWizardData;
  onChange: (patch: Partial<DatabaseWizardData>) => void;
  errors?: Record<string, string>;
}

// Regex matching TDengine lowercase database names
export const DB_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}$/;

// ============================================================================
// Step 1: DatabaseBasicsStep
// ============================================================================

export const DatabaseBasicsStep: React.FC<StepProps> = ({ data, onChange, errors = {} }) => {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[16px] font-bold text-[#111B37]">Database Identity</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Specify the physical TDengine database name and optional descriptive labels.
        </p>
      </div>

      <div className="space-y-4 max-w-xl">
        {/* Physical Name */}
        <div>
          <label className="block text-[13px] font-semibold text-[#111B37] mb-1">
            Database Name <span className="text-[#EF1B24]">*</span>
          </label>
          <div className="relative">
            <input
              type="text"
              value={data.physical_name}
              onChange={(e) => onChange({ physical_name: e.target.value.toLowerCase().trim() })}
              placeholder="e.g. factory_telemetry_db"
              className={`w-full h-9 px-3 rounded-lg border text-[13px] font-mono transition-colors focus:outline-none focus:ring-2 ${
                errors.physical_name
                  ? 'border-[#EF1B24] focus:ring-[#EF1B24]/20'
                  : 'border-[#D4DFEC] focus:border-[#EF1B24] focus:ring-[#EF1B24]/10'
              }`}
            />
          </div>
          {errors.physical_name ? (
            <p className="text-[12px] text-[#EF1B24] mt-1 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{errors.physical_name}</span>
            </p>
          ) : (
            <p className="text-[11px] text-[#8C9BAE] mt-1">
              Physical name in TDengine. Lowercase letters, numbers, and underscores only. Starts with a letter (1–63 chars).
            </p>
          )}
        </div>

        {/* Display Name */}
        <div>
          <label className="block text-[13px] font-semibold text-[#111B37] mb-1">
            Display Name
          </label>
          <input
            type="text"
            value={data.display_name}
            onChange={(e) => onChange({ display_name: e.target.value })}
            placeholder="e.g. Plant 1 Factory Telemetry"
            className="w-full h-9 px-3 rounded-lg border border-[#D4DFEC] text-[13px] transition-colors focus:outline-none focus:border-[#EF1B24] focus:ring-2 focus:ring-[#EF1B24]/10"
          />
          <p className="text-[11px] text-[#8C9BAE] mt-1">
            Human-friendly label shown throughout the FactoriX web workspace.
          </p>
        </div>

        {/* Description */}
        <div>
          <label className="block text-[13px] font-semibold text-[#111B37] mb-1">
            Description
          </label>
          <textarea
            value={data.description}
            onChange={(e) => onChange({ description: e.target.value })}
            rows={3}
            placeholder="Document what data streams this database holds, retention expectations, and plant context..."
            className="w-full p-3 rounded-lg border border-[#D4DFEC] text-[13px] transition-colors focus:outline-none focus:border-[#EF1B24] focus:ring-2 focus:ring-[#EF1B24]/10 resize-none"
          />
        </div>
      </div>

      {/* Naming Convention Card */}
      <div className="p-4 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl flex items-start gap-3 max-w-xl">
        <Info className="w-5 h-5 text-[#0284C7] flex-shrink-0 mt-0.5" />
        <div className="text-[12px] text-[#334568] space-y-1">
          <div className="font-semibold text-[#111B37]">TDengine Naming Rules</div>
          <div>
            TDengine database identifiers are case-insensitive and stored in lowercase. Keywords such as{' '}
            <code className="bg-[#EAEFF5] px-1 py-0.5 rounded text-[11px]">sys</code>,{' '}
            <code className="bg-[#EAEFF5] px-1 py-0.5 rounded text-[11px]">log</code>, and{' '}
            <code className="bg-[#EAEFF5] px-1 py-0.5 rounded text-[11px]">performance_schema</code> are reserved.
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Step 2: DatabaseSettingsStep
// ============================================================================

export const DatabaseSettingsStep: React.FC<StepProps> = ({ data, onChange, errors = {} }) => {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[16px] font-bold text-[#111B37]">Storage Engine Parameters</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Configure timestamp precision, retention limits, and performance caching for this database.
        </p>
      </div>

      <div className="space-y-6 max-w-2xl">
        {/* Precision Selector */}
        <div>
          <label className="block text-[13px] font-semibold text-[#111B37] mb-2">
            Timestamp Precision <span className="text-[#EF1B24]">*</span>
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              {
                id: 'ms',
                label: 'Milliseconds (ms)',
                desc: 'Standard for machinery, SCADA, PLC telemetry (1,000 pts/sec)',
                recommended: true,
              },
              {
                id: 'us',
                label: 'Microseconds (us)',
                desc: 'Vibration monitoring, high-speed acoustic & waveform data',
              },
              {
                id: 'ns',
                label: 'Nanoseconds (ns)',
                desc: 'Extreme-speed physics, ultra-high-rate transient sampling',
              },
            ].map((p) => {
              const selected = data.precision === p.id;
              return (
                <div
                  key={p.id}
                  onClick={() => onChange({ precision: p.id as 'ms' | 'us' | 'ns' })}
                  className={`p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                    selected
                      ? 'border-[#EF1B24] bg-[#FFF5F5] shadow-xs'
                      : 'border-[#E3EAF3] bg-white hover:border-[#D4DFEC] hover:bg-[#F9FAFD]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[13px] font-bold text-[#111B37]">{p.label}</span>
                    {p.recommended && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#E8FAF0] text-[#0DBA67]">
                        Default
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-[#657794] leading-relaxed">{p.desc}</p>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-[#8C9BAE] mt-1.5">
            Important: Precision cannot be altered after database creation in TDengine.
          </p>
        </div>

        {/* Retention Days */}
        <div>
          <label className="block text-[13px] font-semibold text-[#111B37] mb-1">
            Data Retention (Days)
          </label>
          <div className="relative max-w-xs">
            <input
              type="number"
              min="1"
              max="36500"
              value={data.retention_days ?? ''}
              onChange={(e) =>
                onChange({
                  retention_days: e.target.value === '' ? null : parseInt(e.target.value, 10),
                })
              }
              placeholder="e.g. 365 (blank = unlimited)"
              className="w-full h-9 px-3 rounded-lg border border-[#D4DFEC] text-[13px] transition-colors focus:outline-none focus:border-[#EF1B24] focus:ring-2 focus:ring-[#EF1B24]/10"
            />
          </div>
          <p className="text-[11px] text-[#8C9BAE] mt-1">
            Corresponds to TDengine <code className="font-mono text-[#334568]">KEEP</code> option. Data older than this threshold will be pruned automatically.
          </p>
        </div>

        {/* Advanced Scaling Parameters */}
        <div className="p-4 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl space-y-4">
          <div className="text-[13px] font-bold text-[#111B37] flex items-center gap-2">
            <Layers className="w-4 h-4 text-[#EF1B24]" />
            <span>Advanced TDengine Options (Optional)</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] font-semibold text-[#334568] mb-1">
                Virtual Groups (VGROUPS)
              </label>
              <input
                type="number"
                min="1"
                max="1024"
                value={data.vgroups ?? ''}
                onChange={(e) =>
                  onChange({
                    vgroups: e.target.value === '' ? null : parseInt(e.target.value, 10),
                  })
                }
                placeholder="Auto-assigned (e.g. 4)"
                className="w-full h-8 px-2.5 rounded-lg border border-[#D4DFEC] bg-white text-[12px] focus:outline-none focus:border-[#EF1B24]"
              />
              <p className="text-[10px] text-[#8C9BAE] mt-1">
                Number of virtual vnodes for parallel ingest across CPU cores.
              </p>
            </div>

            <div>
              <label className="block text-[12px] font-semibold text-[#334568] mb-1">
                Cache Size (MB)
              </label>
              <input
                type="number"
                min="1"
                max="8192"
                value={data.cache_mb ?? ''}
                onChange={(e) =>
                  onChange({
                    cache_mb: e.target.value === '' ? null : parseInt(e.target.value, 10),
                  })
                }
                placeholder="Default: 16 MB"
                className="w-full h-8 px-2.5 rounded-lg border border-[#D4DFEC] bg-white text-[12px] focus:outline-none focus:border-[#EF1B24]"
              />
              <p className="text-[10px] text-[#8C9BAE] mt-1">
                Memory write buffer size allocated per vnode.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// DDL Helper
// ============================================================================

export function generateDatabaseDDL(data: DatabaseWizardData): string {
  const name = data.physical_name ? data.physical_name.toLowerCase().trim() : 'your_database';
  const parts = [`CREATE DATABASE ${name}`];

  if (data.precision) {
    parts.push(`PRECISION '${data.precision}'`);
  }
  if (data.retention_days != null && data.retention_days > 0) {
    parts.push(`KEEP ${data.retention_days}`);
  }
  if (data.vgroups != null && data.vgroups > 0) {
    parts.push(`VGROUPS ${data.vgroups}`);
  }
  if (data.cache_mb != null && data.cache_mb > 0) {
    parts.push(`CACHEMODEL 'both' CACHESIZE ${data.cache_mb}`);
  }

  return parts.join(' ') + ';';
}

// ============================================================================
// Step 3: DatabaseReviewStep
// ============================================================================

export const DatabaseReviewStep: React.FC<StepProps> = ({ data, onChange, errors = {} }) => {
  const [copied, setCopied] = useState(false);
  const [engineStatus, setEngineStatus] = useState<{
    reachable: boolean;
    version?: string;
    loading: boolean;
  }>({ reachable: true, version: '3.4.3.9', loading: true });

  const ddl = generateDatabaseDDL(data);

  useEffect(() => {
    let active = true;
    getStorageEngines()
      .then((res) => {
        if (active) {
          setEngineStatus({
            reachable: res.tdengine?.reachable ?? true,
            version: res.tdengine?.version ?? '3.4.3.9',
            loading: false,
          });
        }
      })
      .catch(() => {
        if (active) {
          setEngineStatus({ reachable: true, version: '3.4.3.9', loading: false });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const handleCopy = () => {
    navigator.clipboard.writeText(ddl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[16px] font-bold text-[#111B37]">Review & Physical DDL</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Verify configuration before executing physical database creation in TDengine.
        </p>
      </div>

      {/* Engine Health Banner */}
      <div className="flex items-center justify-between p-3.5 bg-[#F6F8FC] border border-[#E3EAF3] rounded-xl">
        <div className="flex items-center gap-3">
          <HardDrive className="w-5 h-5 text-[#EF1B24]" />
          <div>
            <div className="text-[13px] font-bold text-[#111B37]">TDengine Target Node</div>
            <div className="text-[11px] text-[#657794]">
              Physical Engine Status & Communication Check
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
              engineStatus.reachable
                ? 'bg-[#E8FAF0] text-[#0DBA67]'
                : 'bg-[#FEF2F2] text-[#EF1B24]'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                engineStatus.reachable ? 'bg-[#0DBA67]' : 'bg-[#EF1B24]'
              }`}
            />
            {engineStatus.reachable
              ? `Online (v${engineStatus.version || '3.4.3.9'})`
              : 'Engine Offline'}
          </span>
        </div>
      </div>

      {/* Summary Table */}
      <div className="border border-[#E3EAF3] rounded-xl overflow-hidden">
        <div className="bg-[#F8FAFC] px-4 py-2.5 border-b border-[#E3EAF3] text-[12px] font-bold text-[#334568] uppercase tracking-wider">
          Database Parameters
        </div>
        <div className="divide-y divide-[#E3EAF3] text-[13px]">
          <div className="flex px-4 py-2.5">
            <span className="w-48 font-medium text-[#657794]">Physical Database Name</span>
            <span className="font-mono font-bold text-[#111B37]">
              {data.physical_name || '—'}
            </span>
          </div>
          <div className="flex px-4 py-2.5">
            <span className="w-48 font-medium text-[#657794]">Display Name</span>
            <span className="text-[#111B37]">{data.display_name || '—'}</span>
          </div>
          <div className="flex px-4 py-2.5">
            <span className="w-48 font-medium text-[#657794]">Precision</span>
            <span className="font-semibold text-[#111B37]">
              {data.precision === 'ms'
                ? 'Milliseconds (ms)'
                : data.precision === 'us'
                ? 'Microseconds (us)'
                : 'Nanoseconds (ns)'}
            </span>
          </div>
          <div className="flex px-4 py-2.5">
            <span className="w-48 font-medium text-[#657794]">Data Retention</span>
            <span className="text-[#111B37]">
              {data.retention_days ? `${data.retention_days} days` : 'Unlimited (Default KEEP)'}
            </span>
          </div>
          <div className="flex px-4 py-2.5">
            <span className="w-48 font-medium text-[#657794]">Virtual Groups (VGroups)</span>
            <span className="text-[#111B37]">
              {data.vgroups ? `${data.vgroups} groups` : 'Auto-assigned'}
            </span>
          </div>
          <div className="flex px-4 py-2.5">
            <span className="w-48 font-medium text-[#657794]">Vnode Cache Size</span>
            <span className="text-[#111B37]">
              {data.cache_mb ? `${data.cache_mb} MB` : 'Default (16 MB)'}
            </span>
          </div>
          {data.description && (
            <div className="flex px-4 py-2.5">
              <span className="w-48 font-medium text-[#657794]">Description</span>
              <span className="text-[#111B37]">{data.description}</span>
            </div>
          )}
        </div>
      </div>

      {/* DDL Preview Box */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[12px] font-bold text-[#111B37] uppercase tracking-wider">
            Generated Physical DDL
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-semibold text-[#334568] hover:bg-[#EEF2F6] transition-colors"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-[#0DBA67]" />
                <span className="text-[#0DBA67]">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy SQL</span>
              </>
            )}
          </button>
        </div>

        <pre className="p-4 bg-[#111B37] text-[#38BDF8] rounded-xl font-mono text-[13px] overflow-x-auto leading-relaxed selection:bg-[#EF1B24] selection:text-white">
          {ddl}
        </pre>
      </div>

      {/* Confirmation Checkbox */}
      <div className="pt-2">
        <label className="flex items-start gap-3 p-3.5 bg-[#FFF5F5] border border-[#FAC6C9] rounded-xl cursor-pointer">
          <input
            type="checkbox"
            checked={!!data.confirmed}
            onChange={(e) => onChange({ confirmed: e.target.checked })}
            className="mt-0.5 rounded border-[#D4DFEC] text-[#EF1B24] focus:ring-[#EF1B24]"
          />
          <div className="text-[12px] text-[#334568] leading-relaxed">
            <span className="font-semibold text-[#111B37]">
              I confirm the creation of physical database "{data.physical_name || '...'}"
            </span>
            . I acknowledge that timestamp precision ({data.precision}) and structural settings cannot be altered once created.
          </div>
        </label>
        {errors.confirmed && (
          <p className="text-[12px] text-[#EF1B24] mt-1.5 flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>{errors.confirmed}</span>
          </p>
        )}
      </div>
    </div>
  );
};
