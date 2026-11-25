/**
 * Right panel of the Studio: properties of the selected widget, generated from the registry options
 * (tabs General / Data / Display / Thresholds / Style) plus the bindings editor (Data) and the grid
 * position + per-breakpoint visibility (Layout).
 */
import React, { useMemo } from 'react';
import { Copy, Eye, EyeOff, MousePointerClick, Trash2 } from 'lucide-react';
import { RegistryIcon } from '../../../features/dashboard/icons';
import { TimeRangePicker } from '../../../features/dashboard/components/controls';
import { BREAKPOINTS, BREAKPOINT_LABEL, clampRect, isBreakpointCustomized, rectsFor } from '../../../features/dashboard/document';
import { mergeOptions, optionVisible } from '../../../features/dashboard/registry';
import type { CatalogState } from '../../../features/dashboard/sources';
import { BREAKPOINT_COLUMNS } from '../../../features/dashboard/types';
import type { Binding, Breakpoint, DashboardDocument, DashboardWidget, OptionGroup, ThemeTokens, WidgetTypeDef } from '../../../features/dashboard/types';
import { OptionField, Switch, type OptionContext } from './OptionEditors';
import { BindingsEditor } from './BindingsEditor';

export type InspectorTab = OptionGroup | 'layout';

const TAB_LABEL: Record<InspectorTab, string> = {
  general: 'General',
  data: 'Data',
  display: 'Display',
  thresholds: 'Thresholds',
  style: 'Style',
  layout: 'Layout',
};
const TAB_ORDER: InspectorTab[] = ['general', 'data', 'display', 'thresholds', 'style', 'layout'];

const inputCls = 'w-full h-8 px-2.5 border border-[#D4DFEC] rounded-lg text-[12px] bg-white text-[#111B37] focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100';

export function inspectorTabs(def: WidgetTypeDef | undefined): InspectorTab[] {
  if (!def) return ['general', 'layout'];
  const groups = new Set<InspectorTab>(def.options.map((o) => o.group));
  groups.add('general');
  if (def.data.max_bindings > 0) groups.add('data');
  groups.add('layout');
  return TAB_ORDER.filter((t) => groups.has(t));
}

export const Inspector: React.FC<{
  widget: DashboardWidget;
  def: WidgetTypeDef | undefined;
  doc: DashboardDocument;
  defs: Map<string, WidgetTypeDef>;
  bp: Breakpoint;
  tab: InspectorTab;
  setTab: (t: InspectorTab) => void;
  update: (patch: (w: DashboardWidget) => DashboardWidget, coalesce?: string) => void;
  catalog: CatalogState;
  theme: ThemeTokens;
  dashboardId: string;
  onAddSource: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}> = ({ widget, def, doc, defs, bp, tab, setTab, update, catalog, theme, dashboardId, onAddSource, onDuplicate, onDelete }) => {
  const merged = useMemo(() => mergeOptions(def, widget.options), [def, widget.options]);
  const tabs = inspectorTabs(def);
  const current = tabs.includes(tab) ? tab : tabs[0];
  const ctx: OptionContext = { theme, variables: doc.variables, resources: catalog.catalog?.resources || [], dashboardId };

  const setOption = (key: string, value: unknown) =>
    update((w) => {
      const spec = def?.options.find((o) => o.key === key);
      const next = { ...w.options };
      if (spec && JSON.stringify(value ?? null) === JSON.stringify(spec.default ?? null)) delete next[key];
      else next[key] = value;
      return { ...w, options: next };
    }, `opt:${widget.id}:${key}`);

  const options = (def?.options || []).filter((o) => o.group === current && optionVisible(o, merged));

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-3 pt-3 pb-2 border-b border-[#E3EAF3]">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-md bg-[#EEF5FF] text-[#134074] flex items-center justify-center shrink-0" aria-hidden="true">
            <RegistryIcon name={def?.icon} className="w-4 h-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold text-[#111B37] truncate">{widget.title || def?.label || widget.type}</div>
            <div className="text-[10px] text-[#94A3B8] font-mono truncate">
              {def?.label || widget.type} · {widget.id}
            </div>
          </div>
          <button type="button" onClick={onDuplicate} className="p-1.5 rounded-md text-[#657794] hover:bg-[#F1F5FA] hover:text-[#111B37]" aria-label="Duplicate widget" title="Duplicate">
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button type="button" onClick={onDelete} className="p-1.5 rounded-md text-[#657794] hover:bg-red-50 hover:text-red-600" aria-label="Delete widget" title="Delete (Del)">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1" role="tablist" aria-label="Widget properties">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === current}
              onClick={() => setTab(t)}
              className={`px-2 py-1 rounded-md text-[11px] font-semibold transition ${t === current ? 'bg-[#111B37] text-white' : 'text-[#657794] hover:bg-[#F1F5FA] hover:text-[#111B37]'}`}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3.5" role="tabpanel" aria-label={TAB_LABEL[current]}>
        {!def && <p className="text-[12px] text-red-700">This widget type is not available on this server. You can delete the widget or keep it as is.</p>}
        {current === 'general' && (
          <div>
            <label htmlFor="insp-title" className="block text-[12px] font-semibold text-[#334568] mb-1">
              Title
            </label>
            <input
              id="insp-title"
              className={inputCls}
              value={widget.title}
              maxLength={120}
              onChange={(e) => {
                const title = e.target.value;
                update((w) => ({ ...w, title }), `title:${widget.id}`);
              }}
            />
          </div>
        )}
        {current === 'data' && def && def.data.max_bindings > 0 && (
          <>
            <BindingsEditor
              widget={widget}
              def={def}
              variables={doc.variables}
              catalog={catalog}
              onAddSource={onAddSource}
              onChange={(bindings: Binding[], coalesce?: string) => update((w) => ({ ...w, bindings }), coalesce)}
            />
            {def.data.history !== 'none' && <TimeEditor widget={widget} update={update} />}
          </>
        )}
        {current !== 'layout' &&
          options.map((spec) => <OptionField key={spec.key} spec={spec} value={merged[spec.key]} onChange={(v) => setOption(spec.key, v)} ctx={ctx} />)}
        {current !== 'layout' && current !== 'data' && current !== 'general' && options.length === 0 && <p className="text-[12px] text-[#94A3B8]">Nothing to set here for the current choices.</p>}
        {current === 'layout' && <LayoutEditor widget={widget} def={def} doc={doc} defs={defs} bp={bp} update={update} />}
      </div>
    </div>
  );
};

const TimeEditor: React.FC<{ widget: DashboardWidget; update: (patch: (w: DashboardWidget) => DashboardWidget) => void }> = ({ widget, update }) => {
  const custom = widget.time.mode === 'custom';
  return (
    <div className="rounded-lg border border-[#E3EAF3] p-2.5 space-y-2">
      <span className="block text-[12px] font-semibold text-[#334568]">Time range</span>
      <div role="radiogroup" aria-label="Time range of this widget" className="flex w-full bg-slate-100 p-0.5 rounded-lg border border-slate-200">
        {[
          { id: 'dashboard', label: 'Follow dashboard' },
          { id: 'custom', label: 'Own range' },
        ].map((o) => {
          const on = (o.id === 'custom') === custom;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() =>
                update((w) => ({ ...w, time: o.id === 'custom' ? { mode: 'custom', range: w.time.mode === 'custom' ? w.time.range : { kind: 'relative', last: '24h' } } : { mode: 'dashboard' } }))
              }
              className={`flex-1 px-1.5 py-1 text-[11px] font-semibold rounded-md transition ${on ? 'bg-white text-[#111B37] shadow-xs' : 'text-[#657794] hover:text-[#111B37]'}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {widget.time.mode === 'custom' && (
        <TimeRangePicker value={widget.time.range} onChange={(range) => update((w) => ({ ...w, time: { mode: 'custom', range } }))} align="left" ariaLabel="Widget time range" />
      )}
      <p className="text-[10px] text-[#94A3B8]">{custom ? 'This widget ignores the dashboard time range.' : 'Uses the time range chosen in the dashboard header.'}</p>
    </div>
  );
};

const LayoutEditor: React.FC<{
  widget: DashboardWidget;
  def: WidgetTypeDef | undefined;
  doc: DashboardDocument;
  defs: Map<string, WidgetTypeDef>;
  bp: Breakpoint;
  update: (patch: (w: DashboardWidget) => DashboardWidget, coalesce?: string) => void;
}> = ({ widget, def, doc, defs, bp, update }) => {
  const rect = useMemo(() => rectsFor(doc.widgets, defs, bp).get(widget.id) || widget.layout.lg, [doc.widgets, defs, bp, widget]);
  const derived = bp !== 'lg' && !widget.layout[bp];
  const cols = BREAKPOINT_COLUMNS[bp];
  const setField = (k: 'x' | 'y' | 'w' | 'h', v: number) =>
    update((w) => ({ ...w, layout: { ...w.layout, [bp]: clampRect({ ...rect, [k]: v }, bp, def) } }), `layout:${widget.id}:${bp}:${k}`);
  return (
    <div className="space-y-3">
      <div>
        <div className="text-[12px] font-semibold text-[#334568]">
          Position on {BREAKPOINT_LABEL[bp]} <span className="font-normal text-[#94A3B8]">({cols} column{cols === 1 ? '' : 's'})</span>
        </div>
        {derived && <p className="text-[10px] text-[#94A3B8] mt-0.5">Derived from the Desktop layout until you change it here or move a widget on this breakpoint.</p>}
        <div className="grid grid-cols-4 gap-1.5 mt-1.5">
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <div key={k}>
              <label htmlFor={`lay-${k}`} className="block text-[10px] font-semibold uppercase text-[#657794]">
                {k === 'x' ? 'Column' : k === 'y' ? 'Row' : k === 'w' ? 'Width' : 'Height'}
              </label>
              <input
                id={`lay-${k}`}
                type="number"
                min={0}
                step={1}
                className={inputCls}
                value={rect[k]}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n)) setField(k, n);
                }}
              />
            </div>
          ))}
        </div>
        {def && (
          <p className="text-[10px] text-[#94A3B8] mt-1">
            Minimum {Math.min(def.min_size.w, cols)} × {def.min_size.h}; x + width ≤ {cols}; height ≤ 40 rows.
          </p>
        )}
      </div>
      <div>
        <div className="text-[12px] font-semibold text-[#334568] mb-1">Visible on</div>
        <ul className="space-y-1">
          {BREAKPOINTS.map((b) => (
            <li key={b} className="flex items-center justify-between gap-2 text-[12px] text-[#334568]">
              <span className="inline-flex items-center gap-1.5">
                {widget.hidden[b] ? <EyeOff className="w-3.5 h-3.5 text-[#94A3B8]" aria-hidden="true" /> : <Eye className="w-3.5 h-3.5 text-[#657794]" aria-hidden="true" />}
                {BREAKPOINT_LABEL[b]}
                {b !== 'lg' && isBreakpointCustomized(doc, b) && <span className="text-[10px] text-[#94A3B8]">custom layout</span>}
              </span>
              <Switch
                checked={!widget.hidden[b]}
                onChange={(v) => update((w) => ({ ...w, hidden: { ...w.hidden, [b]: !v } }))}
                label={`Show on ${BREAKPOINT_LABEL[b]}`}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export const EmptyInspector: React.FC<{ doc: DashboardDocument; limit: number }> = ({ doc, limit }) => (
  <div className="p-4 text-[12px] text-[#657794] space-y-3">
    <div className="flex items-center gap-2 text-[#334568]">
      <MousePointerClick className="w-4 h-4" aria-hidden="true" />
      <span className="font-semibold">Nothing selected</span>
    </div>
    <p>Click a widget on the canvas to edit its data, display and layout. Dashboard-wide settings (theme, time range, refresh) are in the Settings tab on the left.</p>
    <dl className="grid grid-cols-2 gap-y-1 text-[11px]">
      <dt>Widgets</dt>
      <dd className="text-right font-semibold text-[#334568]">
        {doc.widgets.length} / {limit}
      </dd>
      <dt>Variables</dt>
      <dd className="text-right font-semibold text-[#334568]">{doc.variables.length}</dd>
      <dt>Data sources</dt>
      <dd className="text-right font-semibold text-[#334568]">{doc.widgets.reduce((a, w) => a + w.bindings.length, 0)}</dd>
    </dl>
    <div className="text-[11px] space-y-0.5">
      <p className="font-semibold text-[#334568]">Keyboard</p>
      <p>Ctrl+S save · Ctrl+Z undo · Ctrl+Shift+Z redo · Del delete the selected widget · Esc deselect</p>
    </div>
  </div>
);
