import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../../../store/AppContext';
import { Button } from '../../../components/common/Button';
import {
  Layers,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Info,
  Check,
  Copy,
  Search,
  AlertTriangle,
  FolderTree,
  Radio,
  Boxes,
  Database,
  Tag,
  Columns,
  Clock,
  Link2,
  Unlink,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  ColumnDefinition,
  TagDefinition,
  RecordingMode,
  listDatabases,
  getSources,
  SourceRef,
  SourceView,
  TDDatabase,
  StoragePlan,
  StableTemplate,
  listStableTemplates,
  planStorageObject,
} from '../../../lib/storagePhysicalApi';

/** Variable-length TDengine types: a length is mandatory and is always sent (R1-17c). */
export const VAR_LENGTH_TYPES = ['VARCHAR', 'NCHAR', 'BINARY', 'VARBINARY'];
/** Types TDengine 3.4.3.9 accepts for the composite (second) primary key column. */
export const COMPOSITE_KEY_TYPES = ['INT', 'BIGINT', 'VARCHAR', 'BINARY', 'VARBINARY'];

/** `name TYPE[(len)] [KEY]` per line, e.g. `event_key VARCHAR(64) KEY`, `value_f64 DOUBLE`. */
export function parseColumnList(text: string): { columns: ColumnDefinition[]; errors: string[] } {
  const columns: ColumnDefinition[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/[,;]+$/, '').trim();
    if (!line || line.startsWith('--') || line.startsWith('#')) return;
    const m = line.replace(/`/g, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z]+)(?:\s*\(\s*(\d+)\s*\))?\s*(COMPOSITE KEY|PRIMARY KEY|KEY)?$/i);
    if (!m) {
      errors.push(`Line ${i + 1}: "${raw.trim()}" is not "name TYPE(length)".`);
      return;
    }
    const type = m[2].toUpperCase();
    columns.push({
      name: m[1].toLowerCase(),
      td_type: type,
      length: m[3] ? Number(m[3]) : VAR_LENGTH_TYPES.includes(type) ? 64 : null,
      nullable: true,
      primary_key: !!m[4],
    });
  });
  return { columns, errors };
}

// ============================================================================
// Types
// ============================================================================

export interface SourceTemplateMapping {
  column_name: string;
  source_id: string;
  source_kind: 'signal' | 'model_field' | 'resource_context';
  source_path: string;
  source_type?: string;
  source_unit?: string;
}

export interface StableWizardData {
  database_name: string;
  physical_name: string;
  display_name: string;
  description: string;
  columns: ColumnDefinition[];
  tags: TagDefinition[];
  source_mapping_template: SourceTemplateMapping[];
  default_recording_mode: RecordingMode;
  retention_days?: number | null;
  max_checkpoint_interval?: number | null;
  late_tolerance?: number | null;
  skip_source_mapping?: boolean;
  confirmed?: boolean;
}

export interface StableStepProps {
  data: StableWizardData;
  onChange: (patch: Partial<StableWizardData>) => void;
  errors?: Record<string, string>;
}

export const TD_COLUMN_TYPES = [
  'DOUBLE',
  'FLOAT',
  'INT',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'BOOL',
  'VARCHAR',
  'NCHAR',
  'BINARY',
  'VARBINARY',
  'TIMESTAMP',
] as const; // JSON is tag-only in TDengine, so it is not offered for columns

export const TD_TAG_TYPES = [
  'VARCHAR(64)',
  'VARCHAR(128)',
  'VARCHAR(255)',
  'NCHAR(64)',
  'INT',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'BOOL',
] as const;

// ============================================================================
// Step 1: StableTargetStep
// ============================================================================

export const StableTargetStep: React.FC<StableStepProps> = ({ data, onChange, errors = {} }) => {
  const [databases, setDatabases] = useState<TDDatabase[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(true);

  useEffect(() => {
    let active = true;
    listDatabases()
      .then((res) => {
        if (active) {
          setDatabases(res.items || []);
          setLoadingDbs(false);
          // auto-select first if none selected
          if (!data.database_name && res.items && res.items.length > 0) {
            onChange({ database_name: res.items[0].physical_name });
          }
        }
      })
      .catch(() => {
        if (active) setLoadingDbs(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[15px] font-bold text-[#111B37]">Database and name</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Select the host TDengine database and define the physical name for this Supertable (STable).
        </p>
      </div>

      <div className="space-y-4 max-w-xl">
        {/* Target Database */}
        <div>
          <label className="block text-[12px] font-semibold text-[#334568] mb-1">
            Target Database <span className="text-[#EF1B24]">*</span>
          </label>
          <div className="relative">
            <select
              value={data.database_name}
              onChange={(e) => onChange({ database_name: e.target.value })}
              className={`w-full h-9 px-3 rounded-lg border text-[13px] transition-colors focus:outline-none focus:ring-2 bg-white ${
                errors.database_name
                  ? 'border-[#EF1B24] focus:ring-red-100'
                  : 'border-[#D4DFEC] focus:border-blue-500 focus:ring-blue-100'
              }`}
            >
              <option value="" disabled>
                {loadingDbs ? 'Loading databases...' : 'Select a database...'}
              </option>
              {databases.map((db) => (
                <option key={db.id} value={db.physical_name}>
                  {db.physical_name} {db.display_name ? `(${db.display_name})` : ''} [{db.precision}]
                </option>
              ))}
            </select>
          </div>
          {errors.database_name ? (
            <p className="text-[12px] text-[#EF1B24] mt-1">{errors.database_name}</p>
          ) : (
            <p className="text-[11px] text-[#657794] mt-1">
              The STable will be created within this physical database schema.
            </p>
          )}
        </div>

        {/* Physical Name */}
        <div>
          <label className="block text-[12px] font-semibold text-[#334568] mb-1">
            Supertable Name <span className="text-[#EF1B24]">*</span>
          </label>
          <input
            type="text"
            value={data.physical_name}
            onChange={(e) => onChange({ physical_name: e.target.value.toLowerCase().trim() })}
            placeholder="e.g. cnc_spindle_telemetry"
            className={`w-full h-9 px-3 rounded-lg border text-[13px] font-mono transition-colors focus:outline-none focus:ring-2 ${
              errors.physical_name
                ? 'border-[#EF1B24] focus:ring-red-100'
                : 'border-[#D4DFEC] focus:border-blue-500 focus:ring-blue-100'
            }`}
          />
          {errors.physical_name ? (
            <p className="text-[11px] text-red-700 mt-1 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{errors.physical_name}</span>
            </p>
          ) : (
            <p className="text-[11px] text-[#657794] mt-1">
              Lowercase letters, digits, and underscores only. Max 63 characters.
            </p>
          )}
        </div>

        {/* Display Name */}
        <div>
          <label className="block text-[12px] font-semibold text-[#334568] mb-1">
            Display Name
          </label>
          <input
            type="text"
            value={data.display_name}
            onChange={(e) => onChange({ display_name: e.target.value })}
            placeholder="e.g. CNC Spindle Telemetry Template"
            className="w-full h-9 px-3 rounded-lg border border-[#D4DFEC] text-[13px] transition-colors focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-[12px] font-semibold text-[#334568] mb-1">
            Description
          </label>
          <textarea
            value={data.description}
            onChange={(e) => onChange({ description: e.target.value })}
            rows={3}
            placeholder="Describe the machinery family, sensor payload, or telemetry archetype..."
            className="w-full p-3 rounded-lg border border-[#D4DFEC] text-[13px] transition-colors focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 resize-none"
          />
        </div>
      </div>

      {/* STable Concept Card */}
      <div className="p-4 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl flex items-start gap-3 max-w-xl">
        <Info className="w-5 h-5 text-[#2A82E7] flex-shrink-0 mt-0.5" />
        <div className="text-[12px] text-[#334568] space-y-1">
          <div className="font-semibold text-[#111B37]">What is a TDengine Supertable (STable)?</div>
          <div>
            A Supertable defines a shared schema (time-series columns) and static tag dimensions for
            a class of identical IoT devices. Individual machines instantiate this STable as
            subtables.
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Step 2: StableColumnsStep
// ============================================================================

export const StableColumnsStep: React.FC<StableStepProps> = ({ data, onChange, errors = {} }) => {
  const [templates, setTemplates] = useState<StableTemplate[]>([]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteErrors, setPasteErrors] = useState<string[]>([]);
  useEffect(() => {
    listStableTemplates().then((r) => setTemplates(r.items || [])).catch(() => setTemplates([]));
  }, []);

  const applyTemplate = (id: string) => {
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    const cols = [...tpl.columns, ...tpl.value_columns].map((c, i) => ({
      ...c, nullable: i !== 0, immutable: i === 0, primary_key: i === 1 && !!c.primary_key,
    }));
    onChange({
      columns: cols,
      tags: tpl.tags.map((t) => ({ name: t.name, td_type: t.length ? `${t.td_type}(${t.length})` : t.td_type })),
      default_recording_mode: tpl.recording_mode,
    });
  };

  const applyPaste = () => {
    const { columns, errors: errs } = parseColumnList(pasteText);
    setPasteErrors(errs);
    if (errs.length || columns.length === 0) return;
    const rest = columns.filter((c) => c.name !== 'ts');
    onChange({ columns: [data.columns[0] || { name: 'ts', td_type: 'TIMESTAMP', nullable: false, immutable: true }, ...rest] });
    setPasteOpen(false);
  };

  const addColumn = () => {
    const nextIndex = data.columns.length;
    const newCol: ColumnDefinition = {
      name: `val_${nextIndex}`,
      td_type: 'DOUBLE',
      nullable: true,
      immutable: false,
    };
    onChange({ columns: [...data.columns, newCol] });
  };

  const updateColumn = (index: number, patch: Partial<ColumnDefinition>) => {
    const updated = data.columns.map((col, idx) => (idx === index ? { ...col, ...patch } : col));
    onChange({ columns: updated });
  };

  const removeColumn = (index: number) => {
    if (index === 0) return; // cannot remove ts
    const updated = data.columns.filter((_, idx) => idx !== index);
    onChange({ columns: updated });
  };

  const moveColumn = (fromIdx: number, toIdx: number) => {
    if (fromIdx === 0 || toIdx === 0) return; // ts stays at 0
    if (toIdx < 1 || toIdx >= data.columns.length) return;
    const items = [...data.columns];
    const [moved] = items.splice(fromIdx, 1);
    items.splice(toIdx, 0, moved);
    onChange({ columns: items });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-bold text-[#111B37]">Columns</h2>
          <p className="text-[13px] text-[#657794] mt-1">
            Define the time-series values recorded by each subtable. The timestamp{' '}
            <code className="bg-[#EEF2F6] px-1 py-0.5 rounded font-mono text-[12px]">ts TIMESTAMP</code>{' '}
            is mandatory and locked as the primary index.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Start from template" value="" onChange={(e) => applyTemplate(e.target.value)}
            className="h-9 px-2 rounded-lg border border-[#D4DFEC] bg-white text-[13px]">
            <option value="">Start from template…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button type="button" onClick={() => setPasteOpen((v) => !v)}
            className="h-9 px-3 rounded-lg border border-[#D4DFEC] bg-white text-[13px] font-semibold text-[#334568] hover:bg-[#F9FAFD]">
            Paste column list
          </button>
          <button
            type="button"
            onClick={addColumn}
            className="flex items-center gap-1.5 h-9 px-3 bg-white border border-[#D4DFEC] hover:bg-[#F9FAFD] text-[#111B37] rounded-lg text-[13px] font-semibold transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>Add Column</span>
          </button>
        </div>
      </div>

      {pasteOpen && (
        <div className="p-3 border border-[#E3EAF3] rounded-xl bg-white space-y-2">
          <p className="text-[12px] text-[#657794]">One column per line: <code className="font-mono">name TYPE(length)</code>; add <code className="font-mono">KEY</code> to the second column for a composite key. The existing columns after <code className="font-mono">ts</code> are replaced.</p>
          <textarea rows={8} value={pasteText} onChange={(e) => setPasteText(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[#D4DFEC] text-[12px] font-mono focus:outline-none focus:border-blue-500"
            placeholder={'event_key VARCHAR(64) KEY\nquality VARCHAR(16)\nvalue_f64 DOUBLE'} />
          {pasteErrors.map((e) => <p key={e} className="text-[12px] text-[#F2343B]">{e}</p>)}
          <div className="flex gap-2">
            <button type="button" onClick={applyPaste} className="h-8 px-3 rounded-lg bg-[#EF1B24] text-white text-[12px] font-semibold">Apply</button>
            <button type="button" onClick={() => setPasteOpen(false)} className="h-8 px-3 rounded-lg text-[12px] font-semibold text-[#657794] hover:bg-[#F1F5FA]">Cancel</button>
          </div>
        </div>
      )}

      {errors.columns && (
        <div className="p-3 bg-[#FEF2F2] border border-[#FAC6C9] rounded-lg text-[13px] text-[#EF1B24] flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{errors.columns}</span>
        </div>
      )}

      {/* Columns Table */}
      <div className="border border-[#E3EAF3] rounded-xl overflow-hidden shadow-xs">
        <table className="w-full text-left border-collapse text-[13px]">
          <thead className="bg-[#F8FAFC] border-b border-[#E3EAF3] text-[11px] font-bold text-[#657794] uppercase tracking-wider">
            <tr>
              <th className="py-2.5 px-3 w-12 text-center">#</th>
              <th className="py-2.5 px-3">Column Name</th>
              <th className="py-2.5 px-3 w-44">TDengine Type</th>
              <th className="py-2.5 px-3 w-28">Length/Prec</th>
              <th className="py-2.5 px-3 w-24 text-center">Nullable</th>
              <th className="py-2.5 px-3 w-28 text-center" title="Composite primary key (second column only): rows with the same timestamp but a different key are all kept.">Composite key</th>
              <th className="py-2.5 px-3 w-24 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E3EAF3]">
            {data.columns.map((col, idx) => {
              const isTs = idx === 0 || col.immutable;
              const needsLength = VAR_LENGTH_TYPES.includes(col.td_type);

              return (
                <tr key={idx} className={isTs ? 'bg-[#F9FAFD]' : 'bg-white hover:bg-[#FBFDFE]'}>
                  {/* Row index / Lock */}
                  <td className="py-2.5 px-3 text-center text-[#657794] text-[12px] font-mono">
                    {isTs ? '🔒' : idx + 1}
                  </td>

                  {/* Name */}
                  <td className="py-2.5 px-3">
                    {isTs ? (
                      <span className="font-mono font-bold text-[#111B37] px-2 py-1 rounded bg-[#EAEFF5] text-[12px]">
                        ts
                      </span>
                    ) : (
                      <input
                        type="text"
                        value={col.name}
                        onChange={(e) =>
                          updateColumn(idx, { name: e.target.value.toLowerCase().trim() })
                        }
                        placeholder="column_name"
                        className="w-full h-8 px-2.5 rounded-lg border border-[#D4DFEC] text-[12px] font-mono focus:outline-none focus:border-blue-500"
                      />
                    )}
                  </td>

                  {/* Type */}
                  <td className="py-2.5 px-3">
                    {isTs ? (
                      <span className="font-mono text-[#2A82E7] font-semibold text-[12px]">
                        TIMESTAMP
                      </span>
                    ) : (
                      <select
                        value={col.td_type}
                        onChange={(e) => {
                          const t = e.target.value;
                          updateColumn(idx, {
                            td_type: t,
                            length: VAR_LENGTH_TYPES.includes(t) ? col.length ?? 64 : null,
                            primary_key: col.primary_key && COMPOSITE_KEY_TYPES.includes(t),
                          });
                        }}
                        className="w-full h-8 px-2 rounded-lg border border-[#D4DFEC] bg-white text-[12px] font-mono focus:outline-none focus:border-blue-500"
                      >
                        {TD_COLUMN_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>

                  {/* Length / Precision */}
                  <td className="py-2.5 px-3">
                    {needsLength ? (
                      <input
                        type="number"
                        min="1"
                        max="4096"
                        value={col.length ?? 64}
                        onChange={(e) =>
                          updateColumn(idx, { length: parseInt(e.target.value, 10) || 64 })
                        }
                        className="w-20 h-8 px-2 rounded-lg border border-[#D4DFEC] text-[12px] font-mono focus:outline-none focus:border-blue-500"
                      />
                    ) : (
                      <span className="text-[#657794] text-[11px]">—</span>
                    )}
                  </td>

                  {/* Nullable */}
                  <td className="py-2.5 px-3 text-center">
                    {isTs ? (
                      <span className="text-[11px] font-semibold text-[#657794]">NOT NULL</span>
                    ) : (
                      <input
                        type="checkbox"
                        checked={col.nullable !== false}
                        onChange={(e) => updateColumn(idx, { nullable: e.target.checked })}
                        className="rounded border-[#D4DFEC] text-[#EF1B24] focus:ring-[#EF1B24]"
                      />
                    )}
                  </td>

                  {/* Composite key (2nd column) */}
                  <td className="py-2.5 px-3 text-center">
                    {idx === 1 ? (
                      <input
                        type="checkbox"
                        aria-label="Composite primary key"
                        checked={!!col.primary_key}
                        disabled={!COMPOSITE_KEY_TYPES.includes(col.td_type)}
                        onChange={(e) => updateColumn(idx, { primary_key: e.target.checked, nullable: !e.target.checked })}
                        className="rounded border-[#D4DFEC] text-[#EF1B24] focus:ring-[#EF1B24]"
                        title={COMPOSITE_KEY_TYPES.includes(col.td_type) ? 'Composite key' : `Composite key needs ${COMPOSITE_KEY_TYPES.join(', ')}`}
                      />
                    ) : (
                      <span className="text-[11px] text-[#94A3B8]">—</span>
                    )}
                  </td>

                  {/* Actions */}
                  <td className="py-2.5 px-3 text-center">
                    {isTs ? (
                      <span className="text-[11px] text-[#657794]">Primary</span>
                    ) : (
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={() => moveColumn(idx, idx - 1)}
                          disabled={idx <= 1}
                          className="p-1 text-[#657794] hover:text-[#111B37] disabled:opacity-30"
                          title="Move up"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveColumn(idx, idx + 1)}
                          disabled={idx === data.columns.length - 1}
                          className="p-1 text-[#657794] hover:text-[#111B37] disabled:opacity-30"
                          title="Move down"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeColumn(idx)}
                          className="p-1 text-[#EF1B24] hover:text-[#D9141D]"
                          title="Remove column"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ============================================================================
// Step 3: StableTagsStep
// ============================================================================

export const StableTagsStep: React.FC<StableStepProps> = ({ data, onChange, errors = {} }) => {
  const addTag = () => {
    const nextIdx = data.tags.length + 1;
    const newTag: TagDefinition = {
      name: `tag_${nextIdx}`,
      td_type: 'VARCHAR(64)',
    };
    onChange({ tags: [...data.tags, newTag] });
  };

  const updateTag = (index: number, patch: Partial<TagDefinition>) => {
    const updated = data.tags.map((t, idx) => (idx === index ? { ...t, ...patch } : t));
    onChange({ tags: updated });
  };

  const removeTag = (index: number) => {
    const updated = data.tags.filter((_, idx) => idx !== index);
    onChange({ tags: updated });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-bold text-[#111B37]">Tags</h2>
          <p className="text-[13px] text-[#657794] mt-1">
            Tags are subtable-level static metadata (e.g. device serial, model, location), not
            time-varying metrics.
          </p>
        </div>
        <button
          type="button"
          onClick={addTag}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#D4DFEC] hover:bg-[#F9FAFD] text-[#111B37] rounded-lg text-[13px] font-semibold transition-colors shadow-2xs"
        >
          <Plus className="w-4 h-4 text-[#EF1B24]" />
          <span>Add Tag</span>
        </button>
      </div>

      {/* Explanatory banner */}
      <div className="p-4 bg-[#F0FDF4] border border-[#DCFCE7] rounded-xl flex items-start gap-3">
        <Tag className="w-5 h-5 text-[#0DBA67] flex-shrink-0 mt-0.5" />
        <div className="text-[12px] text-[#166534] space-y-1">
          <div className="font-semibold text-[#14532D]">Why Tags Matter in TDengine</div>
          <div>
            Each Subtable created under this Supertable assigns static values for these tags.
            TDengine uses tags for fast aggregation, filtering, and partitioning across millions of
            subtables without scanning metric rows.
          </div>
        </div>
      </div>

      {errors.tags && (
        <div className="p-3 bg-[#FEF2F2] border border-[#FAC6C9] rounded-lg text-[13px] text-[#EF1B24] flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{errors.tags}</span>
        </div>
      )}

      {/* Tags Table */}
      <div className="border border-[#E3EAF3] rounded-xl overflow-hidden shadow-xs">
        <table className="w-full text-left border-collapse text-[13px]">
          <thead className="bg-[#F8FAFC] border-b border-[#E3EAF3] text-[11px] font-bold text-[#657794] uppercase tracking-wider">
            <tr>
              <th className="py-2.5 px-3 w-12 text-center">#</th>
              <th className="py-2.5 px-3">Tag Name</th>
              <th className="py-2.5 px-3 w-56">Tag Type</th>
              <th className="py-2.5 px-3 w-20 text-center">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E3EAF3]">
            {data.tags.map((tag, idx) => (
              <tr key={idx} className="bg-white hover:bg-[#FBFDFE]">
                <td className="py-2.5 px-3 text-center text-[#657794] text-[12px] font-mono">
                  {idx + 1}
                </td>
                <td className="py-2.5 px-3">
                  <input
                    type="text"
                    value={tag.name}
                    onChange={(e) =>
                      updateTag(idx, { name: e.target.value.toLowerCase().trim() })
                    }
                    placeholder="e.g. resource_id, site_code"
                    className="w-full h-8 px-2.5 rounded-lg border border-[#D4DFEC] text-[12px] font-mono focus:outline-none focus:border-blue-500"
                  />
                </td>
                <td className="py-2.5 px-3">
                  <select
                    value={tag.td_type}
                    onChange={(e) => updateTag(idx, { td_type: e.target.value })}
                    className="w-full h-8 px-2 rounded-lg border border-[#D4DFEC] bg-white text-[12px] font-mono focus:outline-none focus:border-blue-500"
                  >
                    {TD_TAG_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2.5 px-3 text-center">
                  <button
                    type="button"
                    onClick={() => removeTag(idx)}
                    className="p-1 text-[#EF1B24] hover:text-[#D9141D]"
                    title="Remove tag"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {data.tags.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-[#657794] text-[13px]">
                  No tags added yet. TDengine requires at least one tag per Supertable.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ============================================================================
// Step 4: StableSourceMappingStep
// ============================================================================

export const StableSourceMappingStep: React.FC<StableStepProps> = ({ data, onChange }) => {
  const [activeTab, setActiveTab] = useState<SourceView>('hierarchy');
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingSources, setLoadingSources] = useState(false);
  const [selectedColumn, setSelectedColumn] = useState<string>(
    data.columns.find((c) => c.name !== 'ts')?.name || ''
  );

  useEffect(() => {
    let active = true;
    setLoadingSources(true);
    getSources({ view: activeTab, search: searchQuery || undefined })
      .then((res) => {
        if (active) {
          // Leaves are the bindable sources; `items` may be groups (resources / connections / models).
          const r = res as unknown as { leaves?: SourceRef[]; sources?: SourceRef[]; items?: SourceRef[] };
          const leaves = (r.leaves && r.leaves.length ? r.leaves : r.sources && r.sources.length ? r.sources : r.items || []) as SourceRef[];
          setSources(leaves.filter((l) => l && (l.kind === 'signal' || l.kind === 'model_field')));
          setLoadingSources(false);
        }
      })
      .catch(() => {
        if (active) setLoadingSources(false);
      });
    return () => {
      active = false;
    };
  }, [activeTab, searchQuery]);

  const mapSourceToColumn = (colName: string, src: SourceRef) => {
    const existing = data.source_mapping_template.filter((m) => m.column_name !== colName);
    const newMapping: SourceTemplateMapping = {
      column_name: colName,
      source_id: src.id,
      source_kind: src.kind === 'subtable' ? 'resource_context' : src.kind,
      source_path: src.path,
      source_type: src.data_type || undefined,
      source_unit: src.unit || undefined,
    };
    onChange({ source_mapping_template: [...existing, newMapping] });
  };

  const removeMapping = (colName: string) => {
    const filtered = data.source_mapping_template.filter((m) => m.column_name !== colName);
    onChange({ source_mapping_template: filtered });
  };

  const metricCols = data.columns.filter((c) => c.name !== 'ts');

  // Group by machine (Hierarchy / Models) or connection (Collector) with friendly names (R1-33).
  const { signals: appSignals, resources: appResources } = useApp();
  const machineOfSignal = useMemo(() => {
    const resName = new Map(appResources.map((r) => [r.id, r.code || r.name]));
    return new Map(appSignals.map((sg) => [sg.id, resName.get(sg.resourceId) || '']));
  }, [appSignals, appResources]);
  const groupedSources = useMemo(() => {
    const groups = new Map<string, { key: string; title: string; items: { src: SourceRef; label: string; sub: string }[] }>();
    for (const src of sources) {
      const sigId = String((src as SourceRef & { signal_id?: string }).signal_id || src.id).replace(/^sig:/, '');
      const machine = src.resource_name || machineOfSignal.get(sigId) || '';
      const groupTitle =
        activeTab === 'collector' ? src.connection_name || 'Unassigned connection' : activeTab === 'models' ? src.model_name || machine || 'Data Model' : machine || 'Unassigned';
      const key = src.key || src.field_path || src.name || src.display_name;
      const label = activeTab === 'collector' && machine ? `${machine} · ${key}` : activeTab === 'models' ? String(src.field_path || key) : String(key);
      const sub = [src.data_type || src.value_type || '', src.unit || '', activeTab === 'models' && machine ? machine : ''].filter(Boolean).join(' · ');
      const g = groups.get(groupTitle) || { key: groupTitle, title: groupTitle, items: [] };
      g.items.push({ src, label, sub });
      groups.set(groupTitle, g);
    }
    return Array.from(groups.values()).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }, [sources, activeTab, machineOfSignal]);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-bold text-[#111B37]">Source mapping (optional)</h2>
          <p className="text-[13px] text-[#657794] mt-1">
            Map incoming data signals to Supertable columns. This acts as a default template for subtables.
          </p>
        </div>

        {/* Skip button */}
        <label className="flex items-center gap-2 text-[12px] font-semibold text-[#657794] cursor-pointer bg-[#F8FAFC] px-3 py-1.5 rounded-lg border border-[#E3EAF3]">
          <input
            type="checkbox"
            checked={!!data.skip_source_mapping}
            onChange={(e) => onChange({ skip_source_mapping: e.target.checked })}
            className="rounded border-[#D4DFEC] text-[#EF1B24] focus:ring-[#EF1B24]"
          />
          <span>Skip for now</span>
        </label>
      </div>

      {!data.skip_source_mapping ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Source Picker */}
          <div className="border border-[#E3EAF3] rounded-xl overflow-hidden flex flex-col bg-white">
            {/* Tabs */}
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
                    className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[12px] font-semibold transition-all ${
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

            {/* Search */}
            <div className="p-3 border-b border-[#E3EAF3]">
              <div className="relative">
                <Search className="w-4 h-4 text-[#657794] absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter available signals..."
                  className="w-full h-8 pl-8 pr-3 rounded-lg border border-[#D4DFEC] text-[12px] focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            {/* List of sources */}
            <div className="p-2 overflow-y-auto max-h-72 divide-y divide-[#F1F5FA]">
              {loadingSources ? (
                <div className="py-8 text-center text-[#657794] text-[12px]">Loading sources...</div>
              ) : groupedSources.length === 0 ? (
                <div className="py-8 text-center text-[#657794] text-[12px]">No source found for this view.</div>
              ) : (
                groupedSources.map((g) => {
                  const open = openGroups.has(g.key) || !!searchQuery || groupedSources.length === 1;
                  return (
                    <div key={g.key} className="py-0.5">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setOpenGroups((prev) => { const n = new Set(prev); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-[#F6F8FC] text-left"
                      >
                        <span className="flex items-center gap-1.5 min-w-0">
                          {open ? <ChevronDown className="w-3.5 h-3.5 text-[#657794]" /> : <ChevronRight className="w-3.5 h-3.5 text-[#657794]" />}
                          <span className="text-[12px] font-semibold text-[#111B37] truncate">{g.title}</span>
                        </span>
                        <span className="text-[11px] text-[#657794] shrink-0">{g.items.length}</span>
                      </button>
                      {open && (
                        <div className="pl-5 space-y-0.5">
                          {g.items.map(({ src, label, sub }) => (
                            <div key={src.id} className="px-2 py-1.5 flex items-center justify-between gap-2 hover:bg-[#F8FAFC] rounded-md">
                              <div className="min-w-0">
                                <div className="text-[12px] font-semibold text-[#111B37] truncate font-mono" title={src.path}>
                                  {label}
                                </div>
                                {sub && <div className="text-[11px] text-[#657794] truncate">{sub}</div>}
                              </div>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={!selectedColumn}
                                onClick={() => selectedColumn && mapSourceToColumn(selectedColumn, src)}
                                icon={<Link2 className="w-3 h-3" />}
                              >
                                Map to {selectedColumn || 'column'}
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: Columns & Current Mappings */}
          <div className="border border-[#E3EAF3] rounded-xl overflow-hidden flex flex-col bg-white">
            <div className="bg-[#F8FAFC] px-4 py-2.5 border-b border-[#E3EAF3] text-[12px] font-bold text-[#334568]">
              Columns and mapped sources
            </div>

            <div className="p-3 overflow-y-auto max-h-96 space-y-2">
              {metricCols.map((col) => {
                const mapping = data.source_mapping_template.find(
                  (m) => m.column_name === col.name
                );
                const isSelected = selectedColumn === col.name;

                return (
                  <div
                    key={col.name}
                    onClick={() => setSelectedColumn(col.name)}
                    className={`p-3 rounded-xl border transition-all cursor-pointer ${
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
                        <span className="text-[11px] font-mono text-[#2A82E7] bg-[#EEF5FF] px-1.5 py-0.5 rounded">
                          {col.td_type}
                        </span>
                      </div>

                      {mapping && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeMapping(col.name);
                          }}
                          className="text-[#EF1B24] hover:text-[#D9141D] p-1"
                          title="Unbind source"
                        >
                          <Unlink className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {mapping ? (
                      <div className="mt-2 p-2 bg-[#F6F8FC] rounded-lg text-[11px]">
                        <div className="font-semibold text-[#111B37] truncate">
                          {mapping.source_path}
                        </div>
                        <div className="text-[#657794] text-[10px]">
                          Kind: {mapping.source_kind}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 text-[11px] text-[#657794] italic">
                        Not bound. Click a source on the left to map.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-8 text-center bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl space-y-2">
          <Info className="w-8 h-8 text-[#657794] mx-auto" />
          <div className="text-[14px] font-bold text-[#111B37]">Mapping skipped</div>
          <div className="text-[12px] text-[#657794] max-w-md mx-auto">
            You chose to define source bindings later. Subtables created from this Supertable will
            configure their own signal bindings individually.
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Step 5: StableRecordingStep
// ============================================================================

export const StableRecordingStep: React.FC<StableStepProps> = ({ data, onChange }) => {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[15px] font-bold text-[#111B37]">Recording</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Configure default data ingestion frequency and tolerance parameters for subtables.
        </p>
      </div>

      <div className="space-y-6 max-w-xl">
        {/* Recording Mode */}
        <div>
          <label className="block text-[13px] font-semibold text-[#111B37] mb-2">
            Default Ingestion Mode <span className="text-[#EF1B24]">*</span>
          </label>
          <div className="space-y-2.5">
            {[
              {
                id: 'ON_CHANGE' as RecordingMode,
                title: 'On Change',
                desc: 'Baseline first, then a row only when the value, null-state or quality changes.',
              },
              {
                id: 'ON_NEW_EVENT' as RecordingMode,
                title: 'On New Event (atomic row per event)',
                desc: 'One row with all bound fields per new event identity, e.g. a completion. Repeated identical events are not written again.',
              },
              {
                id: 'EVERY_ACQUISITION' as RecordingMode,
                title: 'Every Acquisition (Full Stream)',
                desc: 'Writes every sampled packet received from connectors directly to TDengine.',
              },
              {
                id: 'INTERVAL' as RecordingMode,
                title: 'Periodic Interval (Resampled)',
                desc: 'Samples and writes at a fixed interval (e.g. 1s, 5s), ignoring intermediary pulses.',
              },
            ].map((mode) => {
              const selected = data.default_recording_mode === mode.id;
              return (
                <div
                  key={mode.id}
                  onClick={() => onChange({ default_recording_mode: mode.id })}
                  className={`p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                    selected
                      ? 'border-[#EF1B24] bg-[#FFF5F5]'
                      : 'border-[#E3EAF3] bg-white hover:border-[#D4DFEC]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[13px] font-bold text-[#111B37]">{mode.title}</span>
                    <input
                      type="radio"
                      checked={selected}
                      onChange={() => {}}
                      className="text-[#EF1B24] focus:ring-[#EF1B24]"
                    />
                  </div>
                  <p className="text-[11px] text-[#657794]">{mode.desc}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Additional Parameters */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-[12px] font-semibold text-[#334568] mb-1">
              Retention (Days)
            </label>
            <input
              type="number"
              min="1"
              value={data.retention_days ?? ''}
              onChange={(e) =>
                onChange({
                  retention_days: e.target.value === '' ? null : parseInt(e.target.value, 10),
                })
              }
              placeholder="Inherit DB"
              className="w-full h-8 px-2.5 rounded-lg border border-[#D4DFEC] text-[12px] focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-[12px] font-semibold text-[#334568] mb-1">
              Max Checkpoint (s)
            </label>
            <input
              type="number"
              min="1"
              value={data.max_checkpoint_interval ?? ''}
              onChange={(e) =>
                onChange({
                  max_checkpoint_interval:
                    e.target.value === '' ? null : parseInt(e.target.value, 10),
                })
              }
              placeholder="e.g. 60"
              className="w-full h-8 px-2.5 rounded-lg border border-[#D4DFEC] text-[12px] focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-[12px] font-semibold text-[#334568] mb-1">
              Late Tolerance (s)
            </label>
            <input
              type="number"
              min="0"
              value={data.late_tolerance ?? ''}
              onChange={(e) =>
                onChange({
                  late_tolerance: e.target.value === '' ? null : parseInt(e.target.value, 10),
                })
              }
              placeholder="e.g. 10"
              className="w-full h-8 px-2.5 rounded-lg border border-[#D4DFEC] text-[12px] focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// DDL Helper for Stable
// ============================================================================

export function generateStableDDL(data: StableWizardData): string {
  const db = data.database_name ? `${data.database_name}.` : '';
  const name = data.physical_name || 'unnamed_stable';

  const colParts = data.columns.map((c) => {
    let t = c.td_type;
    if (['VARCHAR', 'NCHAR', 'BINARY'].includes(c.td_type) && c.length) {
      t = `${c.td_type}(${c.length})`;
    }
    return `  ${c.name} ${t}`;
  });

  const tagParts = data.tags.map((t) => `  ${t.name} ${t.td_type}`);

  return `CREATE STABLE ${db}${name} (
${colParts.join(',\n')}
) TAGS (
${tagParts.join(',\n')}
);`;
}

// ============================================================================
// Step 6: StableReviewStep
// ============================================================================

export function stableSpecFromWizard(data: StableWizardData): Record<string, unknown> {
  return {
    database: data.database_name,
    name: data.physical_name,
    display_name: data.display_name || undefined,
    description: data.description || undefined,
    columns: data.columns.map((c, i) => ({
      ...c,
      role: i === 0 ? 'timestamp' : 'value',
      length: VAR_LENGTH_TYPES.includes(c.td_type) ? c.length ?? 64 : c.length ?? null,
      primary_key: i === 1 && !!c.primary_key,
    })),
    tags: data.tags,
    default_recording_mode: data.default_recording_mode,
  };
}

export const StableReviewStep: React.FC<StableStepProps> = ({ data, onChange, errors = {} }) => {
  const [copied, setCopied] = useState(false);
  const [plan, setPlan] = useState<StoragePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const specKey = JSON.stringify(stableSpecFromWizard(data));
  useEffect(() => {
    let active = true;
    setPlanError(null);
    planStorageObject('stable', JSON.parse(specKey))
      .then((p) => active && setPlan(p))
      .catch((err: Error) => active && setPlanError(err.message || 'The plan could not be computed.'));
    return () => { active = false; };
  }, [specKey]);
  // The DDL shown is the backend compiler output (P1-4), never a client-side guess.
  const ddl = plan ? plan.ddl.join(';\n') : planError ? '' : 'Computing…';

  const handleCopy = () => {
    navigator.clipboard.writeText(ddl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[15px] font-bold text-[#111B37]">Review</h2>
        <p className="text-[13px] text-[#657794] mt-1">
          Review schema, tags, and generated TDengine DDL before deploying to storage.
        </p>
      </div>

      {/* Summary Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="p-3.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl">
          <div className="text-[11px] font-semibold text-[#657794] uppercase tracking-wider">
            Target Database
          </div>
          <div className="text-[14px] font-bold text-[#111B37] mt-0.5">
            {data.database_name || '—'}
          </div>
        </div>

        <div className="p-3.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl">
          <div className="text-[11px] font-semibold text-[#657794] uppercase tracking-wider">
            Columns / Tags
          </div>
          <div className="text-[14px] font-bold text-[#111B37] mt-0.5">
            {data.columns.length} columns · {data.tags.length} tags
          </div>
        </div>

        <div className="p-3.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-xl">
          <div className="text-[11px] font-semibold text-[#657794] uppercase tracking-wider">
            Recording Mode
          </div>
          <div className="text-[14px] font-bold text-[#111B37] mt-0.5">
            {data.default_recording_mode}
          </div>
        </div>
      </div>

      {(planError || (plan && plan.errors.length > 0)) && (
        <div className="p-3 rounded-xl border border-[#FAC6C9] bg-[#FFF0F1] text-[12px] text-[#334568] space-y-1">
          {planError && <div>{planError}</div>}
          {plan?.errors.map((e, i) => <div key={i}><span className="font-semibold">{e.field || 'spec'}:</span> {e.message}</div>)}
        </div>
      )}

      {/* DDL Preview Box */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[12px] font-bold text-[#111B37] uppercase tracking-wider">
            Physical DDL (from the backend)
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

        <pre className="p-4 bg-[#111B37] text-white rounded-lg font-mono text-[12px] overflow-x-auto leading-relaxed selection:bg-[#EF1B24] selection:text-white">
          {ddl}
        </pre>
      </div>

      {/* Binding Template Summary */}
      <div className="border border-[#E3EAF3] rounded-xl overflow-hidden">
        <div className="bg-[#F8FAFC] px-4 py-2.5 border-b border-[#E3EAF3] text-[12px] font-bold text-[#334568]">
          Binding Template Summary
        </div>
        <div className="p-4 text-[13px]">
          {data.skip_source_mapping || data.source_mapping_template.length === 0 ? (
            <p className="text-[#657794]">No template bindings defined (subtables will bind manually).</p>
          ) : (
            <div className="space-y-1.5">
              {data.source_mapping_template.map((m) => (
                <div key={m.column_name} className="flex items-center justify-between font-mono text-[12px]">
                  <span className="font-bold text-[#111B37]">{m.column_name}</span>
                  <span className="text-[#657794]">{m.source_path}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Confirm Checkbox */}
      <div className="pt-2">
        <label className="flex items-start gap-3 p-3.5 bg-[#FFF5F5] border border-[#FAC6C9] rounded-xl cursor-pointer">
          <input
            type="checkbox"
            checked={!!data.confirmed}
            disabled={!plan || !plan.valid}
            onChange={(e) => onChange({ confirmed: e.target.checked })}
            className="mt-0.5 rounded border-[#D4DFEC] text-[#EF1B24] focus:ring-[#EF1B24]"
          />
          <div className="text-[12px] text-[#334568] leading-relaxed">
            <span className="font-semibold text-[#111B37]">
              I confirm the creation of Supertable "{data.physical_name || '...'}"
            </span>{' '}
            in database "{data.database_name}".
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
