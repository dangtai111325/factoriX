import React, { useState, useEffect, useMemo } from 'react';
import {
  Table,
  Layers,
  Search,
  Check,
  Copy,
  Info,
  AlertTriangle,
  FolderTree,
  Radio,
  Boxes,
  Link2,
  Unlink,
  Eye,
  Sliders,
  CheckCircle2,
  Clock,
  Activity,
  HardDrive,
} from 'lucide-react';
import {
  RowAssemblyPolicy,
  RecordingMode,
  TagValueAssignment,
  FieldBindingIntent,
  TDStable,
  TDColumn,
  TDTag,
  listStables,
  getStable,
  getSources,
  SourceRef,
  SourceView,
} from '../../../lib/storagePhysicalApi';

// ============================================================================
// Types
// ============================================================================

export interface SubtableWizardData {
  stable_id: string;
  stable_name?: string;
  database_name?: string;
  physical_name: string;
  display_name: string;
  description: string;
  tag_values: TagValueAssignment[];
  bindings: FieldBindingIntent[];
  row_assembly_policy: RowAssemblyPolicy;
  recording_mode: RecordingMode;
  max_age_seconds?: number | null;
  time_bucket_seconds?: number | null;
  start_recording?: boolean;
  confirmed?: boolean;
}

export interface SubtableStepProps {
  data: SubtableWizardData;
  onChange: (patch: Partial<SubtableWizardData>) => void;
  errors?: Record<string, string>;
  parentStable?: TDStable | null;
  onSelectStable?: (stable: TDStable) => void;
}

// ============================================================================
// Step 1: SubtableIdentityStep
// ============================================================================

export const SubtableIdentityStep: React.FC<SubtableStepProps> = ({
  data,
  onChange,
  errors = {},
  parentStable,
  onSelectStable,
}) => {
  const [stables, setStables] = useState<TDStable[]>([]);
  const [loadingStables, setLoadingStables] = useState(true);

  useEffect(() => {
    let active = true;
    listStables()
      .then((res) => {
        if (active) {
          setStables(res.items || []);
          setLoadingStables(false);
          // If no stable is selected yet and items exist, select first
          if (!data.stable_id && res.items && res.items.length > 0) {
            const first = res.items[0];
            onChange({
              stable_id: first.id,
              stable_name: first.physical_name,
              database_name: first.database_name,
            });
            onSelectStable?.(first);
          }
        }
      })
      .catch(() => {
        if (active) setLoadingStables(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleStableChange = (stId: string) => {
    const selected = stables.find((s) => s.id === stId);
    if (selected) {
      onChange({
        stable_id: selected.id,
        stable_name: selected.physical_name,
        database_name: selected.database_name,
      });
      onSelectStable?.(selected);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[16px] font-bold text-[#111B37]">Subtable Identity & Archetype</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Select the parent Supertable template and specify the physical table identifier.
        </p>
      </div>

      <div className="space-y-4 max-w-xl">
        {/* Parent STable selector */}
        <div>
          <label className="block text-[13px] font-semibold text-[#111B37] mb-1">
            Parent Supertable (STable) <span className="text-[#EF1B24]">*</span>
          </label>
          <div className="relative">
            <select
              value={data.stable_id}
              onChange={(e) => handleStableChange(e.target.value)}
              className={`w-full h-9 px-3 rounded-lg border text-[13px] transition-colors focus:outline-none focus:ring-2 bg-white ${
                errors.stable_id
                  ? 'border-[#EF1B24] focus:ring-[#EF1B24]/20'
                  : 'border-[#D4DFEC] focus:border-[#EF1B24] focus:ring-[#EF1B24]/10'
              }`}
            >
              <option value="" disabled>
                {loadingStables ? 'Loading Supertables...' : 'Select a Supertable...'}
              </option>
              {stables.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.physical_name} ({s.database_name}) — {s.columns?.length || 0} cols,{' '}
                  {s.tags?.length || 0} tags
                </option>
              ))}
            </select>
          </div>
          {errors.stable_id ? (
            <p className="text-[12px] text-[#EF1B24] mt-1">{errors.stable_id}</p>
          ) : (
            <p className="text-[11px] text-[#8C9BAE] mt-1">
              The subtable inherits all columns and tags from this Supertable.
            </p>
          )}
        </div>

        {/* Physical Name */}
        <div>
          <label className="block text-[13px] font-semibold text-[#111B37] mb-1">
            Subtable Name <span className="text-[#EF1B24]">*</span>
          </label>
          <input
            type="text"
            value={data.physical_name}
            onChange={(e) => onChange({ physical_name: e.target.value.toLowerCase().trim() })}
            placeholder="e.g. sub_cnc_mill_01"
            className={`w-full h-9 px-3 rounded-lg border text-[13px] font-mono transition-colors focus:outline-none focus:ring-2 ${
              errors.physical_name
                ? 'border-[#EF1B24] focus:ring-[#EF1B24]/20'
                : 'border-[#D4DFEC] focus:border-[#EF1B24] focus:ring-[#EF1B24]/10'
            }`}
          />
          {errors.physical_name ? (
            <p className="text-[12px] text-[#EF1B24] mt-1 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{errors.physical_name}</span>
            </p>
          ) : (
            <p className="text-[11px] text-[#8C9BAE] mt-1">
              Physical table name in TDengine. Lowercase letters, numbers, and underscores only.
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
            placeholder="e.g. CNC Milling Machine #1"
            className="w-full h-9 px-3 rounded-lg border border-[#D4DFEC] text-[13px] transition-colors focus:outline-none focus:border-[#EF1B24] focus:ring-2 focus:ring-[#EF1B24]/10"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-[13px] font-semibold text-[#111B37] mb-1">
            Description
          </label>
          <textarea
            value={data.description}
            onChange={(e) => onChange({ description: e.target.value })}
            rows={2}
            placeholder="Describe machine serial number, installation area, or telemetry context..."
            className="w-full p-3 rounded-lg border border-[#D4DFEC] text-[13px] transition-colors focus:outline-none focus:border-[#EF1B24] focus:ring-2 focus:ring-[#EF1B24]/10 resize-none"
          />
        </div>
      </div>

      {/* Parent STable Schema Preview */}
      {parentStable && (
        <div className="p-4 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl space-y-3 max-w-xl">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-bold text-[#111B37] flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-[#0284C7]" />
              <span>Inherited Schema from "{parentStable.physical_name}"</span>
            </span>
            <span className="text-[11px] text-[#657794]">
              DB: <span className="font-mono font-semibold">{parentStable.database_name}</span>
            </span>
          </div>

          <div className="space-y-1.5 text-[12px]">
            <div>
              <span className="font-medium text-[#657794]">Columns ({parentStable.columns?.length || 0}): </span>
              <span className="font-mono text-[#334568]">
                {parentStable.columns?.map((c) => c.name).join(', ') || 'None'}
              </span>
            </div>
            <div>
              <span className="font-medium text-[#657794]">Tags ({parentStable.tags?.length || 0}): </span>
              <span className="font-mono text-[#334568]">
                {parentStable.tags?.map((t) => `${t.name} [${t.td_type}]`).join(', ') || 'None'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Step 2: SubtableTagValuesStep
// ============================================================================

export const SubtableTagValuesStep: React.FC<SubtableStepProps> = ({
  data,
  onChange,
  errors = {},
  parentStable,
}) => {
  const tags: TDTag[] = parentStable?.tags || [];

  // Helper to update specific tag value
  const setTagValue = (tagName: string, value: string) => {
    const existing = [...data.tag_values];
    const idx = existing.findIndex((t) => t.tag_name === tagName);
    if (idx >= 0) {
      existing[idx] = { tag_name: tagName, value };
    } else {
      existing.push({ tag_name: tagName, value });
    }
    onChange({ tag_values: existing });
  };

  const getTagValue = (tagName: string): string => {
    return data.tag_values.find((t) => t.tag_name === tagName)?.value || '';
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[16px] font-bold text-[#111B37]">Static Tag Values</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Assign constant metadata values for each tag inherited from the parent Supertable.
        </p>
      </div>

      <div className="p-4 bg-[#F0FDF4] border border-[#DCFCE7] rounded-xl flex items-start gap-3 max-w-xl">
        <Info className="w-5 h-5 text-[#0DBA67] flex-shrink-0 mt-0.5" />
        <div className="text-[12px] text-[#166534] space-y-1">
          <div className="font-semibold text-[#14532D]">Subtable Tag Assignment</div>
          <div>
            Tags distinguish this subtable from other instances of the same Supertable. They are
            indexed in memory by TDengine for instant aggregation.
          </div>
        </div>
      </div>

      {errors.tag_values && (
        <div className="p-3 bg-[#FEF2F2] border border-[#FAC6C9] rounded-lg text-[13px] text-[#EF1B24] flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{errors.tag_values}</span>
        </div>
      )}

      {/* Tag fields */}
      <div className="space-y-4 max-w-xl">
        {tags.length === 0 ? (
          <div className="p-6 text-center text-[#8C9BAE] text-[13px] border border-dashed rounded-xl">
            The selected Supertable does not define any tags.
          </div>
        ) : (
          tags.map((tag) => {
            const isResourceId =
              tag.name.toLowerCase().includes('resource') ||
              tag.name.toLowerCase().includes('machine') ||
              tag.name.toLowerCase().includes('asset');
            const val = getTagValue(tag.name);

            return (
              <div key={tag.name} className="p-4 bg-white border border-[#E3EAF3] rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-[13px] text-[#111B37]">
                      {tag.name}
                    </span>
                    <span className="text-[11px] font-mono text-[#0284C7] bg-[#E0F2FE] px-1.5 py-0.5 rounded">
                      {tag.td_type}
                    </span>
                  </div>
                  {isResourceId && (
                    <span className="text-[10px] font-semibold text-[#0DBA67] bg-[#E8FAF0] px-1.5 py-0.5 rounded">
                      Resource Identifier
                    </span>
                  )}
                </div>

                <div className="space-y-1.5">
                  <input
                    type="text"
                    value={val}
                    onChange={(e) => setTagValue(tag.name, e.target.value)}
                    placeholder={`Enter value for ${tag.name}...`}
                    className="w-full h-9 px-3 rounded-lg border border-[#D4DFEC] text-[13px] font-mono focus:outline-none focus:border-[#EF1B24]"
                  />

                  {/* Quick suggestion pills if resource_id */}
                  {isResourceId && !val && (
                    <div className="flex items-center gap-1.5 pt-1 text-[11px] text-[#657794]">
                      <span>Suggestions:</span>
                      {['cnc-mill-01', 'robot-arm-02', 'press-line-03'].map((sug) => (
                        <button
                          key={sug}
                          type="button"
                          onClick={() => setTagValue(tag.name, sug)}
                          className="px-2 py-0.5 rounded bg-[#EEF2F6] hover:bg-[#E2E8F0] font-mono text-[10px] text-[#334568]"
                        >
                          {sug}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Step 3: SubtableBindSourcesStep
// ============================================================================

export const SubtableBindSourcesStep: React.FC<SubtableStepProps> = ({
  data,
  onChange,
  parentStable,
}) => {
  const [activeTab, setActiveTab] = useState<SourceView>('hierarchy');
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingSources, setLoadingSources] = useState(false);
  const [selectedColumn, setSelectedColumn] = useState<string>(
    parentStable?.columns?.find((c) => c.name !== 'ts')?.name || ''
  );
  const [selectedSource, setSelectedSource] = useState<SourceRef | null>(null);

  useEffect(() => {
    let active = true;
    setLoadingSources(true);
    getSources({ view: activeTab, search: searchQuery || undefined })
      .then((res) => {
        if (active) {
          setSources(res.items || []);
          setLoadingSources(false);
          if (res.items && res.items.length > 0 && !selectedSource) {
            setSelectedSource(res.items[0]);
          }
        }
      })
      .catch(() => {
        if (active) setLoadingSources(false);
      });
    return () => {
      active = false;
    };
  }, [activeTab, searchQuery]);

  const metricCols = (parentStable?.columns || []).filter((c) => c.name !== 'ts');

  const bindSourceToColumn = (colName: string, src: SourceRef) => {
    const existing = data.bindings.filter((b) => b.column_name !== colName);
    const newBinding: FieldBindingIntent = {
      column_name: colName,
      source_id: src.id,
      source_kind: src.kind,
      source_path: src.path,
    };
    onChange({ bindings: [...existing, newBinding] });
  };

  const unbindColumn = (colName: string) => {
    const filtered = data.bindings.filter((b) => b.column_name !== colName);
    onChange({ bindings: filtered });
  };

  // Inspect currently selected binding or column
  const currentBinding = data.bindings.find((b) => b.column_name === selectedColumn);
  const boundSource = sources.find((s) => s.id === currentBinding?.source_id);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[16px] font-bold text-[#111B37]">Bind Signals to Columns</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Map incoming operational signals to target Supertable columns.
        </p>
      </div>

      {/* 3-Panel Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: 3-tab Source Picker (4 cols) */}
        <div className="lg:col-span-4 border border-[#E3EAF3] rounded-xl overflow-hidden flex flex-col bg-white">
          <div className="flex border-b border-[#E3EAF3] bg-[#F8FAFC] p-1 gap-1">
            {[
              { id: 'hierarchy', label: 'Hierarchy', icon: FolderTree },
              { id: 'collector', label: 'Collector', icon: Radio },
              { id: 'models', label: 'Models', icon: Boxes },
            ].map((t) => {
              const Icon = t.icon;
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id as SourceView)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${
                    active
                      ? 'bg-white text-[#111B37] shadow-xs'
                      : 'text-[#657794] hover:text-[#111B37]'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>

          <div className="p-2 border-b border-[#E3EAF3]">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#8C9BAE] absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search signals..."
                className="w-full h-8 pl-8 pr-2.5 rounded-lg border border-[#D4DFEC] text-[11px] focus:outline-none focus:border-[#EF1B24]"
              />
            </div>
          </div>

          <div className="p-2 overflow-y-auto max-h-80 divide-y divide-[#F1F5FA]">
            {loadingSources ? (
              <div className="py-8 text-center text-[#8C9BAE] text-[12px]">Loading sources...</div>
            ) : sources.length === 0 ? (
              <div className="py-8 text-center text-[#8C9BAE] text-[12px]">No signals found.</div>
            ) : (
              sources.map((src) => {
                const isSelected = selectedSource?.id === src.id;
                return (
                  <div
                    key={src.id}
                    onClick={() => setSelectedSource(src)}
                    className={`p-2 rounded-lg cursor-pointer transition-colors ${
                      isSelected ? 'bg-[#EEF2F6]' : 'hover:bg-[#F8FAFC]'
                    }`}
                  >
                    <div className="text-[12px] font-semibold text-[#111B37] truncate">
                      {src.display_name}
                    </div>
                    <div className="text-[10px] font-mono text-[#657794] truncate">{src.path}</div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-[#8C9BAE]">
                      <span>{src.data_type || 'number'}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Center: Columns List (4 cols) */}
        <div className="lg:col-span-4 border border-[#E3EAF3] rounded-xl overflow-hidden flex flex-col bg-white">
          <div className="bg-[#F8FAFC] px-3.5 py-2.5 border-b border-[#E3EAF3] text-[12px] font-bold text-[#334568]">
            Target Columns
          </div>

          <div className="p-2 overflow-y-auto max-h-96 space-y-2">
            {metricCols.map((col) => {
              const binding = data.bindings.find((b) => b.column_name === col.name);
              const isSelected = selectedColumn === col.name;

              return (
                <div
                  key={col.name}
                  onClick={() => setSelectedColumn(col.name)}
                  className={`p-2.5 rounded-xl border transition-all cursor-pointer ${
                    isSelected
                      ? 'border-[#EF1B24] bg-[#FFFBFB] ring-1 ring-[#EF1B24]/30'
                      : 'border-[#E3EAF3] bg-white hover:border-[#D4DFEC]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-[12px] text-[#111B37]">
                        {col.name}
                      </span>
                      <span className="text-[10px] font-mono text-[#0284C7] bg-[#E0F2FE] px-1 py-0.5 rounded">
                        {col.td_type}
                      </span>
                    </div>

                    {binding && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          unbindColumn(col.name);
                        }}
                        className="text-[#EF1B24] hover:text-[#D9141D] p-0.5"
                        title="Unbind"
                      >
                        <Unlink className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {binding ? (
                    <div className="mt-1.5 p-1.5 bg-[#F6F8FC] rounded text-[11px] text-[#111B37] truncate">
                      {binding.source_path}
                    </div>
                  ) : (
                    <div className="mt-1 text-[11px] text-[#8C9BAE] italic">Unassigned</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Binding Inspector (4 cols) */}
        <div className="lg:col-span-4 border border-[#E3EAF3] rounded-xl overflow-hidden flex flex-col bg-white">
          <div className="bg-[#F8FAFC] px-3.5 py-2.5 border-b border-[#E3EAF3] text-[12px] font-bold text-[#334568]">
            Binding Inspector
          </div>

          <div className="p-4 space-y-4 text-[12px]">
            <div>
              <span className="text-[#657794] block mb-1">Target Column:</span>
              <span className="font-mono font-bold text-[13px] text-[#111B37]">
                {selectedColumn || 'None selected'}
              </span>
            </div>

            {selectedSource && (
              <div className="p-3 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl space-y-2">
                <div className="font-semibold text-[#111B37]">Active Selected Source:</div>
                <div className="text-[11px] font-mono text-[#334568] break-all">
                  {selectedSource.path}
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] pt-1">
                  <div>
                    <span className="text-[#657794]">Kind: </span>
                    <span className="font-medium text-[#111B37]">{selectedSource.kind}</span>
                  </div>
                  <div>
                    <span className="text-[#657794]">Quality: </span>
                    <span className="font-semibold text-[#0DBA67]">
                      {selectedSource.quality || '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-[#657794]">Sample: </span>
                    <span className="font-mono text-[#111B37]">
                      {selectedSource.last_value !== undefined && selectedSource.last_value !== null
                        ? String(selectedSource.last_value)
                        : '—'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    if (selectedColumn && selectedSource) {
                      bindSourceToColumn(selectedColumn, selectedSource);
                    }
                  }}
                  disabled={!selectedColumn}
                  className="w-full mt-2 py-1.5 bg-[#EF1B24] hover:bg-[#D9141D] text-white font-semibold text-[12px] rounded-lg transition-colors flex items-center justify-center gap-1.5 shadow-2xs disabled:opacity-50"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  <span>Bind to {selectedColumn}</span>
                </button>
              </div>
            )}

            {currentBinding && (
              <div className="p-3 bg-[#E8FAF0] border border-[#DCFCE7] rounded-xl">
                <div className="flex items-center gap-1.5 text-[#0DBA67] font-semibold">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Active Mapping Established</span>
                </div>
                <div className="mt-1 text-[11px] font-mono text-[#166534] break-all">
                  {currentBinding.source_path}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Step 4: SubtableRowAssemblyStep
// ============================================================================

export const SubtableRowAssemblyStep: React.FC<SubtableStepProps> = ({ data, onChange }) => {
  const policies: {
    id: RowAssemblyPolicy;
    title: string;
    desc: string;
    warning?: string;
  }[] = [
    {
      id: 'INDEPENDENT_EVENTS',
      title: 'Independent Events (Safe Default)',
      desc: 'Each signal packet creates a row immediately in TDengine. Non-updated columns carry forward their previous values or remain null.',
    },
    {
      id: 'LATEST_AS_OF_TRIGGER',
      title: 'Latest-As-Of Trigger Signal',
      desc: 'A designated trigger signal produces the row, snapshotting the most recent values of other signals within a specified maximum age window.',
    },
    {
      id: 'TIME_BUCKET',
      title: 'Fixed Time Bucket Alignment',
      desc: 'Aligns and resamples asynchronous data streams into regular time intervals (e.g. 1s, 5s, 10s).',
    },
    {
      id: 'EXACT_TIMESTAMP',
      title: 'Strict Exact Timestamp Match',
      desc: 'Requires all bound signals to carry identical timestamps.',
      warning:
        'Packets with misaligned timestamps will be dropped or written as partial rows.',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[16px] font-bold text-[#111B37]">Row Assembly & Ingestion Policy</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Specify how multi-signal asynchronous streams are combined into single TDengine rows.
        </p>
      </div>

      {/* Policy Radio Cards */}
      <div className="space-y-3 max-w-2xl">
        <label className="block text-[13px] font-semibold text-[#111B37]">
          Row Assembly Policy <span className="text-[#EF1B24]">*</span>
        </label>
        <div className="space-y-2.5">
          {policies.map((p) => {
            const selected = data.row_assembly_policy === p.id;
            return (
              <div
                key={p.id}
                onClick={() => onChange({ row_assembly_policy: p.id })}
                className={`p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                  selected
                    ? 'border-[#EF1B24] bg-[#FFF5F5]'
                    : 'border-[#E3EAF3] bg-white hover:border-[#D4DFEC]'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[13px] font-bold text-[#111B37]">{p.title}</span>
                  <input
                    type="radio"
                    checked={selected}
                    onChange={() => {}}
                    className="text-[#EF1B24] focus:ring-[#EF1B24]"
                  />
                </div>
                <p className="text-[11px] text-[#657794]">{p.desc}</p>
                {p.warning && (
                  <div className="mt-2 p-2 bg-[#FEF2F2] border border-[#FAC6C9] rounded text-[11px] text-[#EF1B24] flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>{p.warning}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Policy-specific config parameters */}
        {data.row_assembly_policy === 'LATEST_AS_OF_TRIGGER' && (
          <div className="p-4 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl">
            <label className="block text-[12px] font-semibold text-[#334568] mb-1">
              Max Age Tolerance (Seconds)
            </label>
            <input
              type="number"
              min="1"
              max="3600"
              value={data.max_age_seconds ?? 5}
              onChange={(e) =>
                onChange({ max_age_seconds: parseInt(e.target.value, 10) || 5 })
              }
              className="w-48 h-8 px-2.5 rounded-lg border border-[#D4DFEC] bg-white text-[12px] focus:outline-none focus:border-[#EF1B24]"
            />
            <p className="text-[10px] text-[#8C9BAE] mt-1">
              Historical samples older than this window will not be carried into the triggered row.
            </p>
          </div>
        )}

        {data.row_assembly_policy === 'TIME_BUCKET' && (
          <div className="p-4 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl">
            <label className="block text-[12px] font-semibold text-[#334568] mb-1">
              Bucket Duration
            </label>
            <select
              value={data.time_bucket_seconds ?? 5}
              onChange={(e) =>
                onChange({ time_bucket_seconds: parseInt(e.target.value, 10) || 5 })
              }
              className="w-48 h-8 px-2 rounded-lg border border-[#D4DFEC] bg-white text-[12px] focus:outline-none focus:border-[#EF1B24]"
            >
              <option value="1">1 second</option>
              <option value="5">5 seconds</option>
              <option value="10">10 seconds</option>
              <option value="30">30 seconds</option>
              <option value="60">60 seconds</option>
            </select>
          </div>
        )}
      </div>

      {/* Recording Mode */}
      <div className="max-w-2xl pt-2">
        <label className="block text-[13px] font-semibold text-[#111B37] mb-2">
          Recording Mode
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { id: 'ON_CHANGE' as RecordingMode, label: 'ON_CHANGE' },
            { id: 'EVERY_ACQUISITION' as RecordingMode, label: 'EVERY_ACQUISITION' },
            { id: 'INTERVAL' as RecordingMode, label: 'INTERVAL' },
          ].map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onChange({ recording_mode: m.id })}
              className={`py-2 px-3 rounded-lg border text-[12px] font-semibold transition-all ${
                data.recording_mode === m.id
                  ? 'border-[#EF1B24] bg-[#FFF5F5] text-[#EF1B24]'
                  : 'border-[#E3EAF3] bg-white text-[#334568] hover:border-[#D4DFEC]'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* 5-row preview simulation */}
      <div className="max-w-3xl pt-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] font-bold text-[#111B37] uppercase tracking-wider flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5 text-[#0284C7]" />
            <span>Simulated Row Ingestion Preview (5 Rows)</span>
          </span>
          <span className="text-[11px] text-[#657794]">
            Policy: <span className="font-semibold text-[#111B37]">{data.row_assembly_policy}</span>
          </span>
        </div>

        <div className="border border-[#E3EAF3] rounded-xl overflow-hidden shadow-xs">
          <table className="w-full text-left border-collapse text-[12px]">
            <thead className="bg-[#F8FAFC] border-b border-[#E3EAF3] text-[11px] font-bold text-[#657794]">
              <tr>
                <th className="py-2 px-3">Timestamp (ts)</th>
                <th className="py-2 px-3">Column 1</th>
                <th className="py-2 px-3">Column 2</th>
                <th className="py-2 px-3">Quality</th>
                <th className="py-2 px-3">Assembly Event</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E3EAF3] font-mono text-[11px]">
              {[
                {
                  ts: '2026-11-12 16:30:00.000',
                  col1: '142.5',
                  col2: '2400',
                  q: 'GOOD',
                  event: 'Direct Packet',
                },
                {
                  ts: '2026-11-12 16:30:01.200',
                  col1: '143.1',
                  col2: '2402',
                  q: 'GOOD',
                  event:
                    data.row_assembly_policy === 'TIME_BUCKET'
                      ? 'Bucket Aggregated'
                      : 'Carried Forward',
                },
                {
                  ts: '2026-11-12 16:30:02.500',
                  col1: '142.9',
                  col2: '2398',
                  q: 'GOOD',
                  event: 'Trigger Sync',
                },
                {
                  ts: '2026-11-12 16:30:03.800',
                  col1: '144.0',
                  col2: '2410',
                  q: 'GOOD',
                  event: 'Direct Packet',
                },
                {
                  ts: '2026-11-12 16:30:05.000',
                  col1: '143.8',
                  col2: '2405',
                  q: 'GOOD',
                  event: 'Checkpoint Flush',
                },
              ].map((row, idx) => (
                <tr key={idx} className="bg-white hover:bg-[#F9FAFD]">
                  <td className="py-2 px-3 text-[#111B37]">{row.ts}</td>
                  <td className="py-2 px-3 text-[#0284C7]">{row.col1}</td>
                  <td className="py-2 px-3 text-[#0284C7]">{row.col2}</td>
                  <td className="py-2 px-3 text-[#0DBA67]">{row.q}</td>
                  <td className="py-2 px-3 text-[#657794]">{row.event}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Start Recording Checkbox */}
      <div className="pt-2">
        <label className="flex items-center gap-2.5 text-[13px] font-semibold text-[#111B37] cursor-pointer">
          <input
            type="checkbox"
            checked={data.start_recording !== false}
            onChange={(e) => onChange({ start_recording: e.target.checked })}
            className="rounded border-[#D4DFEC] text-[#EF1B24] focus:ring-[#EF1B24]"
          />
          <span>Start recording immediately upon creation</span>
        </label>
      </div>
    </div>
  );
};

// ============================================================================
// DDL Helper for Subtable
// ============================================================================

export function generateSubtableDDL(data: SubtableWizardData): string {
  const db = data.database_name ? `${data.database_name}.` : '';
  const name = data.physical_name || 'unnamed_subtable';
  const parent = data.stable_name ? `${db}${data.stable_name}` : 'parent_stable';

  const tagValuesFormatted = data.tag_values.map((tv) => `'${tv.value}'`).join(', ');

  return `CREATE TABLE ${db}${name} USING ${parent} TAGS (${tagValuesFormatted || ''});`;
}

// ============================================================================
// Step 5: SubtableReviewStep
// ============================================================================

export const SubtableReviewStep: React.FC<SubtableStepProps> = ({
  data,
  onChange,
  errors = {},
}) => {
  const [copied, setCopied] = useState(false);
  const ddl = generateSubtableDDL(data);

  const handleCopy = () => {
    navigator.clipboard.writeText(ddl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[16px] font-bold text-[#111B37]">Review Subtable Configuration</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Review TDengine DDL, tag values, and signal bindings before instantiating the subtable.
        </p>
      </div>

      {/* Summary Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="p-3.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl">
          <div className="text-[11px] font-semibold text-[#657794] uppercase tracking-wider">
            Parent Supertable
          </div>
          <div className="text-[14px] font-bold text-[#111B37] mt-0.5">
            {data.stable_name || '—'}
          </div>
        </div>

        <div className="p-3.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl">
          <div className="text-[11px] font-semibold text-[#657794] uppercase tracking-wider">
            Row Assembly Policy
          </div>
          <div className="text-[14px] font-bold text-[#111B37] mt-0.5">
            {data.row_assembly_policy}
          </div>
        </div>

        <div className="p-3.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl">
          <div className="text-[11px] font-semibold text-[#657794] uppercase tracking-wider">
            Active Bindings
          </div>
          <div className="text-[14px] font-bold text-[#111B37] mt-0.5">
            {data.bindings.length} signals bound
          </div>
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

        <pre className="p-4 bg-[#111B37] text-[#38BDF8] rounded-xl font-mono text-[12px] overflow-x-auto leading-relaxed selection:bg-[#EF1B24] selection:text-white">
          {ddl}
        </pre>
      </div>

      {/* Tag values and Bindings Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Tag values */}
        <div className="border border-[#E3EAF3] rounded-xl overflow-hidden">
          <div className="bg-[#F8FAFC] px-3.5 py-2 border-b border-[#E3EAF3] text-[12px] font-bold text-[#334568]">
            Assigned Tag Values
          </div>
          <div className="p-3 text-[12px] divide-y divide-[#F1F5FA]">
            {data.tag_values.length === 0 ? (
              <p className="text-[#8C9BAE]">No tag values assigned.</p>
            ) : (
              data.tag_values.map((t) => (
                <div key={t.tag_name} className="py-1.5 flex justify-between">
                  <span className="font-mono text-[#657794]">{t.tag_name}:</span>
                  <span className="font-mono font-semibold text-[#111B37]">{t.value}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Bound signals */}
        <div className="border border-[#E3EAF3] rounded-xl overflow-hidden">
          <div className="bg-[#F8FAFC] px-3.5 py-2 border-b border-[#E3EAF3] text-[12px] font-bold text-[#334568]">
            Bound Signals
          </div>
          <div className="p-3 text-[12px] divide-y divide-[#F1F5FA]">
            {data.bindings.length === 0 ? (
              <p className="text-[#8C9BAE]">No signals bound.</p>
            ) : (
              data.bindings.map((b) => (
                <div key={b.column_name} className="py-1.5 flex justify-between">
                  <span className="font-mono font-bold text-[#111B37]">{b.column_name}:</span>
                  <span className="font-mono text-[#657794] truncate max-w-[180px]">
                    {b.source_path}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
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
              I confirm the creation of Subtable "{data.physical_name || '...'}"
            </span>{' '}
            using template "{data.stable_name}". Ingestion will be initialized with policy {data.row_assembly_policy}.
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
