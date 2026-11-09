import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { ProtocolType, ResourceNode, SignalItem } from '../../types';
import { isEnterSubmit } from './enterSubmit';
import { Button } from '../../components/common/Button';
import { ModalPortal } from '../../components/modals/ModalPortal';
import { PROTOCOL_LABEL } from '../../lib/protocols';
import {
  ALL_TEXT_FIELDS,
  BulkPreviewRow,
  BulkRule,
  PLACEHOLDERS,
  bulkEditAddresses,
  commonFields,
  describeAddressError,
  fieldSpec,
  placeholderContext,
  previewRule,
  protocolOfSignal,
} from './signalAddress';

interface BulkAddressDialogProps {
  isOpen: boolean;
  signals: SignalItem[];
  resources: ResourceNode[];
  onClose: () => void;
  /** Called after a successful bulk update with the number of updated / unchanged signals. */
  onApplied: (updated: number, unchanged: number) => void;
}


function show(value: unknown): string {
  if (value === undefined || value === null) return '(default)';
  if (value === '') return '(none)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * "Edit source address…" for the selected signals: set one address field from a per-signal pattern
 * ({machine}, {ns}, …) or find/replace text in address fields. Every row is previewed; the change is
 * sent in one all-or-nothing request (POST /api/v1/signals/bulk-address).
 */
export const BulkAddressDialog: React.FC<BulkAddressDialogProps> = ({ isOpen, signals, resources, onClose, onApplied }) => {
  const titleId = useId();
  const protocols = useMemo(() => {
    const set = new Set<ProtocolType>();
    signals.forEach((s) => {
      const p = protocolOfSignal(s);
      if (p) set.add(p);
    });
    return Array.from(set);
  }, [signals]);
  const fields = useMemo(() => commonFields(protocols), [protocols]);
  const textualFields = fields.filter((spec) => spec.textual);

  const [mode, setMode] = useState<'set' | 'replace'>('set');
  const [field, setField] = useState('');
  const [pattern, setPattern] = useState('');
  const [remove, setRemove] = useState(false);
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isOpen) return;
    setMode('set');
    // Opening with OPC UA signals: the source time node is the usual bulk fix.
    const preferred = fields.find((spec) => spec.key === 'timestamp_node_id') || fields.find((spec) => spec.textual) || fields[0];
    setField(preferred?.key || '');
    setPattern('');
    setRemove(false);
    setFind('');
    setReplace('');
    setError(null);
    setItemErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !applying) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, applying, onClose]);

  const resourceById = useMemo(() => new Map(resources.map((r) => [r.id, r])), [resources]);
  const selectedSpec = protocols.length ? fieldSpec(protocols[0], field) : undefined;

  const rule: BulkRule | null = useMemo(() => {
    if (mode === 'set') return field && (remove || pattern !== '') ? { mode: 'set', field, pattern, remove } : null;
    return field && find ? { mode: 'replace', field, find, replace } : null;
  }, [mode, field, pattern, remove, find, replace]);

  const preview = useMemo(() => {
    if (!rule) return [] as BulkPreviewRow[];
    return signals.flatMap((signal) => {
      const res = resourceById.get(signal.resourceId);
      const ctx = placeholderContext(signal, res?.code || '', res?.name || '');
      return previewRule(signal, protocolOfSignal(signal), rule, ctx);
    });
  }, [rule, signals, resourceById]);

  const bySignal = useMemo(() => {
    const map = new Map<string, BulkPreviewRow[]>();
    preview.forEach((row) => {
      const list = map.get(row.signal.id) || [];
      list.push(row);
      map.set(row.signal.id, list);
    });
    return map;
  }, [preview]);
  const changed = Array.from(bySignal.values()).filter((rows) => Object.keys(rows[0].patch).length > 0);
  const invalid = Array.from(bySignal.values()).filter((rows) => rows.some((row) => row.error));
  const unchangedCount = bySignal.size - changed.length - invalid.length;

  // In-flight guard (R3-DM-04 / R5-SG-03): declared unconditionally before the early return so hook
  // order never changes when `isOpen` toggles from false to true.
  const applyingRef = useRef(false);

  if (!isOpen) return null;

  const insertToken = (token: string) => {
    if (mode === 'set') setPattern((prev) => prev + token);
    else setReplace((prev) => prev + token);
  };

  const handleApply = async () => {
    if (applyingRef.current || !changed.length || invalid.length) return;
    applyingRef.current = true;
    setApplying(true);
    setError(null);
    setItemErrors({});
    try {
      const result = await bulkEditAddresses(
        changed.map((rows) => ({ signal_id: rows[0].signal.id, version: rows[0].signal.version ?? 1, address_patch: rows[0].patch })),
      );
      onApplied(result.updated?.length ?? result.count ?? changed.length, (result.unchanged?.length ?? 0) + unchangedCount);
      onClose();
    } catch (err) {
      const described = describeAddressError(err);
      setItemErrors(described.items);
      setError(described.message);
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  };

  const labelCls = 'block text-[11px] font-semibold text-[#657794] uppercase mb-1';
  const inputCls = 'w-full px-2.5 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:border-blue-500';
  const isTextual = Boolean(selectedSpec?.textual) && selectedSpec?.kind !== 'timestamp_path';

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
        onKeyDown={(event) => {
          // Enter in a field applies (guarded; disabled conditions are checked inside handleApply).
          if (!isEnterSubmit(event)) return;
          event.preventDefault();
          void handleApply();
        }}
      >
        <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-5xl max-h-[90vh] bg-white border border-slate-300 shadow-xl rounded-xl flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex items-start justify-between gap-3">
            <div>
              <h3 id={titleId} className="text-[14px] font-bold text-[#111B37]">
                Edit source address of {signals.length} signal{signals.length === 1 ? '' : 's'}
              </h3>
              <p className="text-[12px] text-[#657794] mt-0.5">
                {protocols.length ? protocols.map((p) => PROTOCOL_LABEL[p]).join(', ') : 'No bound signal selected'} · every row is previewed; nothing is changed
                unless all rows are valid.
              </p>
            </div>
            <button type="button" aria-label="Close" onClick={onClose} disabled={applying} className="p-1 text-slate-400 hover:text-slate-700">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 text-[12px]">
            {!fields.length ? (
              <p className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
                The selected signals have no source address that can be edited together. Select bound signals (of one protocol for protocol-specific fields).
              </p>
            ) : (
              <>
                <div role="radiogroup" aria-label="Change" className="flex flex-wrap gap-2">
                  {(
                    [
                      ['set', 'Set a field'],
                      ['replace', 'Find and replace'],
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border cursor-pointer ${mode === value ? 'border-blue-500 bg-blue-50 font-semibold' : 'border-slate-200'}`}>
                      <input
                        type="radio"
                        name={`${titleId}-mode`}
                        checked={mode === value}
                        onChange={() => {
                          setMode(value);
                          if (value === 'replace' && !textualFields.some((spec) => spec.key === field)) setField(ALL_TEXT_FIELDS);
                          if (value === 'set' && field === ALL_TEXT_FIELDS) setField(textualFields[0]?.key || fields[0]?.key || '');
                        }}
                      />
                      {label}
                    </label>
                  ))}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3 items-start">
                  <div>
                    <label htmlFor={`${titleId}-field`} className={labelCls}>
                      Field
                    </label>
                    <select id={`${titleId}-field`} value={field} onChange={(e) => { setField(e.target.value); setPattern(''); setRemove(false); }} className={`${inputCls} bg-white`}>
                      {mode === 'replace' && textualFields.length > 1 && <option value={ALL_TEXT_FIELDS}>All address text fields</option>}
                      {(mode === 'replace' ? textualFields : fields).map((spec) => (
                        <option key={spec.key} value={spec.key}>
                          {spec.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {mode === 'set' ? (
                    <div className="space-y-1.5">
                      <label htmlFor={`${titleId}-pattern`} className={labelCls}>
                        New value
                      </label>
                      {selectedSpec?.kind === 'select' ? (
                        <select id={`${titleId}-pattern`} value={pattern} onChange={(e) => setPattern(e.target.value)} disabled={remove} className={`${inputCls} bg-white`}>
                          <option value="">Choose…</option>
                          {selectedSpec.options?.filter((o) => o.value !== '').map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : selectedSpec?.kind === 'bool' ? (
                        <select id={`${titleId}-pattern`} value={pattern} onChange={(e) => setPattern(e.target.value)} className={`${inputCls} bg-white`}>
                          <option value="">Choose…</option>
                          <option value="true">Yes</option>
                          <option value="false">No</option>
                        </select>
                      ) : (
                        <input
                          id={`${titleId}-pattern`}
                          value={pattern}
                          disabled={remove}
                          onChange={(e) => setPattern(e.target.value)}
                          placeholder={
                            field === 'timestamp_node_id'
                              ? 'ns={ns};s=Devices.{machine}.Group.source_timestamp'
                              : field === 'timestamp_path'
                                ? '$.meta.source_timestamp'
                                : selectedSpec?.placeholder
                          }
                          className={`${inputCls} font-mono disabled:bg-slate-100`}
                        />
                      )}
                      {selectedSpec?.removable && (
                        <label className="flex items-center gap-1.5 text-[11px] text-[#334568]">
                          <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
                          Remove the field (back to the default
                          {field === 'timestamp_path' ? ': sibling source_timestamp' : field === 'timestamp_node_id' ? ': DataValue.SourceTimestamp' : ''})
                        </label>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label htmlFor={`${titleId}-find`} className={labelCls}>
                          Find
                        </label>
                        <input id={`${titleId}-find`} value={find} onChange={(e) => setFind(e.target.value)} className={`${inputCls} font-mono`} />
                      </div>
                      <div>
                        <label htmlFor={`${titleId}-replace`} className={labelCls}>
                          Replace with
                        </label>
                        <input id={`${titleId}-replace`} value={replace} onChange={(e) => setReplace(e.target.value)} className={`${inputCls} font-mono`} placeholder="{machine}" />
                      </div>
                    </div>
                  )}
                </div>

                {(mode === 'replace' || (isTextual && !remove) || field === 'timestamp_path') && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#657794]">
                    <span>Per-signal values:</span>
                    {PLACEHOLDERS.map((p) => (
                      <button
                        key={p.token}
                        type="button"
                        title={p.description}
                        onClick={() => insertToken(p.token)}
                        className="px-1.5 py-0.5 rounded border border-slate-200 font-mono text-[#134074] hover:border-blue-400"
                      >
                        {p.token}
                      </button>
                    ))}
                  </div>
                )}

                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-3 text-[11px]">
                    <span className="font-bold text-[#111B37]">Preview</span>
                    <span className="text-emerald-700">{changed.length} to change</span>
                    <span className="text-[#657794]">{Math.max(unchangedCount, 0)} unchanged</span>
                    {invalid.length > 0 && <span className="text-red-700 font-semibold">{invalid.length} invalid</span>}
                  </div>
                  <div className="max-h-[42vh] overflow-auto">
                    <table className="w-full min-w-[640px] text-[11px]">
                      <thead className="bg-white sticky top-0 text-[10px] uppercase text-[#657794]">
                        <tr className="border-b border-slate-200">
                          <th className="px-2 py-1.5 text-left">Signal</th>
                          <th className="px-2 py-1.5 text-left">Resource</th>
                          <th className="px-2 py-1.5 text-left">Field</th>
                          <th className="px-2 py-1.5 text-left">Current</th>
                          <th className="px-2 py-1.5 text-left">New</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-mono">
                        {!rule && (
                          <tr>
                            <td colSpan={5} className="px-2 py-4 text-center font-sans text-[#657794]">
                              {mode === 'set' ? 'Enter the new value to preview it on every signal.' : 'Enter the text to find.'}
                            </td>
                          </tr>
                        )}
                        {preview.map((row, index) => {
                          const res = resourceById.get(row.signal.resourceId);
                          const serverError = itemErrors[row.signal.id];
                          const problem = row.error || serverError;
                          return (
                            <tr key={`${row.signal.id}-${row.field}-${index}`} className={problem ? 'bg-red-50' : ''}>
                              <td className="px-2 py-1 font-semibold text-[#111B37]">{row.signal.key}</td>
                              <td className="px-2 py-1 font-sans text-[#657794] max-w-[160px] truncate" title={res?.name}>
                                {res?.name || '—'}
                              </td>
                              <td className="px-2 py-1 font-sans">{fieldSpec(row.protocol || 'mqtt', row.field)?.label || row.field}</td>
                              <td className="px-2 py-1 text-slate-500 break-all">{row.before === undefined && row.unchanged ? '—' : show(row.before)}</td>
                              <td className={`px-2 py-1 break-all ${problem ? 'text-red-700' : row.unchanged ? 'text-slate-400' : 'text-[#111B37] font-semibold'}`}>
                                {problem ? (
                                  <span className="flex items-start gap-1 font-sans">
                                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                                    <span>
                                      {row.after !== undefined && <span className="font-mono block">{show(row.after)}</span>}
                                      {problem}
                                    </span>
                                  </span>
                                ) : row.unchanged ? (
                                  'unchanged'
                                ) : (
                                  show(row.after)
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
            {error && (
              <p role="alert" className="p-2.5 bg-red-50 border border-red-200 text-red-700 rounded">
                {error}
              </p>
            )}
          </div>

          <div className="p-4 border-t border-slate-200 flex items-center justify-between gap-2">
            <span className="text-[11px] text-[#657794] flex items-center gap-1">
              {changed.length > 0 && !invalid.length && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />}
              {invalid.length
                ? 'Fix or deselect the invalid rows first.'
                : changed.length
                  ? `The collector receives a new configuration for ${changed.length} signal(s).`
                  : 'Nothing to change yet.'}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={applying}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" disabled={applying || !changed.length || invalid.length > 0} onClick={() => void handleApply()}>
                {applying ? 'Applying…' : `Apply to ${changed.length} signal${changed.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
};
