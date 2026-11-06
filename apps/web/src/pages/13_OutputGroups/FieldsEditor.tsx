import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ClipboardPaste, Copy, GripVertical, ListPlus, Plus, Trash2 } from 'lucide-react';
import type { ResourceNode } from '../../types';
import { Button } from '../../components/common/Button';
import {
  CONTEXT_REFS,
  ConstantType,
  LatestValue,
  MEMBER_KIND_LABEL,
  MemberKind,
  MemberRow,
  ModelKind,
  ResourceSignal,
  SYSTEM_FIELDS,
  blankRow,
  newUid,
} from './types';
import { ALIAS_RE, resolveContextRef, standardHeaderRows } from './modelLogic';
import { SignalPicker } from './SignalPicker';
import { Toggle } from './ui';

interface Props {
  rows: MemberRow[];
  onChange: (rows: MemberRow[]) => void;
  modelKind: ModelKind;
  resourceId: string;
  resources: ResourceNode[];
  signals: ResourceSignal[];
  latest: Map<string, LatestValue>;
  signalsLoading: boolean;
  rowErrors: Record<string, string[]>;
  rowWarnings: Record<string, string[]>;
  showErrors: boolean;
  onPasteJson: () => void;
}

const contextLabel = (ref: string) => {
  const [level, attr] = ref.split('.');
  const lvl = level === 'self' ? 'This resource' : level.charAt(0).toUpperCase() + level.slice(1);
  return `${lvl} ${attr}`;
};

const ALIAS_TO_CONTEXT: Record<string, string> = {
  zone_name: 'zone.name',
  line_name: 'line.name',
  machine_name: 'machine.name',
  area_name: 'area.name',
  site_name: 'site.name',
  enterprise_name: 'enterprise.name',
};

const inputCls = 'w-full h-8 px-2.5 border rounded text-[12px] bg-white focus:outline-none focus:border-blue-500';
const kindOrder: MemberKind[] = ['signal', 'context', 'constant', 'system', 'snapshot'];

export const FieldsEditor: React.FC<Props> = ({
  rows,
  onChange,
  modelKind,
  resourceId,
  resources,
  signals,
  latest,
  signalsLoading,
  rowErrors,
  rowWarnings,
  showErrors,
  onPasteJson,
}) => {
  const [armed, setArmed] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ uid: string; after: boolean } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const isEvent = modelKind === 'EVENT';

  useEffect(() => {
    if (!addOpen) return;
    const h = (e: MouseEvent) => addRef.current && !addRef.current.contains(e.target as Node) && setAddOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [addOpen]);

  const update = (uid: string, patch: Partial<MemberRow>) => onChange(rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));

  const changeKind = (row: MemberRow, kind: MemberKind) => {
    const patch: Partial<MemberRow> = { kind, contributesTs: kind === 'signal', isTrigger: kind === 'signal' ? row.isTrigger : false };
    const alias = row.alias.trim().toLowerCase();
    if (kind === 'system') patch.field = alias === 'publish_timestamp' ? 'publish_timestamp' : 'source_timestamp';
    if (kind === 'context') patch.contextRef = row.contextRef || ALIAS_TO_CONTEXT[alias] || 'self.name';
    update(row.uid, patch);
  };

  const move = (uid: string, delta: number) => {
    const i = rows.findIndex((r) => r.uid === uid);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= rows.length) return;
    const next = [...rows];
    const [it] = next.splice(i, 1);
    next.splice(j, 0, it);
    onChange(next);
  };

  const dropOn = (targetUid: string, after: boolean) => {
    if (!dragging || dragging === targetUid) return;
    const next = rows.filter((r) => r.uid !== dragging);
    const moving = rows.find((r) => r.uid === dragging);
    if (!moving) return;
    let idx = next.findIndex((r) => r.uid === targetUid);
    if (after) idx += 1;
    next.splice(idx, 0, moving);
    onChange(next);
  };

  const addRow = (kind: MemberKind) => {
    setAddOpen(false);
    const r = blankRow(kind);
    if (kind === 'system') {
      const hasSource = rows.some((x) => x.kind === 'system' && x.field === 'source_timestamp');
      r.field = hasSource ? 'publish_timestamp' : 'source_timestamp';
      r.alias = r.field;
    }
    onChange([...rows, r]);
  };

  const addHeader = () => {
    const have = new Set(rows.map((r) => r.alias.trim().toLowerCase()));
    const machineLike = resolveContextRef(resources, resourceId, 'machine.name') !== null;
    const header = standardHeaderRows(machineLike).filter((r) => !have.has(r.alias.toLowerCase()));
    onChange([...header, ...rows]);
  };

  const gridCols = isEvent
    ? 'grid-cols-[20px_22px_minmax(110px,1fr)_130px_minmax(200px,2.2fr)_56px_56px_52px]'
    : 'grid-cols-[20px_22px_minmax(110px,1fr)_130px_minmax(200px,2.2fr)_56px_52px]';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-bold text-[#111B37]">Body fields</h3>
          <p className="text-[12px] text-[#657794]">
            Keys are emitted in this order. Drag the handle (or focus it and use ↑ ↓) to reorder.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onPasteJson} icon={<ClipboardPaste className="w-3.5 h-3.5" />}>
            Paste sample JSON
          </Button>
          <Button size="sm" variant="outline" onClick={addHeader} icon={<ListPlus className="w-3.5 h-3.5" />} title="Insert context names and the two timestamps at the top">
            Add standard header
          </Button>
          <div className="relative" ref={addRef}>
            <Button size="sm" variant="outline" onClick={() => setAddOpen((o) => !o)} icon={<Plus className="w-3.5 h-3.5" />}>
              Add field <ChevronDown className="w-3 h-3" />
            </Button>
            {addOpen && (
              <div className="absolute right-0 z-30 mt-1 w-56 bg-white border border-slate-300 rounded-lg shadow-xl py-1">
                {kindOrder
                  .filter((k) => k !== 'snapshot' || isEvent)
                  .map((k) => (
                    <button key={k} type="button" onClick={() => addRow(k)} className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-slate-50">
                      <span className="font-semibold text-[#111B37]">{MEMBER_KIND_LABEL[k]}</span>
                      <span className="block text-[11px] text-[#657794]">{KIND_HELP[k]}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border border-slate-200 rounded-lg">
        <div className={`grid ${gridCols} gap-2 items-center px-2 py-2 bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-[#657794] rounded-t-lg`}>
          <span />
          <span>#</span>
          <span>Key (alias)</span>
          <span>Kind</span>
          <span>Source</span>
          <span className="text-center" title="Contributes to source_timestamp">Src ts</span>
          {isEvent && <span className="text-center">Trigger</span>}
          <span />
        </div>
        {rows.length === 0 && (
          <div className="px-4 py-8 text-center text-[12px] text-[#657794]">
            No fields yet. Paste a sample body, add the standard header, or add fields one by one.
          </div>
        )}
        {rows.map((row, idx) => {
          const errs = showErrors ? rowErrors[row.uid] || [] : [];
          const warns = rowWarnings[row.uid] || [];
          const isOver = over?.uid === row.uid && dragging && dragging !== row.uid;
          return (
            <div
              key={row.uid}
              draggable={armed === row.uid}
              onDragStart={(e) => {
                setDragging(row.uid);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', row.uid);
              }}
              onDragEnd={() => {
                setDragging(null);
                setArmed(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                setOver({ uid: row.uid, after: e.clientY > rect.top + rect.height / 2 });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (over) dropOn(over.uid, over.after);
                setOver(null);
              }}
              className={`border-b border-slate-100 last:border-b-0 ${dragging === row.uid ? 'opacity-40' : ''} ${
                isOver ? (over?.after ? 'shadow-[inset_0_-2px_0_#2A82E7]' : 'shadow-[inset_0_2px_0_#2A82E7]') : ''
              } ${errs.length ? 'bg-red-50/30' : ''}`}
            >
              <div className={`grid ${gridCols} gap-2 items-center px-2 py-1.5`}>
                <button
                  type="button"
                  aria-label={`Reorder field ${row.alias || idx + 1}`}
                  onMouseDown={() => setArmed(row.uid)}
                  onMouseUp={() => !dragging && setArmed(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      move(row.uid, -1);
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      move(row.uid, 1);
                    }
                  }}
                  className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded"
                >
                  <GripVertical className="w-4 h-4" />
                </button>
                <span className="text-[11px] text-slate-400 font-mono">{idx + 1}</span>
                <input
                  value={row.alias}
                  onChange={(e) => update(row.uid, { alias: e.target.value })}
                  placeholder="e.g. status"
                  spellCheck={false}
                  aria-label="Alias"
                  className={`${inputCls} font-mono ${
                    showErrors && errs.some((m) => /alias/i.test(m)) ? 'border-red-400' : 'border-slate-300'
                  }`}
                />
                <select
                  value={row.kind}
                  onChange={(e) => changeKind(row, e.target.value as MemberKind)}
                  aria-label="Field kind"
                  className={`${inputCls} border-slate-300`}
                >
                  {kindOrder
                    .filter((k) => k !== 'snapshot' || isEvent || row.kind === 'snapshot')
                    .map((k) => (
                      <option key={k} value={k}>
                        {MEMBER_KIND_LABEL[k]}
                      </option>
                    ))}
                </select>
                <SourceCell
                  row={row}
                  update={(p) => update(row.uid, p)}
                  resourceId={resourceId}
                  resources={resources}
                  signals={signals}
                  latest={latest}
                  signalsLoading={signalsLoading}
                  invalid={errs.length > 0}
                />
                <div className="flex justify-center">
                  {row.kind === 'signal' ? (
                    <Toggle
                      checked={row.contributesTs}
                      onChange={(v) => update(row.uid, { contributesTs: v })}
                      label="Contributes to source_timestamp"
                    />
                  ) : (
                    <span className="text-[10px] text-slate-300" title="Only signal fields contribute to source_timestamp">
                      —
                    </span>
                  )}
                </div>
                {isEvent && (
                  <div className="flex justify-center">
                    {row.kind === 'signal' ? (
                      <Toggle
                        checked={row.isTrigger}
                        onChange={(v) => update(row.uid, { isTrigger: v })}
                        label="Trigger: a new source time on this signal emits an event"
                      />
                    ) : (
                      <span className="text-[10px] text-slate-300">—</span>
                    )}
                  </div>
                )}
                <div className="flex items-center justify-end gap-0.5">
                  <button
                    type="button"
                    aria-label="Duplicate field"
                    title="Duplicate field"
                    onClick={() => {
                      const copy = { ...row, uid: newUid(), alias: ALIAS_RE.test(`${row.alias}_copy`) ? `${row.alias}_copy` : row.alias };
                      const next = [...rows];
                      next.splice(idx + 1, 0, copy);
                      onChange(next);
                    }}
                    className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove field"
                    title="Remove field"
                    onClick={() => onChange(rows.filter((r) => r.uid !== row.uid))}
                    className="p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {(errs.length > 0 || warns.length > 0) && (
                <div className="pl-[52px] pr-3 pb-1.5 space-y-0.5">
                  {errs.map((m) => (
                    <p key={m} className="text-[11px] text-red-700">
                      {m}
                    </p>
                  ))}
                  {warns.map((m) => (
                    <p key={m} className="text-[11px] text-amber-700">
                      {m}
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const KIND_HELP: Record<MemberKind, string> = {
  signal: 'Latest value of a signal on this resource',
  context: 'Name or code from the factory hierarchy',
  constant: 'A fixed value you type',
  system: 'source_timestamp or publish_timestamp',
  snapshot: 'Signal value captured when the event fires',
};

const SourceCell: React.FC<{
  row: MemberRow;
  update: (p: Partial<MemberRow>) => void;
  resourceId: string;
  resources: ResourceNode[];
  signals: ResourceSignal[];
  latest: Map<string, LatestValue>;
  signalsLoading: boolean;
  invalid: boolean;
}> = ({ row, update, resourceId, resources, signals, latest, signalsLoading, invalid }) => {
  if (row.kind === 'signal' || row.kind === 'snapshot') {
    return (
      <SignalPicker
        signals={signals}
        latest={latest}
        value={row.signalId}
        expectedKey={row.signalKey || row.alias}
        invalid={invalid && !row.signalId}
        loading={signalsLoading}
        onChange={(s) => update({ signalId: s.id, signalKey: s.key, alias: row.alias.trim() ? row.alias : ALIAS_RE.test(s.key) ? s.key : row.alias })}
      />
    );
  }
  if (row.kind === 'context') {
    const resolved = resourceId ? resolveContextRef(resources, resourceId, row.contextRef) : null;
    return (
      <div className="flex items-center gap-2 min-w-0">
        <select
          value={row.contextRef}
          onChange={(e) => update({ contextRef: e.target.value })}
          aria-label="Context reference"
          className={`${inputCls} border-slate-300 w-auto flex-shrink-0`}
        >
          {!CONTEXT_REFS.includes(row.contextRef) && <option value="">Choose…</option>}
          {CONTEXT_REFS.map((c) => (
            <option key={c} value={c}>
              {contextLabel(c)}
            </option>
          ))}
        </select>
        <span className={`text-[11px] font-mono truncate ${resolved === null ? 'text-amber-700' : 'text-[#334568]'}`} title={resolved ?? 'not found'}>
          {resolved === null ? 'not found' : `= ${JSON.stringify(resolved)}`}
        </span>
      </div>
    );
  }
  if (row.kind === 'constant') {
    return (
      <div className="flex items-center gap-2">
        <select
          value={row.constantType}
          onChange={(e) => {
            const t = e.target.value as ConstantType;
            update({ constantType: t, constantText: t === 'boolean' ? 'true' : t === 'null' ? '' : row.constantText });
          }}
          aria-label="Constant type"
          className={`${inputCls} border-slate-300 w-[92px] flex-shrink-0`}
        >
          <option value="string">Text</option>
          <option value="number">Number</option>
          <option value="boolean">Boolean</option>
          <option value="null">Null</option>
          <option value="json">JSON</option>
        </select>
        {row.constantType === 'boolean' ? (
          <select value={row.constantText} onChange={(e) => update({ constantText: e.target.value })} className={`${inputCls} border-slate-300`}>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : row.constantType === 'null' ? (
          <span className="text-[12px] font-mono text-slate-500">null</span>
        ) : (
          <input
            value={row.constantText}
            onChange={(e) => update({ constantText: e.target.value })}
            placeholder={row.constantType === 'number' ? '0' : row.constantType === 'json' ? '{"a": 1}' : 'Value'}
            spellCheck={false}
            aria-label="Constant value"
            className={`${inputCls} ${invalid ? 'border-red-400' : 'border-slate-300'} ${row.constantType !== 'string' ? 'font-mono' : ''}`}
          />
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <select
        value={row.field}
        onChange={(e) => update({ field: e.target.value as MemberRow['field'] })}
        aria-label="System field"
        className={`${inputCls} border-slate-300 w-auto`}
      >
        {SYSTEM_FIELDS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <span className="text-[11px] text-[#657794] truncate">
        {row.field === 'publish_timestamp' ? 'Platform clock at emission' : 'Latest source time of contributing signals'}
      </span>
    </div>
  );
};
