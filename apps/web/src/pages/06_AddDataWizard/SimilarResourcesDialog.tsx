import React, { useEffect, useId, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { ProtocolType, ResourceNode } from '../../types';
import { Button } from '../../components/common/Button';
import { ModalPortal } from '../../components/modals/ModalPortal';
import {
  ADDRESS_KEY_LABEL,
  AddressSettings,
  FieldRow,
  TargetRewrite,
  applyRewrite,
  buildAddress,
  defaultRewrite,
  describeAddress,
  parseOffsetList,
  parseOffsetMatrix,
  rewriteProblems,
  rewriteText,
  staleReferences,
  targetAddress,
} from './wizardModel';

interface SimilarResourcesDialogProps {
  isOpen: boolean;
  protocol: ProtocolType;
  source: ResourceNode;
  candidates: ResourceNode[];
  rows: FieldRow[];
  /** Address settings of the source machine (source time node / path, QoS…); rewritten per target. */
  settings: AddressSettings;
  sourceUnitId: number;
  /** Rewrites confirmed earlier (edited again when the dialog reopens). */
  initial: TargetRewrite[];
  onCancel: () => void;
  onConfirm: (rewrites: TargetRewrite[]) => void;
}

/**
 * "Apply to similar machines": the user picks target machines and reviews the generated addresses.
 * Text protocols rewrite the machine identifier (and the OPC namespace index); Modbus needs the target
 * unit ID and an offset per field. Nothing is confirmed while a target would reuse the source addresses.
 */
export const SimilarResourcesDialog: React.FC<SimilarResourcesDialogProps> = ({
  isOpen,
  protocol,
  source,
  candidates,
  rows,
  settings,
  sourceUnitId,
  initial,
  onCancel,
  onConfirm,
}) => {
  const titleId = useId();
  const [selected, setSelected] = useState<Record<string, TargetRewrite>>({});
  const [matrixText, setMatrixText] = useState('');
  const [matrixInfo, setMatrixInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const next: Record<string, TargetRewrite> = {};
    initial.forEach((rw) => {
      next[rw.resourceId] = rw;
    });
    setSelected(next);
    setMatrixText('');
    setMatrixInfo(null);
  }, [isOpen, initial]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onCancel]);

  const ordered = useMemo(() => candidates.filter((c) => selected[c.id]).map((c) => selected[c.id]), [candidates, selected]);
  const problems = useMemo(() => {
    const out: Record<string, string[]> = {};
    ordered.forEach((rw) => {
      out[rw.resourceId] = rewriteProblems(protocol, rows, rw, { settings, sourceCode: source.code });
    });
    return out;
  }, [ordered, protocol, rows, settings, source.code]);

  /** Source-time address shared by every field (OPC timestamp node or custom JSON timestamp path). */
  const sourceTime = useMemo((): { field: string; value: string; note?: string } | null => {
    if (!rows.length || protocol === 'modbus') return null;
    const address = buildAddress(rows[0], settings);
    const field = protocol === 'opcua' ? 'timestamp_node_id' : 'timestamp_path';
    const value = address[field];
    if (typeof value === 'string' && value) return { field, value };
    if (protocol === 'opcua') return { field, value: '', note: 'DataValue.SourceTimestamp of each node' };
    if (value === '') return { field, value: '', note: 'None (read time only)' };
    return { field, value: '', note: 'Sibling source_timestamp of each field' };
  }, [protocol, rows, settings]);
  const blocking = ordered.some((rw) => (problems[rw.resourceId] || []).length > 0);

  if (!isOpen) return null;

  const toggle = (res: ResourceNode) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[res.id]) delete next[res.id];
      else next[res.id] = defaultRewrite(protocol, source, { id: res.id, name: res.name || res.code, code: res.code }, rows, sourceUnitId);
      return next;
    });
  };

  const patch = (resourceId: string, change: Partial<TargetRewrite>) =>
    setSelected((prev) => ({ ...prev, [resourceId]: { ...prev[resourceId], ...change } }));

  const applyOffsetList = (resourceId: string, offsets: number[]) => {
    const map: Record<string, string> = {};
    rows.forEach((row, index) => {
      if (offsets[index] !== undefined) map[row.id] = String(offsets[index]);
    });
    patch(resourceId, { offsets: { ...selected[resourceId].offsets, ...map } });
  };

  const applyMatrix = () => {
    const parsed = parseOffsetMatrix(matrixText, ordered.map((rw) => rw.resourceCode));
    let applied = 0;
    ordered.forEach((rw) => {
      const offsets = parsed.get(rw.resourceCode);
      if (!offsets || !offsets.length) return;
      const map: Record<string, string> = {};
      rows.forEach((row, index) => {
        if (offsets[index] !== undefined) map[row.id] = String(offsets[index]);
      });
      setSelected((prev) => ({ ...prev, [rw.resourceId]: { ...prev[rw.resourceId], offsets: { ...prev[rw.resourceId].offsets, ...map } } }));
      applied += 1;
    });
    setMatrixInfo(applied ? `Offsets filled for ${applied} machine(s). Review them below.` : 'No line starts with the code of a selected machine.');
  };

  const textInput = 'px-2 py-1 border border-slate-300 rounded text-[11px] font-mono';

  return (
    <ModalPortal>
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-5xl max-h-[90vh] bg-white border border-slate-300 shadow-xl rounded-xl flex flex-col overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex items-start justify-between gap-3">
          <div>
            <h3 id={titleId} className="text-[14px] font-bold text-[#111B37]">Apply to similar machines</h3>
            <p className="text-[12px] text-[#657794] mt-0.5">
              Create the same {rows.length} signal(s) on other machines. Every target needs its own source addresses: review the generated table before confirming.
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onCancel} className="p-1 text-slate-400 hover:text-slate-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-[12px]">
          <fieldset>
            <legend className="text-[11px] font-bold uppercase text-[#657794] mb-1.5">Target machines</legend>
            {candidates.length === 0 ? (
              <p className="text-[#657794]">No other {source.type} exists in this site.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {candidates.map((res) => (
                  <label key={res.id} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border cursor-pointer ${selected[res.id] ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}>
                    <input type="checkbox" checked={Boolean(selected[res.id])} onChange={() => toggle(res)} />
                    <span className="font-semibold">{res.name || res.code}</span>
                    <span className="font-mono text-[10px] text-[#657794]">{res.code}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          {ordered.length > 0 && protocol !== 'modbus' && (
            <div className="space-y-3">
              <p className="text-[11px] text-[#657794]">
                Every address of <span className="font-mono">{source.code}</span>, including the source time {protocol === 'opcua' ? 'node' : 'path'}, is
                rewritten by replacing the text below{protocol === 'opcua' ? ' and the namespace index (ns=…)' : ''}. Adjust when the source uses another
                identifier for the machine. Addresses that would still point at {source.code} are marked red and block the confirmation.
              </p>
              {ordered.map((rw) => (
                <div key={rw.resourceId} className="border border-slate-200 rounded-lg">
                  <div className="p-2 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-2">
                    <span className="font-bold text-[#111B37] min-w-[120px]">{rw.resourceName}</span>
                    <label className="flex items-center gap-1">
                      Replace
                      <input aria-label="Text to replace" value={rw.find} onChange={(e) => patch(rw.resourceId, { find: e.target.value })} className={`${textInput} w-32`} />
                    </label>
                    <label className="flex items-center gap-1">
                      with
                      <input aria-label="Replacement" value={rw.replace} onChange={(e) => patch(rw.resourceId, { replace: e.target.value })} className={`${textInput} w-32`} />
                    </label>
                    {protocol === 'opcua' && (
                      <label className="flex items-center gap-1">
                        ns
                        <input aria-label="Source namespace index" value={rw.nsFrom} onChange={(e) => patch(rw.resourceId, { nsFrom: e.target.value.replace(/\D/g, '') })} className={`${textInput} w-12`} />
                        →
                        <input aria-label="Target namespace index" value={rw.nsTo} onChange={(e) => patch(rw.resourceId, { nsTo: e.target.value.replace(/\D/g, '') })} className={`${textInput} w-12`} />
                      </label>
                    )}
                    {(problems[rw.resourceId] || []).length === 0 ? (
                      <span className="ml-auto flex items-center gap-1 text-emerald-700 text-[11px]"><CheckCircle2 className="w-3.5 h-3.5" /> Ready</span>
                    ) : (
                      <span className="ml-auto flex items-start gap-1 text-red-700 text-[11px] max-w-[60%]" role="alert">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                        <span className="break-all">
                          {problems[rw.resourceId][0]}
                          {problems[rw.resourceId].length > 1 ? ` (+${problems[rw.resourceId].length - 1} more)` : ''}
                        </span>
                      </span>
                    )}
                  </div>
                  <div className="max-h-56 overflow-y-auto">
                    <table className="w-full text-[11px] font-mono">
                      <thead className="bg-white sticky top-0 text-[10px] font-sans font-semibold uppercase text-[#657794]">
                        <tr className="border-b border-slate-200">
                          <th className="px-2 py-1 text-left w-36">Field</th>
                          <th className="px-2 py-1 text-left">{source.name || source.code}</th>
                          <th className="px-2 py-1 text-left">{rw.resourceName}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {sourceTime && <SourceTimeRow protocol={protocol} sourceCode={source.code} sourceTime={sourceTime} rewrite={rw} />}
                        {rows.map((row) => {
                          const stale = staleReferences(protocol, source.code, targetAddress(row, settings, rw), rw).filter(
                            (ref) => ref.field !== 'timestamp_node_id' && ref.field !== 'timestamp_path',
                          );
                          return (
                            <tr key={row.id}>
                              <td className="px-2 py-1 font-semibold text-[#111B37]">{row.key}</td>
                              <td className="px-2 py-1 text-slate-500 break-all">{describeAddress(row, protocol)}</td>
                              <td
                                className={`px-2 py-1 break-all ${stale.length ? 'text-red-700 bg-red-50 font-semibold' : 'text-[#111B37]'}`}
                                title={stale.length ? stale.map((ref) => `${ADDRESS_KEY_LABEL[ref.field] || ref.field} ${ref.reason}`).join('; ') : undefined}
                              >
                                {describeAddress(applyRewrite(protocol, row, rw), protocol)}
                                {stale.length > 0 && <StaleMark />}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          {ordered.length > 0 && protocol === 'modbus' && (
            <div className="space-y-3">
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-900">
                Modbus register maps differ per machine. Enter the unit ID and the start offset of every field for each target, or paste an offset table
                (one machine per line: machine code followed by the offsets in field order; ranges such as 714–721 use their start).
              </div>
              <div className="space-y-1.5">
                <textarea
                  aria-label="Offset table"
                  rows={3}
                  value={matrixText}
                  onChange={(e) => setMatrixText(e.target.value)}
                  placeholder={`${ordered[0].resourceCode} <offset of ${rows.map((r) => r.key).slice(0, 3).join('> <')}> …`}
                  className="w-full p-2 font-mono text-[11px] border border-slate-300 rounded"
                />
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={applyMatrix} disabled={!matrixText.trim()}>
                    Fill offsets from table
                  </Button>
                  {matrixInfo && <span className="text-[11px] text-[#657794]">{matrixInfo}</span>}
                </div>
              </div>
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="text-[11px] min-w-full">
                  <thead className="bg-slate-50 text-[#657794]">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Field</th>
                      <th className="px-2 py-1.5 text-left font-mono">{source.code}</th>
                      {ordered.map((rw) => (
                        <th key={rw.resourceId} className="px-2 py-1.5 text-left">
                          <div className="font-bold text-[#111B37]">{rw.resourceName}</div>
                          <label className="flex items-center gap-1 font-normal mt-1">
                            Unit
                            <input aria-label={`Unit ID for ${rw.resourceName}`} value={rw.unitId} onChange={(e) => patch(rw.resourceId, { unitId: e.target.value.replace(/\D/g, '') })} className={`${textInput} w-14`} />
                          </label>
                          <input
                            aria-label={`Paste offsets for ${rw.resourceName}`}
                            placeholder="paste offsets"
                            onPaste={(e) => {
                              e.preventDefault();
                              applyOffsetList(rw.resourceId, parseOffsetList(e.clipboardData.getData('text')));
                            }}
                            onChange={() => undefined}
                            value=""
                            className={`${textInput} w-28 mt-1`}
                          />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td className="px-2 py-1 font-mono font-semibold text-[#111B37]">
                          {row.key} <span className="font-normal text-[10px] text-[#657794]">{row.nativeType}</span>
                        </td>
                        <td className="px-2 py-1 font-mono text-slate-500">{row.offset}</td>
                        {ordered.map((rw) => (
                          <td key={rw.resourceId} className="px-2 py-1">
                            <input
                              aria-label={`Offset of ${row.key} on ${rw.resourceName}`}
                              value={rw.offsets[row.id] ?? ''}
                              onChange={(e) => patch(rw.resourceId, { offsets: { ...rw.offsets, [row.id]: e.target.value.replace(/\D/g, '') } })}
                              className={`${textInput} w-20 ${rw.offsets[row.id] ? '' : 'border-red-300 bg-red-50/40'}`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {ordered.map((rw) =>
                (problems[rw.resourceId] || []).length ? (
                  <p key={rw.resourceId} className="text-[11px] text-red-700">
                    {rw.resourceName}: {problems[rw.resourceId].join(' ')}
                  </p>
                ) : null,
              )}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-200 flex items-center justify-between gap-2">
          <span className="text-[11px] text-[#657794]">
            {ordered.length} machine(s) × {rows.length} field(s) = {ordered.length * rows.length} additional signal(s)
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={blocking}
              title={blocking ? 'Fix the problems marked red first.' : undefined}
              onClick={() => onConfirm(ordered)}
            >
              {ordered.length ? 'Confirm addresses' : 'Apply to no other machine'}
            </Button>
          </div>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
};

const StaleMark: React.FC = () => (
  <AlertTriangle role="img" aria-label="Still points at the source machine" className="inline w-3 h-3 ml-1 align-[-2px]" />
);

/** Confirmation-table row for the source time node / path shared by every field of the target. */
const SourceTimeRow: React.FC<{
  protocol: ProtocolType;
  sourceCode: string;
  sourceTime: { field: string; value: string; note?: string };
  rewrite: TargetRewrite;
}> = ({ protocol, sourceCode, sourceTime, rewrite }) => {
  const target = sourceTime.value ? rewriteText(sourceTime.value, protocol, rewrite) : '';
  const stale = sourceTime.value ? staleReferences(protocol, sourceCode, { [sourceTime.field]: target }, rewrite) : [];
  return (
    <tr className="bg-blue-50/40">
      <td className="px-2 py-1 font-sans font-semibold text-[#111B37]">Source time</td>
      <td className="px-2 py-1 text-slate-500 break-all">{sourceTime.value || <span className="font-sans italic">{sourceTime.note}</span>}</td>
      <td
        className={`px-2 py-1 break-all ${stale.length ? 'text-red-700 bg-red-50 font-semibold' : 'text-[#111B37]'}`}
        title={stale.length ? `${ADDRESS_KEY_LABEL[sourceTime.field]} ${stale[0].reason}` : undefined}
      >
        {sourceTime.value ? target : <span className="font-sans italic text-slate-500">{sourceTime.note}</span>}
        {stale.length > 0 && <StaleMark />}
      </td>
    </tr>
  );
};
