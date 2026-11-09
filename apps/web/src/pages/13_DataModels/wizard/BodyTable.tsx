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
  Sigma,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { Button } from '../../../components/common/Button';
import { CatalogIndex, missingLabel, signalRef, signalTooltip } from '../rules';
import { FlatRow, flatten } from '../spec';
import { BodyNode, ContainerNode, FieldError, FieldNode, FieldQuality, ROUND_DIGITS_MAX, VALUE_TYPES, ValueType, isContainer } from '../types';
import { Dialog, IconMenu, QualityDot } from '../ui';
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
  /** Field-level output rounding (null = off). */
  setRound: (uid: string, digits: number | null) => void;
}

/** Live value of a row in the editor preview. */
export interface LiveCell {
  text: string;
  error: string | null;
  quality?: FieldQuality;
  qualityReason?: string | null;
}

interface Props {
  root: ContainerNode;
  index: CatalogIndex | null;
  selected: string | null;
  onSelect: (uid: string | null) => void;
  /** Where "+ Field / Rule / Object / Array" and a signal click add (shown above the table). */
  targetLabel: string;
  canUndo: boolean;
  onUndo: () => void;
  checked: Set<string>;
  onChecked: (next: Set<string>) => void;
  collapsed: Set<string>;
  onCollapsed: (next: Set<string>) => void;
  errors: Map<string, FieldError[]>;
  values: Map<string, LiveCell>;
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
  const reason = f.missingReason || 'The mapped data point no longer exists (deleted or disabled). The field outputs null.';
  if (f.refDisplay && (f.missing || f.refDisplay.includes('⚠'))) return { text: `Missing: ${missingLabel(f.refDisplay)}`, tip: `${reason}\nPick another signal in the data tree.`, broken: true };
  if (f.refDisplay) return { text: f.refDisplay, tip: f.refTooltip || f.refDisplay, broken: false };
  return { text: 'Missing data point', tip: reason, broken: true };
}

const GRID = 'grid grid-cols-[24px_minmax(180px,1.3fr)_88px_minmax(150px,1.5fr)_minmax(110px,0.8fr)_52px]';

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
      title={text}
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
  targetLabel,
  canUndo,
  onUndo,
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
  const [roundFor, setRoundFor] = useState<FieldNode | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Anchor of Shift-click range selection (R4-DM-14). */
  const anchorRef = useRef<string | null>(null);
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
    anchorRef.current = uid;
    onChecked(next);
  };

  /** Shift-click: select every visible row between the anchor and this one (inclusive). */
  const checkRange = (uid: string) => {
    const anchor = anchorRef.current && rows.some((r) => r.node.uid === anchorRef.current) ? anchorRef.current : selected;
    const a = rows.findIndex((r) => r.node.uid === anchor);
    const b = rows.findIndex((r) => r.node.uid === uid);
    if (a < 0 || b < 0) return toggleCheck(uid);
    const next = new Set(checked);
    rows.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((r) => next.add(r.node.uid));
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
      if (e.shiftKey) checkRange(uid);
      else toggleCheck(uid);
    } else if (e.key === 'Escape') {
      // R4-DM-05: Escape drops the selection, so new fields go to the body root again.
      if (checked.size) onChecked(new Set());
      else if (selected) onSelect(null);
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
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="Undo the last change (Ctrl+Z)"
          title="Undo the last change (Ctrl+Z)"
          className="w-8 h-8 inline-flex items-center justify-center rounded-lg border border-[#D4DFEC] bg-white text-[#334568] hover:bg-[#F1F5FA] disabled:opacity-40"
        >
          <Undo2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* R4-DM-05: where new fields go, and a way back to the root at any time. */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[11px] text-[#657794]">
        <span>
          New fields go to <span className="font-semibold text-[#334568]">{targetLabel}</span>
        </span>
        {selected && (
          <button type="button" onClick={() => onSelect(null)} className="px-1.5 py-0.5 rounded border border-[#D4DFEC] bg-white font-semibold text-[#134074] hover:bg-[#EEF5FF]" title="Esc">
            Use body root
          </button>
        )}
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

      {rows.length === 0 && (
        // Outside the scrolling table so it is never clipped on narrow screens (R4-UI-03).
        <div className="mb-2 px-4 py-6 text-center text-[12px] text-[#657794] border border-dashed border-slate-200 rounded-xl">
          <p className="font-semibold text-[#334568] mb-1">The body is empty.</p>
          <p>Click a signal in the data tree, use “Map all” on a machine, or paste a sample JSON body.</p>
        </div>
      )}

      {/* The table keeps a minimum width and scrolls horizontally inside its own box (R4-UI-03). */}
      <div className="flex-1 min-h-[240px] min-w-0 max-w-full border border-slate-200 rounded-xl bg-white overflow-auto overscroll-x-contain">
        <div className="min-w-[660px]">
          <div
            role="row"
            className={`sticky top-0 z-10 ${GRID} items-center gap-2 px-2 h-8 bg-[#F8FAFC] border-b border-slate-200 text-[10px] font-bold uppercase tracking-wide text-[#657794]`}
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
            onClick={(e) => {
              // A click on the empty area below the rows targets the body root again (R4-DM-05).
              if (e.target === e.currentTarget) onSelect(null);
            }}
            className={`min-h-[180px] pb-10 ${drop?.uid === null ? 'bg-blue-50/40' : ''}`}
          >
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
                field && {
                  key: 'round',
                  label: field.roundDigits !== null ? `Round digits: ${field.roundDigits}…` : 'Round digits…',
                  icon: <Sigma className="w-3.5 h-3.5" />,
                  onSelect: () => setRoundFor(field),
                },
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
                  onClick={(e) => {
                    if (e.shiftKey) {
                      e.preventDefault();
                      checkRange(uid);
                      return;
                    }
                    if (e.ctrlKey || e.metaKey) {
                      toggleCheck(uid);
                      return;
                    }
                    anchorRef.current = uid;
                    onSelect(uid);
                  }}
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
                  className={`relative ${GRID} items-center gap-2 px-2 min-h-[34px] border-b border-slate-100 text-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 ${
                    isSel ? 'bg-blue-50/70' : hasError ? 'bg-red-50/40' : 'hover:bg-[#F8FAFC]'
                  } ${dropHere === 'into' ? 'outline outline-2 -outline-offset-2 outline-blue-500 bg-blue-50' : ''}`}
                >
                  {dropHere === 'before' && <span className="absolute left-0 right-0 top-0 h-0.5 bg-blue-500" aria-hidden="true" />}
                  {dropHere === 'after' && <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-blue-500" aria-hidden="true" />}
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.path || 'item'}`}
                    title="Select (Shift+click selects a range)"
                    checked={checked.has(uid)}
                    onChange={() => undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.shiftKey) checkRange(uid);
                      else toggleCheck(uid);
                    }}
                    tabIndex={-1}
                  />
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
                  <div onClick={(e) => e.stopPropagation()} className="relative">
                    {field && field.roundDigits !== null && (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => setRoundFor(field)}
                        title={`Rounded to ${field.roundDigits} digit(s). Click to change.`}
                        className="absolute -top-1.5 right-0 z-[1] text-[9px] font-bold px-1 rounded bg-[#EEF5FF] text-[#1D4ED8] border border-[#D2E3FA]"
                      >
                        ≈{field.roundDigits}
                      </button>
                    )}
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
                      <>
                        {!container && val?.quality && val.quality !== 'good' && <QualityDot quality={val.quality} reason={val.qualityReason} />}
                        <span className="font-mono text-[11px] text-[#334568] truncate" title={val?.text}>
                          {container ? '' : val?.text ?? '—'}
                        </span>
                      </>
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
        Keyboard: ↑/↓ rows · Alt+↑/↓ move · Alt+←/→ outdent / indent · F2 rename · Enter edit · Space select (Shift: range) · Del delete · Ctrl+D duplicate · Ctrl+Z undo · Esc
        root
      </p>
      <RoundDialog field={roundFor} onClose={() => setRoundFor(null)} onApply={(digits) => roundFor && actions.setRound(roundFor.uid, digits)} />
    </div>
  );
};

/** Field-level "Round digits" (R4-DM-17): numbers are rounded half away from zero on output. */
const RoundDialog: React.FC<{ field: FieldNode | null; onClose: () => void; onApply: (digits: number | null) => void }> = ({ field, onClose, onApply }) => {
  const [text, setText] = useState('');
  useEffect(() => {
    if (field) setText(field.roundDigits === null ? '2' : String(field.roundDigits));
  }, [field]);
  const n = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= ROUND_DIGITS_MAX;
  const apply = (digits: number | null) => {
    onApply(digits);
    onClose();
  };
  return (
    <Dialog
      open={Boolean(field)}
      onClose={onClose}
      width="sm"
      title="Round digits"
      subtitle={field ? `Output of “${field.key || 'item'}”. Numbers are rounded half away from zero; text and other values are not changed.` : undefined}
      footer={
        <>
          {field?.roundDigits !== null && (
            <Button variant="ghost" size="sm" className="mr-auto" onClick={() => apply(null)}>
              Turn off
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!valid} onClick={() => apply(n)}>
            Apply
          </Button>
        </>
      }
    >
      <label className="block text-[12px] font-semibold text-[#334568]">
        Digits after the decimal point (0 – {ROUND_DIGITS_MAX})
        <input
          type="number"
          min={0}
          max={ROUND_DIGITS_MAX}
          step={1}
          value={text}
          data-autofocus
          aria-invalid={!valid}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid) apply(n);
          }}
          className="mt-1 w-28 h-8 px-2 border border-[#D4DFEC] rounded-lg text-[13px] focus:outline-none focus:border-blue-500"
        />
      </label>
      {!valid && <p className="mt-1 text-[11px] text-red-700">Enter a whole number from 0 to {ROUND_DIGITS_MAX}.</p>}
      <p className="mt-2 text-[11px] text-[#657794]">Calculated numbers are already cleaned of binary noise (e.g. 30.364800000000002 → 30.3648); use this for a fixed precision.</p>
    </Dialog>
  );
};
