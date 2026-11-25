/**
 * Data bindings of the selected widget: ordered list (up/down), per binding label / color / unit /
 * scale / offset / role, the resolved source with its capability and resolve error, "Bind to variable"
 * (signal → signal_key with a key that exists on the variable's selectable resources), and the registry
 * rules (min/max bindings, required roles, value kinds) as clear messages.
 */
import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Database, Link2, Plus, Trash2, Unlink, Variable } from 'lucide-react';
import { CapabilityChip } from '../../../features/dashboard/components/SourcePicker';
import { bindingIssues } from '../../../features/dashboard/document';
import { useRuntime, useRuntimeVersion } from '../../../features/dashboard/runtime/RuntimeProvider';
import { kindAccepted, valueKindOf, type CatalogState } from '../../../features/dashboard/sources';
import { paletteColor } from '../../../features/dashboard/theme';
import type { Binding, DashboardVariable, DashboardWidget, SourceItem, SourceRef, WidgetTypeDef } from '../../../features/dashboard/types';
import { ColorEditor } from './OptionEditors';

const inputCls = 'w-full h-8 px-2 border border-[#D4DFEC] rounded-lg text-[12px] bg-white text-[#111B37] focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100';
const smallBtn = 'inline-flex items-center justify-center w-7 h-7 rounded-md text-[#657794] hover:bg-[#F1F5FA] hover:text-[#111B37] disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300';

export const BindingsEditor: React.FC<{
  widget: DashboardWidget;
  def: WidgetTypeDef;
  variables: DashboardVariable[];
  catalog: CatalogState;
  onChange: (bindings: Binding[], coalesce?: string) => void;
  onAddSource: () => void;
}> = ({ widget, def, variables, catalog, onChange, onAddSource }) => {
  const { store, theme } = useRuntime();
  useRuntimeVersion();
  const [open, setOpen] = useState<string | null>(widget.bindings[0]?.id ?? null);
  const issues = bindingIssues(widget, def);
  const max = def.data.max_bindings;
  const roles = def.data.roles;
  const set = (i: number, patch: Partial<Binding>, coalesce?: string) => onChange(widget.bindings.map((b, k) => (k === i ? { ...b, ...patch } : b)), coalesce);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= widget.bindings.length) return;
    const next = widget.bindings.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-[#334568]">
          Data sources{' '}
          <span className="font-normal text-[#94A3B8]">
            {widget.bindings.length}/{max}
            {def.data.min_bindings > 0 ? ` · at least ${def.data.min_bindings}` : ''}
          </span>
        </span>
        <button type="button" onClick={onAddSource} disabled={widget.bindings.length >= max} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#2A82E7] hover:underline disabled:opacity-40 disabled:no-underline">
          <Plus className="w-3 h-3" aria-hidden="true" /> Add source
        </button>
      </div>
      <p className="text-[10px] text-[#94A3B8]">
        Accepts {def.data.value_kinds.includes('any') ? 'any value' : def.data.value_kinds.join(', ')} · history {def.data.history}
        {roles?.length ? ` · roles: ${roles.map((r) => `${r.label}${r.required ? ' (required)' : ''}`).join(', ')}` : ''}
      </p>
      {issues.length > 0 && (
        <ul className="space-y-0.5" aria-live="polite">
          {issues.map((i) => (
            <li key={i.message} className={`text-[11px] rounded-md px-2 py-1 ${i.severity === 'error' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900'}`}>
              {i.message}
            </li>
          ))}
        </ul>
      )}
      {widget.bindings.length === 0 && (
        <button type="button" onClick={onAddSource} className="w-full rounded-lg border-2 border-dashed border-[#CBD5E1] hover:border-[#2A82E7] p-4 text-center text-[12px] text-[#657794]">
          <Database className="w-5 h-5 mx-auto mb-1 text-[#94A3B8]" aria-hidden="true" />
          Open the Data panel and pick a signal or a Data Model field.
        </button>
      )}
      <ol className="space-y-1.5">
        {widget.bindings.map((b, i) => {
          const resolved = store.getResolved(b.source);
          const item = resolved?.token ? catalog.byToken.get(resolved.token) : b.source.kind === 'signal' ? catalog.byToken.get(b.source.signal_id) : undefined;
          const isOpen = open === b.id;
          const name = b.label || resolved?.label || sourceText(b.source, item);
          const resolvedKind = resolved?.ok ? valueKindOf(resolved.value_type, resolved.value_kind) : 'unknown';
          const kindBad = resolved?.ok && !kindAccepted(resolvedKind, def.data.value_kinds);
          const kindUnknown = resolved?.ok && resolvedKind === 'unknown' && !def.data.value_kinds.includes('any');
          return (
            <li key={b.id} className="rounded-lg border border-[#E3EAF3] bg-white">
              <div className="flex items-center gap-1 px-1.5 py-1">
                <button type="button" onClick={() => setOpen(isOpen ? null : b.id)} aria-expanded={isOpen} className="min-w-0 flex-1 flex items-center gap-1.5 text-left focus:outline-none">
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-[#657794] shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-[#657794] shrink-0" />}
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: b.color || paletteColor(theme, i) }} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-[12px] font-semibold text-[#111B37] truncate">{name}</span>
                    <span className="block text-[10px] text-[#657794] truncate">
                      {b.role && roles ? `${roles.find((r) => r.id === b.role)?.label ?? b.role} · ` : ''}
                      {b.source.kind === 'signal_key' ? `Variable “${b.source.variable}” · key ${b.source.key}` : resolved?.resource?.name || (b.source.kind === 'model_field' ? 'Data Model field' : 'Signal')}
                    </span>
                  </span>
                </button>
                {resolved && !resolved.ok && <span className="text-[9px] font-bold uppercase text-red-700 shrink-0">Error</span>}
                <button type="button" className={smallBtn} onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${name} up`}>
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button type="button" className={smallBtn} onClick={() => move(i, 1)} disabled={i === widget.bindings.length - 1} aria-label={`Move ${name} down`}>
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
                <button type="button" className={smallBtn} onClick={() => onChange(widget.bindings.filter((_, k) => k !== i))} aria-label={`Remove ${name}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              {isOpen && (
                <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-[#F1F5F9]">
                  <div className="rounded-md bg-[#F9FAFD] border border-[#EEF2F7] p-2 text-[11px] space-y-1">
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 text-[#334568]">
                        <span className="font-semibold">{resolved?.label || sourceText(b.source, item)}</span>
                        {resolved?.resource?.name && <span className="text-[#657794]"> · {resolved.resource.name}</span>}
                        <span className="block text-[10px] text-[#94A3B8]">
                          {resolved?.kind === 'model_field' || b.source.kind === 'model_field' ? 'Data Model field' : 'Signal'}
                          {resolved?.value_type ? ` · ${resolved.value_type}` : ''}
                          {resolved?.unit ? ` · ${resolved.unit}` : ''}
                        </span>
                      </span>
                      {resolved?.capabilities && <CapabilityChip item={{ capabilities: resolved.capabilities }} />}
                    </div>
                    {!resolved && <p className="text-[#94A3B8]">Resolving…</p>}
                    {resolved && !resolved.ok && (
                      <p className="text-red-700">
                        {resolved.error?.message || 'This source cannot be used.'} {resolved.error?.code ? <span className="text-red-700/70">({resolved.error.code})</span> : null}
                      </p>
                    )}
                    {kindBad && <p className="text-red-700">This widget accepts {def.data.value_kinds.join(', ')} values; this source gives {resolvedKind} values. Publishing is blocked until you replace it.</p>}
                    {kindUnknown && <p className="text-amber-800">The value kind of this source is not known yet; check that it shows what you expect.</p>}
                    {resolved?.capabilities?.notes?.length ? <p className="text-[#657794]">{resolved.capabilities.notes.join(' ')}</p> : null}
                  </div>
                  {roles?.length ? (
                    <div>
                      <label className="block text-[11px] font-semibold text-[#334568] mb-0.5" htmlFor={`${b.id}-role`}>
                        Role
                      </label>
                      <select id={`${b.id}-role`} className={inputCls} value={b.role || ''} onChange={(e) => set(i, { role: e.target.value || undefined })}>
                        <option value="">Choose a role</option>
                        {roles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                            {r.required ? ' (required)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="col-span-2">
                      <label className="block text-[11px] font-semibold text-[#334568] mb-0.5" htmlFor={`${b.id}-label`}>
                        Label
                      </label>
                      <input id={`${b.id}-label`} className={inputCls} value={b.label ?? ''} maxLength={120} placeholder={resolved?.label || 'Source label'} onChange={(e) => set(i, { label: e.target.value || null }, `${b.id}-label`)} />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-[#334568] mb-0.5" htmlFor={`${b.id}-unit`}>
                        Unit
                      </label>
                      <input id={`${b.id}-unit`} className={inputCls} value={b.unit ?? ''} maxLength={24} placeholder={resolved?.unit || 'none'} onChange={(e) => set(i, { unit: e.target.value || null }, `${b.id}-unit`)} />
                    </div>
                    <div />
                    <NumberInput id={`${b.id}-scale`} label="Scale" value={b.scale} onChange={(v) => set(i, { scale: v }, `${b.id}-scale`)} />
                    <NumberInput id={`${b.id}-offset`} label="Offset" value={b.offset} onChange={(v) => set(i, { offset: v }, `${b.id}-offset`)} />
                    <p className="col-span-2 text-[10px] text-[#94A3B8]">Displayed value = value × scale + offset (numbers only).</p>
                  </div>
                  <div>
                    <span className="block text-[11px] font-semibold text-[#334568] mb-0.5">Color</span>
                    <ColorEditor value={b.color} onChange={(c) => set(i, { color: c })} nullable nullLabel="Auto" ctx={{ theme }} />
                  </div>
                  <VariableBinding binding={b} item={item} variables={variables} catalog={catalog} resolvedSignalId={resolved?.ok ? resolved.signal_id || (resolved.kind === 'signal' ? resolved.token : undefined) : undefined} onSource={(source) => set(i, { source })} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

function sourceText(s: SourceRef, item: SourceItem | undefined): string {
  if (item) return item.kind === 'model_field' ? `${item.model_name} · ${item.field_path}` : item.key || item.label;
  switch (s.kind) {
    case 'signal':
      return 'Signal';
    case 'model_field':
      return s.field_path;
    case 'signal_key':
      return s.key;
    case 'role':
      return `Role ${s.role}`;
  }
}

const NumberInput: React.FC<{ id: string; label: string; value: number; onChange: (v: number) => void }> = ({ id, label, value, onChange }) => {
  const [text, setText] = useState(String(value));
  React.useEffect(() => setText(String(value)), [value]);
  return (
    <div>
      <label className="block text-[11px] font-semibold text-[#334568] mb-0.5" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        step="any"
        className={inputCls}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setText(String(value))}
      />
    </div>
  );
};

/**
 * Signal → `signal_key` (the ACTIVE signal with that key on the resource the variable selects) and back.
 * Only variables whose selectable resources really have a signal with this key are offered.
 */
const VariableBinding: React.FC<{
  binding: Binding;
  item: SourceItem | undefined;
  variables: DashboardVariable[];
  catalog: CatalogState;
  resolvedSignalId?: string;
  onSource: (s: SourceRef) => void;
}> = ({ binding, item, variables, catalog, resolvedSignalId, onSource }) => {
  const resources = catalog.catalog?.resources || [];
  // key → resource ids that own an active signal with that key
  const keysByResource = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const it of catalog.catalog?.items || []) {
      if (it.kind !== 'signal' || !it.key || !it.resource_id) continue;
      const set = m.get(it.key) || new Set<string>();
      set.add(it.resource_id);
      m.set(it.key, set);
    }
    return m;
  }, [catalog.catalog]);
  const selectable = (v: DashboardVariable) => resources.filter((r) => !v.resource_type || r.type_key === v.resource_type);
  const coverage = (v: DashboardVariable, key: string) => {
    const owners = keysByResource.get(key) || new Set<string>();
    const sel = selectable(v);
    return { have: sel.filter((r) => owners.has(r.id)).length, total: sel.length };
  };

  if (binding.source.kind === 'model_field' || binding.source.kind === 'role') return null;

  if (binding.source.kind === 'signal_key') {
    const src = binding.source;
    const v = variables.find((x) => x.id === src.variable);
    const keys = v
      ? Array.from(keysByResource.entries())
          .filter(([, owners]) => selectable(v).some((r) => owners.has(r.id)))
          .map(([k]) => k)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      : [];
    const cov = v ? coverage(v, src.key) : null;
    return (
      <div className="rounded-md border border-[#D2E3FA] bg-[#F7FAFF] p-2 space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#0B2545]">
          <Variable className="w-3.5 h-3.5" aria-hidden="true" /> Bound to a variable
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <select aria-label="Variable" className={inputCls} value={src.variable} onChange={(e) => onSource({ ...src, variable: e.target.value })}>
            {!v && <option value={src.variable}>Unknown variable “{src.variable}”</option>}
            {variables.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label || x.id}
              </option>
            ))}
          </select>
          <select aria-label="Signal key" className={inputCls} value={src.key} onChange={(e) => onSource({ ...src, key: e.target.value })}>
            {!keys.includes(src.key) && <option value={src.key}>{src.key} (not found)</option>}
            {keys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        {cov && (
          <p className={`text-[10px] ${cov.have < cov.total ? 'text-amber-800' : 'text-[#657794]'}`}>
            Key “{src.key}” exists on {cov.have} of {cov.total} selectable resource{cov.total === 1 ? '' : 's'}
            {cov.have < cov.total ? '; other selections show an error for this source.' : '.'}
          </p>
        )}
        {resolvedSignalId && (
          <button type="button" onClick={() => onSource({ kind: 'signal', signal_id: resolvedSignalId })} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#334568] hover:text-[#111B37]">
            <Unlink className="w-3 h-3" aria-hidden="true" /> Use the current signal directly
          </button>
        )}
      </div>
    );
  }

  // Plain signal: offer variables whose selectable resources have this key.
  const key = item?.key;
  if (!key) return null;
  const candidates = variables.map((v) => ({ v, cov: coverage(v, key) })).filter((c) => c.cov.have > 0);
  if (!variables.length) {
    return <p className="text-[10px] text-[#94A3B8]">Add a variable in the Variables panel to let viewers switch this source between resources.</p>;
  }
  if (!candidates.length) {
    return <p className="text-[10px] text-[#94A3B8]">No variable selects a resource with a signal “{key}”.</p>;
  }
  return (
    <div className="rounded-md border border-[#E3EAF3] p-2 space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#334568]">
        <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> Bind to variable
      </div>
      <p className="text-[10px] text-[#657794]">Follow the resource chosen in a variable, using the signal with key “{key}” on it.</p>
      <div className="flex flex-wrap gap-1">
        {candidates.map(({ v, cov }) => (
          <button
            key={v.id}
            type="button"
            onClick={() => onSource({ kind: 'signal_key', variable: v.id, key })}
            className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-[#D4DFEC] bg-white text-[11px] font-semibold text-[#334568] hover:bg-[#F1F5FA]"
            title={`Key “${key}” exists on ${cov.have} of ${cov.total} selectable resources`}
          >
            <Variable className="w-3 h-3" aria-hidden="true" /> {v.label || v.id}
            <span className="font-normal text-[#94A3B8]">
              {cov.have}/{cov.total}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
