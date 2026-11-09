// Middle pane of the body builder: the editable body tree table (Key | Type | Mapping / Rule | Value).
// Rows: inline key rename, type, mapping ↔ rule, move / drag, indent / outdent, duplicate, delete;
// multi-select bulk actions. Signals dragged from the data tree can be dropped on rows.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Braces,
  Brackets,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  FolderInput,
  FunctionSquare,
  GripVertical,
  IndentDecrease,
  IndentIncrease,
  Link2,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '../../../components/common/Button';
import { CatalogIndex, signalRef, signalTooltip } from '../rules';
import { FlatRow, flatten } from '../spec';
import { BodyNode, ContainerNode, FieldError, FieldNode, VALUE_TYPES, ValueType, isContainer } from '../types';
import { IconMenu } from '../ui';
import { RuleText } from './RuleEditor';
import { SIGNAL_DRAG_TYPE } from './DataTree';

const ROW_DRAG_TYPE = 'application/x-factorix-row';

export type DropPlace = 'before' | 'after' | 'into';

export interface RowActions {
  rename: (uid: string, key: string) => void;
  setType: (uid: string, type: ValueType) => void;
  convert: (uid: string) => void;
  toggleContainerType: (uid: string) => void;
  move: (uid: string, delta: number) => void;
  indent: (uid: string) => void;
  outdent: (uid: string) => void;
  duplicate: (uid: string) => void;
  remove: (uids: string[]) => void;
  wrap: (uids: string[]) => void;
  setTypeMany: (uids: string[], type: ValueType) => void;
  editRule: (uid: string) => void;
  dropRow: (uid: string, targetUid: string, place: DropPlace) => void;
  dropSignal: (signalId: string, targetUid: string | null, place: DropPlace) => void;
}

interface Props {
  root: ContainerNode;
  index: CatalogIndex | null;
  selected: string | null;
  onSelect: (uid: string | null) => void;
  checked: Set<string>;
  onChecked: (next: Set<string>) => void;
  collapsed: Set<string>;
  onCollapsed: (next: Set<string>) => void;
  errors: Map<string, FieldError[]>;
  values: Map<string, { text: string; error: string | null }>;
  actions: RowActions;
  onAdd: (kind: 'field' | 'rule' | 'object' | 'array') => void;
  onPaste: () => void;
  /** Uid of a row whose key input should get focus (after it was added). */
  focusKeyOf: string | null;
  onFocusKeyDone: () => void;
}

const typeLabel = (n: BodyNode) => (isContainer(n) ? n.type : n.valueType);

function mappingText(f: FieldNode, index: CatalogIndex | null): { text: string; tip: string; broken: boolean } {
  if (!f.signalId) return { text: '', tip: '', broken: false };
  const fromCatalog = index ? signalRef(index, f.signalId) : null;
  if (fromCatalog && !f.missing) return { text: fromCatalog, tip: index ? signalTooltip(index, f.signalId) : f.refTooltip, broken: false };
  if (f.refDisplay) return { text: f.refDisplay, tip: f.refTooltip || f.refDisplay, broken: f.missing || f.refDisplay.includes('⚠') };
  return { text: '$⚠missing[signal]', tip: 'The mapped signal no longer exists (deleted or archived). The field outputs null.', broken: true };
}

const KeyInput: React.FC<{ value: string; disabled: boolean; invalid: boolean; onCommit: (v: string) => void; autoFocus: boolean; onFocused: () => void; label: string }> = ({
  value,
  disabled,
  invalid,
  onCommit,
  autoFocus,
  onFocused,
  label,
}) => {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      ref.current.select();
      onFocused();
    }
  }, [autoFocus, onFocused]);
  if (disabled) return <span className="text-[11px] italic text-slate-400">item</span>;
  return (
    <input
      ref={ref}
      value={text}
      aria-label={label}
      aria-invalid={invalid}
      data-key-input
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          if (text !== value) onCommit(text);
          (e.target as HTMLInputElement).closest<HTMLElement>('[data-row]')?.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setText(value);
          (e.target as HTMLInputElement).closest<HTMLElement>('[data-row]')?.focus();
        }
      }}
      className={`min-w-0 flex-1 h-6 px-1 -ml-1 rounded font-mono text-[12px] text-[#111B37] bg-transparent border hover:border-[#D4DFEC] focus:bg-white focus:border-blue-500 focus:outline-none ${
        invalid ? 'border-red-300 bg-red-50/50' : 'border-transparent'
      }`}
    />
  );
};

export const BodyTable: React.FC<Props> = ({
  root,
  index,
  selected,
  onSelect,
  checked,
  onChecked,
  collapsed,
  onCollapsed,
  errors,
  values,
  actions,
  onAdd,
  onPaste,
  focusKeyOf,
  onFocusKeyDone,
}) => {
  const rows = useMemo(() => flatten(root, collapsed), [root, collapsed]);
  const [drop, setDrop] = useState<{ uid: string | null; place: DropPlace } | null>(null);
  const [bulkType, setBulkType] = useState<ValueType | ''>('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootErrors = errors.get(root.uid) || [];
  const checkedRows = rows.filter((r) => checked.has(r.node.uid));
  const allChecked = rows.length > 0 && checkedRows.length === rows.length;

  const focusRow = (uid: string) => {
    window.requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>(`[data-row="${uid}"]`)?.focus());
  };

  const toggleCheck = (uid: string) => {
    const next = new Set(checked);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    onChecked(next);
  };

  const onRowKey = (e: React.KeyboardEvent, row: FlatRow, i: number) => {
    const uid = row.node.uid;
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.altKey) {
        actions.move(uid, e.key === 'ArrowDown' ? 1 : -1);
        focusRow(uid);
        return;
      }
      const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) {
        onSelect(next.node.uid);
        focusRow(next.node.uid);
      }
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (e.altKey) {
        if (e.key === 'ArrowRight') actions.indent(uid);
        else actions.outdent(uid);
        focusRow(uid);
      } else if (isContainer(row.node)) {
        const next = new Set(collapsed);
        if (e.key === 'ArrowRight') next.delete(uid);
        else next.add(uid);
        onCollapsed(next);
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const target = checked.size ? Array.from(checked) : [uid];
      const nextFocus = rows[i + 1]?.node.uid || rows[i - 1]?.node.uid || null;
      actions.remove(target);
      onSelect(nextFocus);
      if (nextFocus) focusRow(nextFocus);
    } else if (e.key === 'F2') {
      e.preventDefault();
      (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('[data-key-input]')?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!isContainer(row.node) && row.node.mode === 'calculated') actions.editRule(uid);
      else (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('[data-key-input]')?.focus();
    } else if (e.key === ' ') {
      e.preventDefault();
      toggleCheck(uid);
    } else if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      actions.duplicate(uid);
    }
  };

  const placeFor = (e: React.DragEvent, row: FlatRow): DropPlace => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    if (isContainer(row.node) && y > 0.3 && y < 0.7) return 'into';
    return y < 0.5 ? 'before' : 'after';
  };

  const accepts = (e: React.DragEvent) => e.dataTransfer.types.includes(SIGNAL_DRAG_TYPE) || e.dataTransfer.types.includes(ROW_DRAG_TYPE);

  const onDropAt = (e: React.DragEvent, uid: string | null, place: DropPlace) => {
    e.preventDefault();
    setDrop(null);
    const sig = e.dataTransfer.getData(SIGNAL_DRAG_TYPE);
    const rowUid = e.dataTransfer.getData(ROW_DRAG_TYPE);
    if (sig) actions.dropSignal(sig, uid, place);
    else if (rowUid && uid && rowUid !== uid) actions.dropRow(rowUid, uid, place);
    else if (rowUid && !uid) actions.dropRow(rowUid, root.uid, 'into');
  };

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <h3 className="text-[13px] font-bold text-[#111B37] mr-auto">Body fields</h3>
        <Button size="sm" variant="outline" icon={<Link2 className="w-3.5 h-3.5" />} onClick={() => onAdd('field')} title="Add a mapping field (then pick a signal in the data tree)">
          Field
        </Button>
        <Button size="sm" variant="outline" icon={<FunctionSquare className="w-3.5 h-3.5" />} onClick={() => onAdd('rule')} title="Add a calculated field (Custom Rule)">
          Rule
        </Button>
        <Button size="sm" variant="outline" icon={<Braces className="w-3.5 h-3.5" />} onClick={() => onAdd('object')} title="Add a nested object">
          Object
        </Button>
        <Button size="sm" variant="outline" icon={<Brackets className="w-3.5 h-3.5" />} onClick={() => onAdd('array')} title="Add an array">
          Array
        </Button>
        <Button size="sm" variant="ghost" icon={<ClipboardPaste className="w-3.5 h-3.5" />} onClick={onPaste} title="Create the key skeleton from a sample JSON body">
          Paste JSON
        </Button>
      </div>

      {checked.size > 0 && (
        <div role="toolbar" aria-label="Bulk actions" className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 mb-2 rounded-lg border border-blue-100 bg-blue-50/60 text-[12px]">
          <span className="font-semibold text-[#111B37]">{checked.size} selected</span>
          <Button size="sm" variant="outline" icon={<FolderInput className="w-3.5 h-3.5" />} onClick={() => actions.wrap(Array.from(checked))}>
            Move into new object
          </Button>
          <select
            value={bulkType}
            aria-label="Set the type of the selected fields"
            onChange={(e) => {
              const t = e.target.value as ValueType;
              if (t) actions.setTypeMany(Array.from(checked), t);
              setBulkType('');
            }}
            className="h-8 px-2 border border-[#D4DFEC] rounded-lg text-[12px] bg-white"
          >
            <option value="">Set type…</option>
            {VALUE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <Button size="sm" variant="danger" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => actions.remove(Array.from(checked))}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" icon={<X className="w-3.5 h-3.5" />} onClick={() => onChecked(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {rootErrors.length > 0 && (
        <div role="alert" className="mb-2 text-[11px] text-red-800 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 space-y-0.5">
          {rootErrors.map((e, i) => (
            <div key={i}>{e.message}</div>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-[240px] border border-slate-200 rounded-xl bg-white overflow-auto">
        <div className="min-w-[576px]">
          <div
            role="row"
            className="sticky top-0 z-10 grid grid-cols-[24px_minmax(140px,1.1fr)_80px_minmax(150px,1.5fr)_minmax(90px,0.8fr)_52px] items-center gap-2 px-2 h-8 bg-[#F8FAFC] border-b border-slate-200 text-[10px] font-bold uppercase tracking-wide text-[#657794]"
          >
            <input
              type="checkbox"
              aria-label="Select all rows"
              checked={allChecked}
              onChange={() => onChecked(allChecked ? new Set() : new Set(rows.map((r) => r.node.uid)))}
            />
            <span role="columnheader">Key</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Mapping / Rule</span>
            <span role="columnheader">Value (live)</span>
            <span className="sr-only" role="columnheader">
              Actions
            </span>
          </div>
          <div
            ref={bodyRef}
            role="treegrid"
            aria-label="Body fields"
            onDragOver={(e) => {
              if (accepts(e) && e.target === e.currentTarget) {
                e.preventDefault();
                setDrop({ uid: null, place: 'into' });
              }
            }}
            onDragLeave={(e) => {
              if (e.target === e.currentTarget) setDrop(null);
            }}
            onDrop={(e) => {
              if (e.target === e.currentTarget) onDropAt(e, null, 'into');
            }}
            className={`min-h-[180px] pb-10 ${drop?.uid === null ? 'bg-blue-50/40' : ''}`}
          >
            {rows.length === 0 && (
              <div className="px-6 py-10 text-center text-[12px] text-[#657794] pointer-events-none">
                <p className="font-semibold text-[#334568] mb-1">The body is empty.</p>
                <p>Click a signal in the data tree, use “Map all” on a machine, or paste a sample JSON body.</p>
              </div>
            )}
            {rows.map((row, i) => {
              const n = row.node;
              const uid = n.uid;
              const rowErrors = errors.get(uid) || [];
              const hasError = rowErrors.some((e) => e.severity !== 'warning');
              const isSel = selected === uid;
              const val = values.get(uid);
              const dropHere = drop?.uid === uid ? drop.place : null;
              const container = isContainer(n);
              const field = !container ? (n as FieldNode) : null;
              const map = field && field.mode === 'mapping' ? mappingText(field, index) : null;
              const items = [
                field && {
                  key: 'convert',
                  label: field.mode === 'mapping' ? 'Convert to rule' : 'Convert to mapping',
                  icon: field.mode === 'mapping' ? <FunctionSquare className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />,
                  onSelect: () => actions.convert(uid),
                },
                field && field.mode === 'calculated' && { key: 'edit', label: 'Edit rule…', icon: <Pencil className="w-3.5 h-3.5" />, onSelect: () => actions.editRule(uid) },
                container && {
                  key: 'ctype',
                  label: n.type === 'object' ? 'Change to array' : 'Change to object',
                  icon: n.type === 'object' ? <Brackets className="w-3.5 h-3.5" /> : <Braces className="w-3.5 h-3.5" />,
                  onSelect: () => actions.toggleContainerType(uid),
                },
                { key: 'up', label: 'Move up (Alt+↑)', icon: <ArrowUp className="w-3.5 h-3.5" />, disabled: row.index === 0, onSelect: () => actions.move(uid, -1), separator: true },
                { key: 'down', label: 'Move down (Alt+↓)', icon: <ArrowDown className="w-3.5 h-3.5" />, disabled: row.index === row.parent.children.length - 1, onSelect: () => actions.move(uid, 1) },
                {
                  key: 'indent',
                  label: 'Indent into object above (Alt+→)',
                  icon: <IndentIncrease className="w-3.5 h-3.5" />,
                  disabled: !(row.index > 0 && isContainer(row.parent.children[row.index - 1])),
                  onSelect: () => actions.indent(uid),
                },
                { key: 'outdent', label: 'Outdent (Alt+←)', icon: <IndentDecrease className="w-3.5 h-3.5" />, disabled: row.depth === 0, onSelect: () => actions.outdent(uid) },
                { key: 'dup', label: 'Duplicate (Ctrl+D)', icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => actions.duplicate(uid), separator: true },
                { key: 'del', label: 'Delete (Del)', icon: <Trash2 className="w-3.5 h-3.5" />, danger: true, onSelect: () => actions.remove([uid]) },
              ].filter(Boolean) as Array<{ key: string; label: string; icon: React.ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean; separator?: boolean }>;

              return (
                <div
                  key={uid}
                  role="row"
                  aria-level={row.depth + 1}
                  aria-selected={isSel}
                  aria-expanded={container ? !collapsed.has(uid) : undefined}
                  data-row={uid}
                  tabIndex={isSel || (!selected && i === 0) ? 0 : -1}
                  onClick={() => onSelect(isSel && container ? uid : uid)}
                  onKeyDown={(e) => onRowKey(e, row, i)}
                  onDragOver={(e) => {
                    if (!accepts(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setDrop({ uid, place: placeFor(e, row) });
                  }}
                  onDrop={(e) => {
                    e.stopPropagation();
                    onDropAt(e, uid, placeFor(e, row));
                  }}
                  className={`relative grid grid-cols-[24px_minmax(140px,1.1fr)_80px_minmax(150px,1.5fr)_minmax(90px,0.8fr)_52px] items-center gap-2 px-2 min-h-[34px] border-b border-slate-100 text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 ${
                    isSel ? 'bg-blue-50/70' : hasError ? 'bg-red-50/40' : 'hover:bg-[#F8FAFC]'
                  } ${dropHere === 'into' ? 'outline outline-2 -outline-offset-2 outline-blue-500 bg-blue-50' : ''}`}
                >
                  {dropHere === 'before' && <span className="absolute left-0 right-0 top-0 h-0.5 bg-blue-500" aria-hidden="true" />}
                  {dropHere === 'after' && <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-blue-500" aria-hidden="true" />}
                  <input type="checkbox" aria-label={`Select ${row.path || 'item'}`} checked={checked.has(uid)} onChange={() => toggleCheck(uid)} onClick={(e) => e.stopPropagation()} tabIndex={-1} />
                  <div className="flex items-center gap-1 min-w-0" style={{ paddingLeft: row.depth * 16 }}>
                    <span
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(ROW_DRAG_TYPE, uid);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => setDrop(null)}
                      className="cursor-grab text-slate-300 hover:text-slate-500"
                      title="Drag to move"
                      aria-hidden="true"
                    >
                      <GripVertical className="w-3.5 h-3.5" />
                    </span>
                    {container ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={collapsed.has(uid) ? 'Expand' : 'Collapse'}
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = new Set(collapsed);
                          if (next.has(uid)) next.delete(uid);
                          else next.add(uid);
                          onCollapsed(next);
                        }}
                        className="p-0.5 rounded hover:bg-slate-200 text-slate-500"
                      >
                        {collapsed.has(uid) ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    ) : (
                      <span className="w-[18px]" />
                    )}
                    <KeyInput
                      value={n.key}
                      disabled={row.parent.type === 'array'}
                      invalid={rowErrors.some((e) => /KEY|key/i.test(e.code || e.message))}
                      label={`Key of ${row.path || 'item'}`}
                      onCommit={(v) => actions.rename(uid, v)}
                      autoFocus={focusKeyOf === uid}
                      onFocused={onFocusKeyDone}
                    />
                    {row.parent.type === 'array' && <span className="text-[10px] text-slate-400 font-mono">[{row.index}]</span>}
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    {field ? (
                      <select
                        value={field.valueType}
                        aria-label={`Type of ${row.path}`}
                        tabIndex={-1}
                        onChange={(e) => actions.setType(uid, e.target.value as ValueType)}
                        className="w-full h-7 px-1 border border-transparent hover:border-[#D4DFEC] focus:border-blue-500 rounded text-[11px] bg-transparent"
                      >
                        {VALUE_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-[11px] font-semibold text-[#657794] px-1">{typeLabel(n)}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    {container ? (
                      <span className="text-[11px] text-[#94A3B8]">
                        {(n as ContainerNode).children.length} item{(n as ContainerNode).children.length === 1 ? '' : 's'}
                      </span>
                    ) : field!.mode === 'mapping' ? (
                      map!.text ? (
                        <span title={map!.tip} className={`block font-mono text-[11px] truncate ${map!.broken ? 'text-red-700' : 'text-[#1D4ED8]'}`}>
                          {map!.text}
                        </span>
                      ) : (
                        <span className="text-[11px] text-amber-700">{isSel ? 'Click a signal in the data tree' : 'Not mapped'}</span>
                      )
                    ) : (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          actions.editRule(uid);
                        }}
                        title="Edit rule"
                        className="w-full text-left flex items-start gap-1 rounded px-1 -mx-1 hover:bg-white hover:ring-1 hover:ring-[#D4DFEC]"
                      >
                        <span className="text-[10px] font-bold text-[#0E7490] mt-px">ƒ</span>
                        <span className="min-w-0 line-clamp-2">
                          <RuleText text={field!.exprText} index={index} />
                        </span>
                      </button>
                    )}
                  </div>
                  <div className="min-w-0 flex items-center gap-1">
                    {hasError || val?.error ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-red-700 min-w-0" title={[...rowErrors.map((e) => e.message), val?.error].filter(Boolean).join('\n')}>
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{val?.error || rowErrors[0]?.message}</span>
                      </span>
                    ) : rowErrors.length ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 min-w-0" title={rowErrors.map((e) => e.message).join('\n')}>
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate font-mono">{val?.text ?? rowErrors[0].message}</span>
                      </span>
                    ) : (
                      <span className="font-mono text-[11px] text-[#334568] truncate" title={val?.text}>
                        {container ? '' : val?.text ?? '—'}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-end" onClick={(e) => e.stopPropagation()}>
                    {container && (
                      <button
                        type="button"
                        tabIndex={-1}
                        title="Select as target for new fields"
                        aria-label={`Add into ${row.path}`}
                        onClick={() => onSelect(uid)}
                        className="w-6 h-6 inline-flex items-center justify-center rounded text-[#657794] hover:bg-[#F1F5FA]"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <IconMenu label={`Actions for ${row.path || 'item'}`} icon={<MoreVertical className="w-4 h-4" />} items={items} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p className="mt-1.5 text-[10px] text-[#94A3B8]">
        Keyboard: ↑/↓ rows · Alt+↑/↓ move · Alt+←/→ outdent / indent · F2 rename · Enter edit · Space select · Del delete · Ctrl+D duplicate
      </p>
    </div>
  );
};
