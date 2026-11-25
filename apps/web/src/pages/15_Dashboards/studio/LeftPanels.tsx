/**
 * Left panel of the Studio: Widgets (registry by category, click or drag), Data (source picker with
 * "Add to selected widget"), Variables (resource variables) and Settings (theme, defaults, grid).
 */
import React, { useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../../components/common/Button';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { Dialog } from '../../13_DataModels/ui';
import { SearchInput } from '../../historian/hsUi';
import { RegistryIcon } from '../../../features/dashboard/icons';
import { setDraggingWidgetType } from '../../../features/dashboard/components/DashboardCanvas';
import { RefreshSelect, ResourceSelect, TimeRangePicker } from '../../../features/dashboard/components/controls';
import { SourcePicker } from '../../../features/dashboard/components/SourcePicker';
import { VARIABLE_ID_RE } from '../../../features/dashboard/document';
import { CATEGORY_LABEL, CATEGORY_ORDER } from '../../../features/dashboard/registry';
import type { CatalogState } from '../../../features/dashboard/sources';
import { BUILTIN_TOKENS, THEME_PRESET_LABEL, isHexColor, presetTokens } from '../../../features/dashboard/theme';
import type {
  DashboardDocument,
  DashboardSettings,
  DashboardVariable,
  DashboardWidget,
  SourceItem,
  SourceResource,
  ThemePreset,
  ThemePresetId,
  ThemeSettings,
  WidgetTypeDef,
} from '../../../features/dashboard/types';
import { ColorEditor } from './OptionEditors';

const inputCls = 'w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg text-[12px] bg-white text-[#111B37] focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100';

// ------------------------------------------------------------------ widgets

export const WidgetsPanel: React.FC<{
  defs: WidgetTypeDef[];
  disabled: boolean;
  limit: number;
  onAdd: (def: WidgetTypeDef) => void;
}> = ({ defs, disabled, limit, onAdd }) => {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const groups = useMemo(() => {
    const out = new Map<string, WidgetTypeDef[]>();
    for (const d of defs) {
      if (needle && !`${d.label} ${d.description} ${d.type} ${CATEGORY_LABEL[d.category] || d.category}`.toLowerCase().includes(needle)) continue;
      const arr = out.get(d.category) || [];
      arr.push(d);
      out.set(d.category, arr);
    }
    const order = [...CATEGORY_ORDER, ...Array.from(out.keys()).filter((k) => !CATEGORY_ORDER.includes(k as WidgetTypeDef['category']))];
    return order.filter((k) => out.has(k)).map((k) => [k, out.get(k)!] as const);
  }, [defs, needle]);
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="p-2.5 border-b border-[#E3EAF3] space-y-1.5">
        <SearchInput value={q} onChange={setQ} placeholder="Search widgets" ariaLabel="Search widgets" />
        <p className="text-[10px] text-[#94A3B8]">{disabled ? `The limit of ${limit} widgets is reached. Delete one to add another.` : 'Click to add at the bottom, or drag onto the canvas.'}</p>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-3">
        {groups.map(([cat, list]) => (
          <section key={cat}>
            <h3 className="px-1 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] mb-1">{CATEGORY_LABEL[cat as WidgetTypeDef['category']] || cat}</h3>
            <div className="grid grid-cols-1 gap-1">
              {list.map((d) => (
                <button
                  key={d.type}
                  type="button"
                  draggable={!disabled}
                  disabled={disabled}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', d.type);
                    e.dataTransfer.effectAllowed = 'copy';
                    setDraggingWidgetType({ type: d.type, w: d.default_size.w, h: d.default_size.h });
                  }}
                  onDragEnd={() => window.setTimeout(() => setDraggingWidgetType(null), 0)}
                  onClick={() => onAdd(d)}
                  title={d.description}
                  className="w-full flex items-start gap-2 p-2 rounded-lg border border-[#E3EAF3] bg-white text-left hover:border-[#9FB4D1] hover:bg-[#F9FAFD] disabled:opacity-50 disabled:cursor-not-allowed cursor-grab active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                >
                  <span className="w-7 h-7 rounded-md bg-[#EEF5FF] text-[#134074] flex items-center justify-center shrink-0" aria-hidden="true">
                    <RegistryIcon name={d.icon} className="w-4 h-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12px] font-semibold text-[#111B37] truncate">{d.label}</span>
                    <span className="block text-[10px] text-[#657794] line-clamp-2 leading-snug">{d.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
        {groups.length === 0 && <p className="px-2 py-6 text-center text-[12px] text-[#657794]">No widget matches “{q}”.</p>}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ data

export const DataPanel: React.FC<{
  selected: DashboardWidget | null;
  selectedDef: WidgetTypeDef | undefined;
  onAdd: (item: SourceItem, role?: string) => void;
}> = ({ selected, selectedDef, onAdd }) => {
  const [sel, setSel] = useState<SourceItem | null>(null);
  const max = selectedDef?.data.max_bindings ?? 0;
  const full = selected ? selected.bindings.length >= max : true;
  const used = useMemo(
    () =>
      new Set(
        (selected?.bindings || []).map((b) =>
          b.source.kind === 'signal' ? b.source.signal_id : b.source.kind === 'model_field' ? `mod:${b.source.model_id}:${b.source.field_path}` : '',
        ),
      ),
    [selected],
  );
  const roles = selectedDef?.data.roles;
  const canBind = !!selected && max > 0 && !full;
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-2.5 py-2 border-b border-[#E3EAF3] text-[11px] text-[#657794]">
        {!selected ? (
          'Select a widget on the canvas, then pick its data here.'
        ) : max === 0 ? (
          `“${selected.title || selectedDef?.label}” shows no data.`
        ) : full ? (
          `“${selected.title || selectedDef?.label}” already has ${max} source${max === 1 ? '' : 's'} (its maximum).`
        ) : (
          <>
            Adding to <strong className="text-[#111B37]">{selected.title || selectedDef?.label}</strong> ({selected.bindings.length}/{max})
          </>
        )}
      </div>
      <SourcePicker
        className="flex-1"
        acceptKinds={selectedDef?.data.value_kinds || []}
        selectedToken={sel?.token ?? null}
        onSelect={setSel}
        onPick={(item) => canBind && onAdd(item, roles?.length ? firstOpenRole(selected!, selectedDef!) : undefined)}
        usedTokens={used}
        actions={(item) =>
          !selected || max === 0 ? (
            <span className="text-[11px] text-[#657794]">Select a widget that shows data.</span>
          ) : roles?.length ? (
            roles.map((r) => (
              <Button key={r.id} size="sm" variant={r.id === firstOpenRole(selected, selectedDef!) ? 'primary' : 'outline'} disabled={full} onClick={() => onAdd(item, r.id)}>
                Add as {r.label}
              </Button>
            ))
          ) : (
            <Button size="sm" variant="primary" disabled={full} onClick={() => onAdd(item)} title={full ? 'This widget has its maximum number of sources.' : undefined}>
              Add to selected widget
            </Button>
          )
        }
      />
    </div>
  );
};

function firstOpenRole(w: DashboardWidget, def: WidgetTypeDef): string | undefined {
  const roles = def.data.roles || [];
  const open = roles.find((r) => r.required && !w.bindings.some((b) => b.role === r.id)) || roles.find((r) => !w.bindings.some((b) => b.role === r.id));
  return (open || roles[roles.length - 1])?.id;
}

// ------------------------------------------------------------------ variables

export const VariablesPanel: React.FC<{
  doc: DashboardDocument;
  catalog: CatalogState;
  max: number;
  onChange: (variables: DashboardVariable[], coalesce?: string) => void;
}> = ({ doc, catalog, max, onChange }) => {
  const [editing, setEditing] = useState<{ index: number | null; v: DashboardVariable } | null>(null);
  const [toDelete, setToDelete] = useState<number | null>(null);
  const resources = catalog.catalog?.resources || [];
  const typeKeys = useMemo(() => Array.from(new Set(resources.map((r) => r.type_key).filter(Boolean))).sort(), [resources]);
  const usage = (id: string) =>
    doc.widgets.filter((w) => w.bindings.some((b) => b.source.kind === 'signal_key' && b.source.variable === id) || w.options.variable === id).length;

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="p-2.5 border-b border-[#E3EAF3] space-y-1">
        <Button
          size="sm"
          variant="outline"
          icon={<Plus className="w-3.5 h-3.5" />}
          disabled={doc.variables.length >= max}
          title={doc.variables.length >= max ? `At most ${max} variables per dashboard.` : undefined}
          onClick={() => setEditing({ index: null, v: { id: '', label: '', type: 'resource', resource_type: typeKeys.includes('machine') ? 'machine' : null, default: null } })}
        >
          Add variable
        </Button>
        <p className="text-[10px] text-[#94A3B8] leading-snug">
          A variable lets viewers pick a resource (e.g. a machine) in the header. Bind a widget source to it with “Bind to variable” in the Data tab.
        </p>
      </div>
      <ul className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
        {doc.variables.length === 0 && <li className="px-2 py-6 text-center text-[12px] text-[#657794]">No variables yet.</li>}
        {doc.variables.map((v, i) => {
          const def = v.default ? catalog.resourcesById.get(v.default) : undefined;
          const n = usage(v.id);
          return (
            <li key={v.id} className="rounded-lg border border-[#E3EAF3] bg-white p-2">
              <div className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold text-[#111B37] truncate">{v.label || v.id}</div>
                  <div className="text-[10px] text-[#657794] font-mono truncate">
                    {v.id} · {v.resource_type || 'any resource'}
                  </div>
                </div>
                <button type="button" onClick={() => setEditing({ index: i, v: { ...v } })} className="p-1.5 rounded-md text-[#657794] hover:bg-[#F1F5FA]" aria-label={`Edit variable ${v.label || v.id}`}>
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button type="button" onClick={() => setToDelete(i)} className="p-1.5 rounded-md text-[#657794] hover:bg-red-50 hover:text-red-600" aria-label={`Delete variable ${v.label || v.id}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="mt-1 text-[10px] text-[#94A3B8]">
                Default: {def ? def.name : v.default ? 'unknown resource' : 'none'} · used by {n} widget{n === 1 ? '' : 's'}
              </div>
            </li>
          );
        })}
      </ul>
      <VariableDialog
        state={editing}
        existing={doc.variables}
        typeKeys={typeKeys}
        resources={resources}
        onClose={() => setEditing(null)}
        onSave={(v, index) => {
          if (index === null) onChange([...doc.variables, v]);
          else onChange(doc.variables.map((x, k) => (k === index ? v : x)));
          setEditing(null);
        }}
      />
      <ConfirmDialog
        isOpen={toDelete !== null}
        title={`Delete variable “${toDelete !== null ? doc.variables[toDelete]?.label || doc.variables[toDelete]?.id : ''}”?`}
        message={
          toDelete !== null && usage(doc.variables[toDelete].id) > 0
            ? `${usage(doc.variables[toDelete].id)} widget(s) use it; their variable-bound sources will show an error until you rebind them. You can undo this.`
            : 'No widget uses it. You can undo this.'
        }
        confirmLabel="Delete"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete === null) return;
          onChange(doc.variables.filter((_, k) => k !== toDelete));
          setToDelete(null);
        }}
      />
    </div>
  );
};

const VariableDialog: React.FC<{
  state: { index: number | null; v: DashboardVariable } | null;
  existing: DashboardVariable[];
  typeKeys: string[];
  resources: SourceResource[];
  onClose: () => void;
  onSave: (v: DashboardVariable, index: number | null) => void;
}> = ({ state, existing, typeKeys, resources, onClose, onSave }) => {
  const [v, setV] = useState<DashboardVariable | null>(null);
  React.useEffect(() => setV(state ? { ...state.v } : null), [state]);
  if (!state || !v) return null;
  const isNew = state.index === null;
  const idTaken = existing.some((x, k) => x.id === v.id && k !== state.index);
  const idError = !v.id ? 'Enter an id.' : !VARIABLE_ID_RE.test(v.id) ? 'Lowercase letters, digits and _, starting with a letter (max 40).' : idTaken ? 'Another variable has this id.' : null;
  const labelError = !v.label.trim() ? 'Enter a label.' : null;
  const defaultRes = v.default ? resources.find((r) => r.id === v.default) : undefined;
  const defaultWrongType = defaultRes && v.resource_type && defaultRes.type_key !== v.resource_type;
  const valid = !idError && !labelError && !defaultWrongType;
  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? 'Add variable' : 'Edit variable'}
      width="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSave({ ...v, label: v.label.trim() }, state.index)}>
            {isNew ? 'Add' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave({ ...v, label: v.label.trim() }, state.index);
        }}
      >
        <div>
          <label htmlFor="var-label" className="block text-[12px] font-semibold text-[#334568] mb-1">
            Label
          </label>
          <input
            id="var-label"
            className={inputCls}
            value={v.label}
            maxLength={60}
            onChange={(e) => {
              const label = e.target.value;
              setV((cur) =>
                cur
                  ? {
                      ...cur,
                      label,
                      id: isNew && (!cur.id || cur.id === slug(cur.label)) ? slug(label) : cur.id,
                    }
                  : cur,
              );
            }}
            placeholder="Machine"
          />
          {labelError && v.label !== '' && <p className="text-[11px] text-red-700 mt-0.5">{labelError}</p>}
        </div>
        <div>
          <label htmlFor="var-id" className="block text-[12px] font-semibold text-[#334568] mb-1">
            Id <span className="font-normal text-[#94A3B8]">(used in links: ?var-{v.id || 'id'}=…)</span>
          </label>
          <input id="var-id" className={`${inputCls} font-mono`} value={v.id} maxLength={40} onChange={(e) => setV({ ...v, id: e.target.value.toLowerCase() })} disabled={!isNew} />
          {idError && v.id !== '' && <p className="text-[11px] text-red-700 mt-0.5">{idError}</p>}
          {!isNew && <p className="text-[10px] text-[#94A3B8] mt-0.5">The id cannot change: bindings and links refer to it.</p>}
        </div>
        <div>
          <label htmlFor="var-type" className="block text-[12px] font-semibold text-[#334568] mb-1">
            Resource type
          </label>
          <select id="var-type" className={inputCls} value={v.resource_type || ''} onChange={(e) => setV({ ...v, resource_type: e.target.value || null })}>
            <option value="">Any resource</option>
            {typeKeys.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            {v.resource_type && !typeKeys.includes(v.resource_type) && <option value={v.resource_type}>{v.resource_type}</option>}
          </select>
        </div>
        <div>
          <span className="block text-[12px] font-semibold text-[#334568] mb-1">Default</span>
          <ResourceSelect ariaLabel="Default resource" value={v.default} onChange={(id) => setV({ ...v, default: id })} resources={resources} typeKey={v.resource_type} allowNone noneLabel="None" />
          {defaultWrongType && <p className="text-[11px] text-red-700 mt-0.5">The default is not a {v.resource_type}.</p>}
        </div>
      </form>
    </Dialog>
  );
};

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(out) ? out : out ? `v_${out}`.slice(0, 40) : '';
}

// ------------------------------------------------------------------ settings

export const SettingsPanel: React.FC<{
  settings: DashboardSettings;
  presets: ThemePreset[];
  description: string;
  onDescription: (d: string) => void;
  onChange: (s: DashboardSettings, coalesce?: string) => void;
}> = ({ settings, presets, description, onDescription, onChange }) => {
  const t = settings.theme;
  const setTheme = (patch: Partial<ThemeSettings>, coalesce?: string) => onChange({ ...settings, theme: { ...t, ...patch } }, coalesce);
  const presetIds = (presets.length ? presets.map((p) => p.id) : (Object.keys(BUILTIN_TOKENS) as ThemePresetId[])) as ThemePresetId[];
  const tokens = presetTokens(t.preset, presets);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
      <section>
        <label htmlFor="set-desc" className="block text-[12px] font-semibold text-[#334568] mb-1">
          Description
        </label>
        <textarea id="set-desc" className={`${inputCls} h-auto min-h-[60px] py-1.5`} value={description} maxLength={500} onChange={(e) => onDescription(e.target.value)} />
      </section>
      <section>
        <h3 className="text-[12px] font-bold text-[#111B37] mb-1.5">Theme</h3>
        <div className="grid grid-cols-1 gap-1.5" role="radiogroup" aria-label="Theme preset">
          {presetIds.map((id) => {
            const tk = presetTokens(id, presets);
            const p = presets.find((x) => x.id === id);
            const on = t.preset === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setTheme({ preset: id })}
                className={`flex items-center gap-2 p-2 rounded-lg border text-left ${on ? 'border-[#2A82E7] ring-2 ring-[#2A82E7]/20' : 'border-[#E3EAF3] hover:border-[#CBD5E1]'}`}
              >
                <span className="w-10 h-7 rounded-md border border-black/10 shrink-0 flex items-end p-1 gap-0.5" style={{ background: tk.canvas }} aria-hidden="true">
                  <span className="flex-1 h-3.5 rounded-sm" style={{ background: tk.surface }} />
                  <span className="w-1.5 h-3.5 rounded-sm" style={{ background: tk.accent }} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-semibold text-[#111B37]">{p?.label || THEME_PRESET_LABEL[id] || id}</span>
                  {p?.description && <span className="block text-[10px] text-[#657794] truncate">{p.description}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="space-y-2.5">
        <h3 className="text-[12px] font-bold text-[#111B37]">Theme overrides</h3>
        {(
          [
            ['accent', 'Accent'],
            ['canvas', 'Canvas background'],
            ['surface', 'Widget background'],
            ['text', 'Text'],
          ] as const
        ).map(([k, label]) => (
          <div key={k}>
            <span className="block text-[11px] font-semibold text-[#334568] mb-0.5">{label}</span>
            <ColorEditor value={t[k]} onChange={(c) => setTheme({ [k]: c && isHexColor(c) ? c : null }, `theme:${k}`)} nullable nullLabel="Preset" ctx={{ theme: tokens }} />
          </div>
        ))}
        <RangeField label="Corner radius" value={t.radius} min={0} max={24} step={1} unit="px" onChange={(v) => setTheme({ radius: v }, 'theme:radius')} />
        <RangeField label="Gap between widgets" value={t.gap} min={4} max={32} step={1} unit="px" onChange={(v) => setTheme({ gap: v }, 'theme:gap')} />
        <RangeField label="Font scale" value={t.font_scale} min={0.8} max={1.4} step={0.05} unit="×" onChange={(v) => setTheme({ font_scale: Math.round(v * 100) / 100 }, 'theme:font')} />
      </section>
      <section className="space-y-2.5">
        <h3 className="text-[12px] font-bold text-[#111B37]">Defaults for viewers</h3>
        <div>
          <span className="block text-[11px] font-semibold text-[#334568] mb-0.5">Default time range</span>
          <TimeRangePicker value={settings.time_range} onChange={(time_range) => onChange({ ...settings, time_range })} align="left" ariaLabel="Default time range" />
        </div>
        <div>
          <span className="block text-[11px] font-semibold text-[#334568] mb-0.5">History refresh</span>
          <RefreshSelect value={settings.refresh} onChange={(refresh) => onChange({ ...settings, refresh })} />
          <p className="text-[10px] text-[#94A3B8] mt-0.5">Live values always update as they arrive. “Live” also re-reads history every minute.</p>
        </div>
        <RangeField label="Row height" value={settings.row_height} min={24} max={96} step={2} unit="px" onChange={(v) => onChange({ ...settings, row_height: v }, 'row_height')} />
      </section>
    </div>
  );
};

const RangeField: React.FC<{ label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }> = ({ label, value, min, max, step, unit, onChange }) => {
  const id = React.useId();
  return (
    <div>
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-[11px] font-semibold text-[#334568]">
          {label}
        </label>
        <span className="text-[11px] font-mono text-[#657794]">
          {value}
          {unit}
        </span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[#2A82E7]" />
    </div>
  );
};
