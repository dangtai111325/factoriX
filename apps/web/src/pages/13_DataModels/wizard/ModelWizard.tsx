// Create / Edit wizard of a Data Model: 1 Basics → 2 Body (data tree | body fields | live preview) → 3 Review → Save & run.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Eye, Rocket, Save, Undo2 } from 'lucide-react';
import { Button } from '../../../components/common/Button';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { useSubmit } from '../../../lib/useSubmit';
import { formatValue } from '../../../lib/format';
import { useLeaveGuard } from '../../06_AddDataWizard/useLeaveGuard';
import { createModel, errorText, getModel, isDuplicateName, isVersionConflict, setRunning, specErrorsOf, updateModel } from '../api';
import { useCatalog, usePreviewLoop, useValidation } from '../hooks';
import { nodeAt, nodeText, tryParse } from '../json';
import {
  allFields,
  bodyMachines,
  bodySignalIds,
  convertField,
  duplicateNode,
  edit,
  emptyRoot,
  errorsByUid,
  flatten,
  fromApi,
  indentNode,
  insertNodes,
  locate,
  localErrors,
  mappedRefsIn,
  moveNode,
  moveSibling,
  newContainer,
  newField,
  newRule,
  outdentNode,
  removeNodes,
  specFingerprint,
  toApi,
  uniqueKey,
  updateNode,
  wrapIntoObject,
} from '../spec';
import {
  BodyNode,
  CatalogResource,
  CatalogSignal,
  ContainerNode,
  FieldError,
  FieldNode,
  ModelDetail,
  ModelListItem,
  SAMPLE_MS_DEFAULT,
  SAMPLE_MS_MAX,
  SAMPLE_MS_MIN,
  SAMPLE_PRESETS,
  ValueType,
  isContainer,
} from '../types';
import { Banner, JsonBlock, Skeleton, StateChip, fieldCls, labelCls, sampleLabel } from '../ui';
import { BodyTable, DropPlace, LiveCell, RowActions } from './BodyTable';
import { MapAllDialog, PasteJsonDialog } from './BuilderDialogs';
import { DataTree } from './DataTree';
import { PreviewPane } from './PreviewPane';
import { RuleDraft, RuleEditorDialog, RuleText } from './RuleEditor';

interface Props {
  /** Model id, or null to create. */
  modelId: string | null;
  models: ModelListItem[];
  onCancel: () => void;
  onSaved: (id: string, message: string) => void;
}

const STEPS = ['Basics', 'Body', 'Review'] as const;

function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

function displayValue(v: unknown): string {
  if (v !== null && typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return v === null ? 'null' : formatValue(v);
}

interface RuleTarget {
  uid: string | null;
  parentUid: string | null;
  index?: number;
}

const TEMP_RULE_UID = 'rule-draft';
/** Undo depth of the body builder (R4-DM-14). */
const HISTORY_MAX = 50;
/** A save never shows "Saving…" for longer than this (R4-DM-02). */
const SAVE_TIMEOUT_MS = 60000;
const TREE_WIDTH_KEY = 'fx.dm.treeWidth';
const TREE_WIDTH_MIN = 220;
const TREE_WIDTH_MAX = 640;

function initialTreeWidth(): number {
  try {
    const v = Number(window.localStorage.getItem(TREE_WIDTH_KEY));
    if (Number.isFinite(v) && v >= TREE_WIDTH_MIN && v <= TREE_WIDTH_MAX) return v;
  } catch {
    /* storage unavailable */
  }
  return 300;
}

function isTextTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
}

/** Drag handle on the right edge of the data tree (R4-DM-07). Keyboard: ←/→ when focused. */
const PaneResizer: React.FC<{ width: number; min: number; max: number; onChange: (w: number) => void }> = ({ width, min, max, onChange }) => {
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the data tree"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize"
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => onChange(clamp(startW + ev.clientX - startX));
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onDoubleClick={() => onChange(300)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onChange(clamp(width + (e.key === 'ArrowRight' ? 24 : -24)));
        }
      }}
      className="hidden lg:block absolute top-3 bottom-3 -right-[11px] w-[6px] rounded-full cursor-col-resize bg-transparent hover:bg-blue-300 focus:bg-blue-400 focus:outline-none z-10"
    />
  );
};

export const ModelWizard: React.FC<Props> = ({ modelId, models, onCancel, onSaved }) => {
  const isEdit = Boolean(modelId);
  const catalog = useCatalog();
  const index = catalog.index;
  const wide = useMediaQuery('(min-width: 1536px)');
  const lg = useMediaQuery('(min-width: 1024px)');

  // ------------------------------------------------------------ model state
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(isEdit ? 'loading' : 'ready');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sampleMs, setSampleMs] = useState<number>(SAMPLE_MS_DEFAULT);
  const [customSample, setCustomSample] = useState(false);
  const [sampleText, setSampleText] = useState('1');
  const [root, setRoot] = useState<ContainerNode>(emptyRoot);
  const [labels, setLabels] = useState<Record<string, string> | undefined>(undefined);
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify({ n: '', d: '', s: SAMPLE_MS_DEFAULT, b: specFingerprint(emptyRoot()) }));

  const [step, setStep] = useState(1);
  const [touched, setTouched] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusKeyOf, setFocusKeyOf] = useState<string | null>(null);
  const [ruleTarget, setRuleTarget] = useState<RuleTarget | null>(null);
  const [mapAllFor, setMapAllFor] = useState<CatalogResource | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [nameConflict, setNameConflict] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [saveIssues, setSaveIssues] = useState<FieldError[]>([]);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [history, setHistory] = useState<ContainerNode[]>([]);
  const [notice, setNotice] = useState<{ text: string; undo: boolean } | null>(null);
  const [treeWidth, setTreeWidth] = useState<number>(initialTreeWidth);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(1);

  useEffect(() => setPreviewOpen(wide || !lg), [wide, lg]);

  const load = useCallback(async () => {
    if (!modelId) return;
    setLoadState('loading');
    try {
      const d = await getModel(modelId);
      const r = fromApi(d.spec);
      setDetail(d);
      setName(d.name);
      setDescription(d.description);
      setSampleMs(d.sample_ms);
      const preset = SAMPLE_PRESETS.some((p) => p.ms === d.sample_ms);
      setCustomSample(!preset);
      setSampleText(String(d.sample_ms / 1000));
      setRoot(r);
      setLabels(d.spec.labels);
      setBaseline(JSON.stringify({ n: d.name, d: d.description, s: d.sample_ms, b: specFingerprint(r) }));
      setSaveIssues([]);
      setSaveError(null);
      setHistory([]);
      setNotice(null);
      setVersionConflict(false);
      setLoadState('ready');
      setStep(2);
    } catch (err) {
      setLoadError(errorText(err, 'Could not load the model.'));
      setLoadState('error');
    }
  }, [modelId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // R4-DM-10: on first render the name input keeps its autofocus. Moving focus to the heading
    // blurred it, which marked the form as touched and showed "Name is required." before any input.
    if (shownStep.current === step) return;
    shownStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 10000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // ------------------------------------------------------------ derived
  const fingerprint = useMemo(() => JSON.stringify({ n: name, d: description, s: sampleMs, b: specFingerprint(root) }), [name, description, sampleMs, root]);
  const dirty = loadState === 'ready' && fingerprint !== baseline;
  const guard = useLeaveGuard(dirty);

  const apiSpec = useMemo(() => toApi(root, labels), [root, labels]);
  const fields = useMemo(() => allFields(root), [root]);
  const fieldCount = fields.length;
  const liveEnabled = loadState === 'ready' && step >= 2 && fieldCount > 0;
  // The preview / validation loops stay quiet while a save runs, so the save is not queued behind them.
  const [saving, setSaving] = useState(false);
  const preview = usePreviewLoop(liveEnabled && !saving ? apiSpec : null, sampleMs, liveEnabled && !saving, modelId);
  const validation = useValidation(liveEnabled ? apiSpec : null, liveEnabled, modelId);

  const local = useMemo(() => localErrors(root), [root]);
  const issuesByUid = useMemo(() => {
    const merged: FieldError[] = [];
    local.forEach((message, uid) => merged.push({ path: '', nodeId: uid, message, severity: 'error', code: 'LOCAL' }));
    const server = validation.result?.errors || [];
    // A local error on a row already explains the problem; server errors add detail (suggestions, references).
    server.forEach((e) => merged.push(e));
    saveIssues.forEach((e) => {
      if (!server.some((s) => s.nodeId === e.nodeId && s.message === e.message)) merged.push(e);
    });
    (preview.result?.errors || []).forEach((e) => {
      if (!merged.some((m) => m.nodeId && m.nodeId === e.nodeId && m.message === e.message)) merged.push({ ...e, severity: e.severity || 'error' });
    });
    return errorsByUid(root, merged);
  }, [local, validation.result, saveIssues, preview.result, root]);

  /** Rows with spec errors (local checks, /validate, a rejected save). Runtime errors of the preview do not count. */
  const blockingCount = useMemo(() => {
    const rows = new Set<string>();
    local.forEach((_m, uid) => rows.add(uid));
    const spec = [...(validation.result?.errors || []), ...saveIssues].filter((e) => e.severity !== 'warning');
    errorsByUid(root, spec).forEach((_list, uid) => rows.add(uid));
    return rows.size;
  }, [local, validation.result, saveIssues, root]);

  // Server spec errors (validate) are blocking; runtime errors (preview) are not.
  const specBlocking = useMemo(() => {
    const serverErr = (validation.result?.errors || []).filter((e) => e.severity !== 'warning').length;
    return local.size + serverErr;
  }, [local, validation.result]);

  const values = useMemo(() => {
    const out = new Map<string, LiveCell>();
    const res = preview.result;
    if (!res) return out;
    const byNode = new Map(res.fields.filter((f) => f.nodeId).map((f) => [f.nodeId!, f]));
    const parsed = tryParse(res.body);
    flatten(root).forEach((row) => {
      if (isContainer(row.node)) return;
      const f = byNode.get(row.node.uid);
      if (f) out.set(row.node.uid, { text: displayValue(f.value), error: f.error, quality: f.quality, qualityReason: f.qualityReason ?? null });
      else if (parsed) {
        const node = nodeAt(parsed, row.segments);
        if (node) out.set(row.node.uid, { text: nodeText(node), error: null });
      }
    });
    return out;
  }, [preview.result, root]);

  const usedSignalIds = useMemo(() => new Set(bodySignalIds(root, index)), [root, index]);
  const machines = useMemo(() => bodyMachines(root, index), [root, index]);
  const ruleCount = fields.filter((f) => f.mode === 'calculated').length;
  const mappedCount = fields.filter((f) => f.mode === 'mapping' && f.signalId).length;

  // ------------------------------------------------------------ insertion target
  const target = useMemo(() => {
    const none = { parentUid: null as string | null, index: undefined as number | undefined, label: 'the body root', assignUid: null as string | null };
    if (!selected) return none;
    const hit = locate(root, selected);
    if (!hit) return none;
    if (isContainer(hit.node)) return { parentUid: hit.node.uid, index: undefined, label: `${hit.node.type} "${hit.node.key || `[${hit.index}]`}"`, assignUid: null };
    const f = hit.node as FieldNode;
    if (f.mode === 'mapping' && !f.signalId) return { parentUid: hit.parent.uid, index: hit.index + 1, label: `row "${f.key || `[${hit.index}]`}"`, assignUid: f.uid };
    const parentLabel = hit.parent.uid === root.uid ? 'the body root' : `"${hit.parent.key}"`;
    return { parentUid: hit.parent.uid === root.uid ? null : hit.parent.uid, index: hit.index + 1, label: `${parentLabel}, after "${f.key || `[${hit.index}]`}"`, assignUid: null };
  }, [selected, root]);

  const nextUnmapped = (r: ContainerNode, afterUid: string | null): string | null => {
    const rows = flatten(r);
    const start = afterUid ? rows.findIndex((x) => x.node.uid === afterUid) + 1 : 0;
    const hit = [...rows.slice(start), ...rows.slice(0, start)].find((x) => !isContainer(x.node) && x.node.mode === 'mapping' && !x.node.signalId);
    return hit ? hit.node.uid : null;
  };

  // ------------------------------------------------------------ edits
  /** Every body edit goes through here: it is undoable (Ctrl+Z) and clears the errors of a rejected save. */
  const change = (next: ContainerNode, note?: string) => {
    if (next === root) return;
    setHistory((h) => [...h.slice(-(HISTORY_MAX - 1)), root]);
    setRoot(next);
    setSaveIssues([]);
    setSaveError(null);
    setNotice(note ? { text: note, undo: true } : null);
  };

  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setRoot(prev);
    setSaveIssues([]);
    setSaveError(null);
    setNotice({ text: 'Undone.', undo: false });
    setChecked(new Set());
    if (selected && !locate(prev, selected)) setSelected(null);
  };

  // Ctrl+Z / Cmd+Z in the body step (text inputs and dialogs keep their own undo).
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const dialogOpen = Boolean(ruleTarget || mapAllFor || pasteOpen || confirmLeave);
  useEffect(() => {
    if (step !== 2 || dialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !isTextTarget(e.target)) {
        e.preventDefault();
        undoRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, dialogOpen]);

  const insert = (nodes: BodyNode[], selectInserted: 'last' | 'keep' | 'firstUnmapped' = 'last') => {
    if (!nodes.length) return;
    const next = insertNodes(root, target.parentUid, nodes, target.index);
    change(next);
    if (selectInserted === 'last') setSelected(nodes[nodes.length - 1].uid);
    if (selectInserted === 'firstUnmapped') setSelected(nextUnmapped(next, null) || selected);
    if (target.parentUid) {
      const c = new Set(collapsed);
      c.delete(target.parentUid);
      setCollapsed(c);
    }
  };

  const pickSignal = (s: CatalogSignal) => {
    if (target.assignUid) {
      const hit = locate(root, target.assignUid);
      const key = hit && hit.node.key && hit.node.key !== 'field' ? hit.node.key : hit?.parent.type === 'array' ? '' : uniqueKey(hit!.parent, s.key, target.assignUid);
      const next = updateNode(root, target.assignUid, { signalId: s.id, key, missing: false });
      change(next);
      setSelected(nextUnmapped(next, target.assignUid) || target.assignUid);
      return;
    }
    const isFieldTarget = target.index !== undefined;
    insert([newField(s.key, { signalId: s.id })], isFieldTarget ? 'last' : 'keep');
  };

  const onAdd = (kind: 'field' | 'rule' | 'object' | 'array') => {
    if (kind === 'rule') {
      setRuleTarget({ uid: null, parentUid: target.parentUid, index: target.index });
      return;
    }
    const node = kind === 'field' ? newField('field') : newContainer(kind, kind);
    insert([node], 'last');
    setFocusKeyOf(node.uid);
  };

  const dropTarget = (targetUid: string | null, place: DropPlace): { parentUid: string | null; index?: number } => {
    if (!targetUid || targetUid === root.uid) return { parentUid: null };
    const hit = locate(root, targetUid);
    if (!hit) return { parentUid: null };
    if (place === 'into' && isContainer(hit.node)) return { parentUid: hit.node.uid };
    return { parentUid: hit.parent.uid === root.uid ? null : hit.parent.uid, index: place === 'before' ? hit.index : hit.index + 1 };
  };

  const actions: RowActions = {
    rename: (uid, key) => change(updateNode(root, uid, { key })),
    setType: (uid, type) => change(updateNode(root, uid, { valueType: type })),
    setTypeMany: (uids, type) =>
      change(
        edit(root, (draft) => {
          uids.forEach((uid) => {
            const hit = locate(draft, uid);
            if (hit && !isContainer(hit.node)) hit.parent.children[hit.index] = { ...hit.node, valueType: type };
          });
        }),
      ),
    convert: (uid) => {
      const hit = locate(root, uid);
      if (!hit || isContainer(hit.node)) return;
      const { patch, note } = convertField(hit.node, index);
      change(updateNode(root, uid, patch), note || undefined);
      if (patch.mode === 'calculated') setRuleTarget({ uid, parentUid: null });
      else setSelected(uid);
    },
    setRound: (uid, digits) => change(updateNode(root, uid, { roundDigits: digits })),
    toggleContainerType: (uid) => {
      const hit = locate(root, uid);
      if (!hit || !isContainer(hit.node)) return;
      const toArray = hit.node.type === 'object';
      change(
        edit(root, (draft) => {
          const h = locate(draft, uid)!;
          const c = h.node as ContainerNode;
          const children = c.children.map((ch, i) => ({ ...ch, key: toArray ? '' : ch.key || `item_${i + 1}` }));
          h.parent.children[h.index] = { ...c, type: toArray ? 'array' : 'object', children };
        }),
      );
    },
    move: (uid, delta) => change(moveSibling(root, uid, delta)),
    indent: (uid) => change(indentNode(root, uid)),
    outdent: (uid) => change(outdentNode(root, uid)),
    duplicate: (uid) => change(duplicateNode(root, uid)),
    remove: (uids) => {
      if (!uids.length) return;
      const rows = flatten(root).filter((r) => uids.includes(r.node.uid));
      const label = rows.length === 1 ? `Deleted “${rows[0].path || 'item'}”.` : `Deleted ${rows.length} rows.`;
      change(removeNodes(root, uids), label);
      setChecked(new Set(Array.from(checked).filter((u) => !uids.includes(u))));
      if (selected && uids.includes(selected)) setSelected(null);
    },
    wrap: (uids) => {
      const res = wrapIntoObject(root, uids, 'group');
      change(res.root);
      setChecked(new Set());
      if (res.uid) {
        setSelected(res.uid);
        setFocusKeyOf(res.uid);
      }
    },
    editRule: (uid) => setRuleTarget({ uid, parentUid: null }),
    dropRow: (uid, targetUid, place) => {
      const t = dropTarget(targetUid, place);
      change(moveNode(root, uid, t.parentUid, t.index));
    },
    dropSignal: (signalId, targetUid, place) => {
      const s = index.sigById.get(signalId);
      if (!s) return;
      const hit = targetUid ? locate(root, targetUid) : null;
      // Dropping onto an unmapped mapping row maps it.
      if (hit && !isContainer(hit.node) && hit.node.mode === 'mapping' && !hit.node.signalId && place !== 'into') {
        change(updateNode(root, hit.node.uid, { signalId, key: hit.node.key || s.key }));
        return;
      }
      const t = dropTarget(targetUid, place);
      change(insertNodes(root, t.parentUid, [newField(s.key, { signalId })], t.index));
    },
  };

  // ------------------------------------------------------------ rule editor wiring
  const ruleCtx = useMemo(() => {
    if (!ruleTarget) return null;
    if (ruleTarget.uid) {
      const hit = locate(root, ruleTarget.uid);
      if (!hit || isContainer(hit.node)) return null;
      const f = hit.node;
      return {
        keyed: hit.parent.type !== 'array',
        initial: { key: f.key, expr: f.exprText, valueType: f.valueType } as RuleDraft,
        siblingKeys: hit.parent.children.filter((c) => c.uid !== f.uid).map((c) => c.key),
        nodeId: f.uid,
        itemLabel: hit.parent.type === 'array' ? `${hit.parent.key || 'array'}[${hit.index}]` : null,
      };
    }
    const parent = locate(root, ruleTarget.parentUid || '')?.node;
    const container = parent && isContainer(parent) ? parent : root;
    const at = ruleTarget.index ?? container.children.length;
    return {
      keyed: container.type !== 'array',
      initial: { key: uniqueKey(container, 'rule'), expr: '', valueType: 'auto' as ValueType },
      siblingKeys: container.children.map((c) => c.key),
      nodeId: TEMP_RULE_UID,
      itemLabel: container.type === 'array' ? `${container.key || 'array'}[${at}]` : null,
    };
  }, [ruleTarget, root]);

  const buildRuleSpec = (draft: RuleDraft) => {
    if (!ruleTarget) return apiSpec;
    if (ruleTarget.uid) {
      return toApi(updateNode(root, ruleTarget.uid, { key: draft.key, exprText: draft.expr, exprEdited: true, valueType: draft.valueType, mode: 'calculated' }), labels);
    }
    const temp = { ...newRule(draft.key, draft.expr, draft.valueType), uid: TEMP_RULE_UID };
    return toApi(insertNodes(root, ruleTarget.parentUid, [temp], ruleTarget.index), labels);
  };

  const applyRule = (draft: RuleDraft) => {
    if (!ruleTarget) return;
    if (ruleTarget.uid) {
      change(updateNode(root, ruleTarget.uid, { key: draft.key, exprText: draft.expr, exprEdited: true, valueType: draft.valueType, mode: 'calculated' }));
      setSelected(ruleTarget.uid);
    } else {
      const node = newRule(draft.key, draft.expr, draft.valueType);
      change(insertNodes(root, ruleTarget.parentUid, [node], ruleTarget.index));
      setSelected(node.uid);
    }
    setRuleTarget(null);
  };

  // ------------------------------------------------------------ step 1 validation
  const trimmedName = name.trim();
  const nameTaken = models.some((m) => m.id !== modelId && m.name.trim().toLowerCase() === trimmedName.toLowerCase());
  const nameError = !trimmedName ? 'Name is required.' : trimmedName.length > 200 ? 'At most 200 characters.' : nameTaken ? 'Another data model already uses this name.' : nameConflict;
  const sampleError =
    !Number.isFinite(sampleMs) || sampleMs < SAMPLE_MS_MIN
      ? `At least ${SAMPLE_MS_MIN} ms (0.2 s).`
      : sampleMs > SAMPLE_MS_MAX
      ? 'At most 1 hour (3600 s).'
      : null;
  const basicsValid = !nameError && !sampleError;

  // ------------------------------------------------------------ save
  const save = useSubmit(async (run: boolean) => {
    setSaveError(null);
    setNameConflict(null);
    setVersionConflict(false);
    setSaving(true);
    // R4-DM-02: the button can never stay on "Saving…": the request is aborted after SAVE_TIMEOUT_MS
    // and every outcome (success, rejection, network error, timeout) ends in `finally`.
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, SAVE_TIMEOUT_MS);
    const payload = { name: trimmedName, description: description.trim(), sample_ms: sampleMs, spec: apiSpec };
    try {
      let id = modelId;
      let wasPaused = detail?.state === 'PAUSED';
      if (isEdit && modelId && detail) {
        const updated = await updateModel(modelId, detail.version, payload, ctrl.signal);
        wasPaused = updated.state === 'PAUSED';
      } else {
        const created = await createModel({ ...payload, state: run ? 'RUNNING' : 'PAUSED' }, ctrl.signal);
        id = created.id;
        wasPaused = created.state === 'PAUSED';
      }
      if (run && id && wasPaused) await setRunning(id, true);
      guard.allowNext();
      setBaseline(fingerprint);
      onSaved(id!, isEdit ? `Saved “${trimmedName}”.${run ? ' It is running.' : ''}` : `Created “${trimmedName}”${run ? ' and started sampling' : ''}.`);
    } catch (err) {
      if (timedOut) {
        setSaveError('FactoriX did not answer in time. Your changes are kept on this page — retry in a moment.');
        return;
      }
      if (isDuplicateName(err)) {
        setNameConflict('Another data model already uses this name.');
        setStep(1);
        return;
      }
      if (isVersionConflict(err)) {
        setVersionConflict(true);
        return;
      }
      const issues = specErrorsOf(err);
      if (issues.length) {
        setSaveIssues(issues);
        setStep(2);
        // Same count as the body status bar ("N row(s) with errors"), not the raw issue count.
        const rows = errorsByUid(root, issues.filter((e) => e.severity !== 'warning')).size;
        const first = issues.find((e) => e.severity !== 'warning') || issues[0];
        setSaveError(`Not saved: ${rows} row${rows === 1 ? '' : 's'} need${rows === 1 ? 's' : ''} fixing. ${first.path ? `${first.path}: ` : ''}${first.message}`);
        return;
      }
      setSaveError(errorText(err, 'Could not save the model.'));
    } finally {
      window.clearTimeout(timer);
      setSaving(false);
    }
  });

  const requestCancel = () => {
    if (dirty) setConfirmLeave(true);
    else onCancel();
  };

  const goStep = (n: number) => {
    setTouched(true);
    if (n > 1 && !basicsValid) {
      setStep(1);
      return;
    }
    setStep(n);
  };

  // ------------------------------------------------------------ render
  const defaultScopeId = useMemo(() => {
    const counts = new Map<string, number>();
    bodySignalIds(root, index).forEach((id) => {
      const s = index.sigById.get(id);
      if (s) counts.set(s.resourceId, (counts.get(s.resourceId) || 0) + 1);
    });
    const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : '';
  }, [root, index]);

  const unattached = issuesByUid.get(root.uid) || [];
  const jumpTo = (path: string, nodeId?: string) => {
    const row = flatten(root).find((r) => r.node.uid === nodeId || r.pointer === path);
    if (!row) return;
    setSelected(row.node.uid);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row="${row.node.uid}"]`)?.focus());
  };

  if (loadState === 'loading') {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="w-3.5 h-3.5" />} onClick={onCancel}>
          Data models
        </Button>
        <Banner
          tone="error"
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Retry
              </Button>
              <Button size="sm" variant="primary" onClick={onCancel}>
                Back to catalog
              </Button>
            </div>
          }
        >
          {loadError}
        </Banner>
      </div>
    );
  }

  const stepNav = (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="Steps">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const current = step === n;
        const done = step > n;
        return (
          <li key={label} className="flex items-center gap-1.5">
            <button
              type="button"
              aria-current={current ? 'step' : undefined}
              onClick={() => goStep(n)}
              className={`inline-flex items-center gap-2 h-8 pl-1.5 pr-3 rounded-full text-[12px] font-semibold border transition ${
                current ? 'bg-[#111B37] text-white border-[#111B37]' : done ? 'bg-white text-[#111B37] border-[#D4DFEC]' : 'bg-white text-[#657794] border-[#E2E8F0]'
              }`}
            >
              <span className={`w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px] ${current ? 'bg-white text-[#111B37]' : done ? 'bg-emerald-600 text-white' : 'bg-slate-100'}`}>
                {done ? <Check className="w-3 h-3" /> : n}
              </span>
              {label}
            </button>
            {n < STEPS.length && <ChevronRight className="w-3.5 h-3.5 text-slate-300" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );

  const ruleIndexRefs = mappedRefsIn(root, index);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="w-3.5 h-3.5" />} onClick={requestCancel}>
          Data models
        </Button>
        <div className="min-w-0 mr-auto">
          <h1 ref={headingRef} tabIndex={-1} className="text-[18px] font-bold text-[#111B37] outline-none truncate">
            {isEdit ? `Edit ${detail?.name || 'data model'}` : 'Create data model'}
            <span className="sr-only">, step {step} of 3: {STEPS[step - 1]}</span>
          </h1>
          <div className="flex items-center gap-2 text-[12px] text-[#657794]">
            <StateChip state={detail ? detail.state : 'NEW'} />
            {dirty && <span className="text-amber-700 font-semibold">Unsaved changes</span>}
          </div>
        </div>
        {stepNav}
      </div>

      {catalog.unsupported && (
        <Banner tone="warning">The Center does not offer the data catalog yet. The tree is built from the signals loaded by the app; live preview may be unavailable.</Banner>
      )}
      {versionConflict && (
        <Banner tone="error" action={<Button size="sm" variant="outline" onClick={() => void load()}>Reload</Button>}>
          Someone else changed this model while you were editing. Reload to get the latest version (your unsaved changes will be lost).
        </Banner>
      )}
      {saveError && !versionConflict && (
        <Banner tone="error" onClose={() => setSaveError(null)}>
          {saveError}
        </Banner>
      )}

      {/* ---------------------------------------------------------------- Step 1 */}
      {step === 1 && (
        <section aria-label="Basics" className="max-w-2xl bg-white border border-[#CBD5E1] rounded-xl p-5 space-y-5">
          <div>
            <label htmlFor="dm-name" className={labelCls}>
              Name <span className="text-red-600">*</span>
            </label>
            <input
              id="dm-name"
              value={name}
              maxLength={200}
              autoFocus
              aria-invalid={touched && Boolean(nameError)}
              aria-describedby="dm-name-err"
              onChange={(e) => {
                setName(e.target.value);
                setNameConflict(null);
              }}
              onBlur={() => setTouched(true)}
              placeholder="e.g. Machine state"
              className={`${fieldCls} ${touched && nameError ? 'border-red-400' : ''}`}
            />
            {touched && nameError && (
              <p id="dm-name-err" className="mt-1 text-[11px] text-red-700">
                {nameError}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="dm-desc" className={labelCls}>
              Description
            </label>
            <textarea
              id="dm-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this body is for and who consumes it."
              className="w-full px-3 py-2 border border-[#D4DFEC] rounded-lg text-[13px] focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <fieldset>
            <legend className={labelCls}>Sampling rate</legend>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Sampling rate">
              {SAMPLE_PRESETS.map((p) => {
                const on = !customSample && sampleMs === p.ms;
                return (
                  <button
                    key={p.ms}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      setCustomSample(false);
                      setSampleMs(p.ms);
                      setSampleText(String(p.ms / 1000));
                    }}
                    className={`h-8 px-3 rounded-lg border text-[12px] font-semibold ${on ? 'bg-[#111B37] text-white border-[#111B37]' : 'bg-white text-[#334568] border-[#D4DFEC] hover:bg-[#F8FAFC]'}`}
                  >
                    {p.label}
                  </button>
                );
              })}
              <button
                type="button"
                role="radio"
                aria-checked={customSample}
                onClick={() => setCustomSample(true)}
                className={`h-8 px-3 rounded-lg border text-[12px] font-semibold ${customSample ? 'bg-[#111B37] text-white border-[#111B37]' : 'bg-white text-[#334568] border-[#D4DFEC] hover:bg-[#F8FAFC]'}`}
              >
                Custom
              </button>
            </div>
            {customSample && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min={0.2}
                  max={3600}
                  step={0.1}
                  value={sampleText}
                  aria-label="Custom sampling rate in seconds"
                  aria-invalid={Boolean(sampleError)}
                  onChange={(e) => {
                    setSampleText(e.target.value);
                    const seconds = Number(e.target.value);
                    setSampleMs(e.target.value.trim() === '' ? Number.NaN : Math.round(seconds * 1000));
                  }}
                  className={`${fieldCls} w-32`}
                />
                <span className="text-[12px] text-[#657794]">seconds (0.2 – 3600)</span>
              </div>
            )}
            {sampleError ? (
              // R4-DM-19: an invalid value shows only the error, never "Every 100 ms …" next to it.
              <p className="mt-1 text-[11px] text-red-700" role="alert">
                {sampleError}
              </p>
            ) : (
              <p className="mt-2 text-[12px] text-[#657794] leading-relaxed">
                Every {sampleLabel(sampleMs)} the model reads the latest value of each data point. Independent of how often the collector reads the source.
              </p>
            )}
          </fieldset>
          <div className="flex justify-between pt-3 border-t border-slate-100">
            <Button variant="outline" size="sm" onClick={requestCancel}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => goStep(2)} disabled={touched && !basicsValid}>
              Next: Body <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------------- Step 2 */}
      {step === 2 && (
        <>
          <div
            style={{ ['--tree-w' as string]: `${treeWidth}px` } as React.CSSProperties}
            className={`grid grid-cols-1 gap-4 min-w-0 ${
              !previewOpen
                ? 'lg:grid-cols-[var(--tree-w)_minmax(0,1fr)_40px]'
                : wide
                ? 'lg:grid-cols-[var(--tree-w)_minmax(0,1fr)_minmax(300px,380px)]'
                : 'lg:grid-cols-[var(--tree-w)_minmax(0,1fr)]'
            }`}
          >
            <section aria-label="Data tree" className="relative bg-white border border-[#CBD5E1] rounded-xl p-3 min-w-0 min-h-0 h-[420px] lg:h-[calc(100vh-260px)] lg:min-h-[520px] flex flex-col">
              <PaneResizer
                width={treeWidth}
                min={TREE_WIDTH_MIN}
                max={TREE_WIDTH_MAX}
                onChange={(w) => {
                  setTreeWidth(w);
                  try {
                    window.localStorage.setItem(TREE_WIDTH_KEY, String(w));
                  } catch {
                    /* storage unavailable */
                  }
                }}
              />
              <DataTree
                index={index}
                loading={catalog.loading}
                error={catalog.error}
                onReload={() => void catalog.reload()}
                targetLabel={target.label}
                onPickSignal={pickSignal}
                onMapAll={setMapAllFor}
                usedSignalIds={usedSignalIds}
              />
            </section>
            <section aria-label="Body fields" className="bg-white border border-[#CBD5E1] rounded-xl p-3 min-w-0 min-h-[420px] lg:h-[calc(100vh-260px)] lg:min-h-[520px] flex flex-col">
              {notice && (
                <div role="status" className="mb-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-[#F8FAFC] px-2.5 py-1.5 text-[12px] text-[#334568]">
                  <span className="min-w-0 flex-1">{notice.text}</span>
                  {notice.undo && history.length > 0 && (
                    <Button size="sm" variant="outline" icon={<Undo2 className="w-3.5 h-3.5" />} onClick={undo}>
                      Undo
                    </Button>
                  )}
                </div>
              )}
              <BodyTable
                root={root}
                index={index}
                selected={selected}
                onSelect={setSelected}
                targetLabel={target.label}
                canUndo={history.length > 0}
                onUndo={undo}
                checked={checked}
                onChecked={setChecked}
                collapsed={collapsed}
                onCollapsed={setCollapsed}
                errors={issuesByUid}
                values={values}
                actions={actions}
                onAdd={onAdd}
                onPaste={() => setPasteOpen(true)}
                focusKeyOf={focusKeyOf}
                onFocusKeyDone={() => setFocusKeyOf(null)}
              />
            </section>
            {previewOpen ? (
              <section aria-label="Live preview" className={`bg-white border border-[#CBD5E1] rounded-xl p-3 min-w-0 flex flex-col ${wide ? 'lg:h-[calc(100vh-260px)] lg:min-h-[520px]' : lg ? 'lg:col-span-2 h-[420px]' : 'h-[420px]'}`}>
                {lg && !wide && (
                  <div className="flex justify-end -mb-1">
                    <button type="button" onClick={() => setPreviewOpen(false)} className="text-[11px] font-semibold text-[#134074] hover:underline">
                      Hide preview
                    </button>
                  </div>
                )}
                <PreviewPane
                  result={preview.result}
                  error={preview.error}
                  running={preview.running}
                  unsupported={preview.unsupported}
                  paused={preview.paused}
                  onPause={preview.setPaused}
                  onRefresh={preview.refresh}
                  sampleMs={sampleMs}
                  errors={[...unattached, ...(preview.result?.errors || []).filter((e) => !e.nodeId && !e.path)]}
                  onJump={jumpTo}
                  emptyBody={fieldCount === 0}
                />
              </section>
            ) : (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                aria-label="Show live preview"
                className="hidden lg:flex flex-col items-center gap-2 pt-3 lg:h-[calc(100vh-260px)] lg:min-h-[520px] bg-white border border-[#CBD5E1] rounded-xl text-[11px] font-semibold text-[#134074] hover:bg-[#F8FAFC]"
              >
                <ChevronLeft className="w-4 h-4" />
                <Eye className="w-4 h-4" />
                <span className="[writing-mode:vertical-rl] rotate-180">Live preview</span>
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 bg-white border border-[#CBD5E1] rounded-xl px-4 py-2.5">
            <span className="text-[12px] text-[#334568]">
              <strong>{fieldCount}</strong> field(s) · <strong>{mappedCount}</strong> mapped · <strong>{ruleCount}</strong> rule(s)
              {machines.length > 0 && <> · {machines.length} resource(s)</>}
            </span>
            {blockingCount > 0 ? (
              <span className="text-[12px] font-semibold text-red-700">{blockingCount} row(s) with errors</span>
            ) : validation.pending ? (
              <span className="text-[12px] text-[#657794]">Checking…</span>
            ) : fieldCount > 0 ? (
              <span className="text-[12px] font-semibold text-emerald-700">No errors</span>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => goStep(1)}>
                <ArrowLeft className="w-3.5 h-3.5" /> Basics
              </Button>
              <Button variant="primary" size="sm" onClick={() => goStep(3)} disabled={fieldCount === 0}>
                Next: Review <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </>
      )}

      {/* ---------------------------------------------------------------- Step 3 */}
      {step === 3 && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
          <section aria-label="Summary" className="bg-white border border-[#CBD5E1] rounded-xl p-5 space-y-4">
            <h2 className="text-[14px] font-bold text-[#111B37]">Summary</h2>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                ['Fields', fieldCount],
                ['Mapped', mappedCount],
                ['Rules', ruleCount],
                ['Sampling', sampleLabel(sampleMs)],
              ].map(([k, v]) => (
                <div key={String(k)} className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
                  <dt className="text-[10px] font-bold uppercase tracking-wide text-[#657794]">{k}</dt>
                  <dd className="text-[16px] font-bold text-[#111B37]">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="text-[12px] text-[#334568] space-y-1">
              <div>
                <span className="font-semibold">Name:</span> {trimmedName}
              </div>
              {description.trim() && (
                <div>
                  <span className="font-semibold">Description:</span> {description.trim()}
                </div>
              )}
              <div>
                <span className="font-semibold">Resources involved:</span> {machines.length ? machines.join(', ') : '—'}
              </div>
            </div>
            {ruleCount > 0 && (
              <div>
                <h3 className="text-[12px] font-bold text-[#111B37] mb-1.5">Rules</h3>
                <ul className="space-y-1 max-h-56 overflow-y-auto">
                  {flatten(root)
                    .filter((r) => !isContainer(r.node) && r.node.mode === 'calculated')
                    .map((r) => (
                      <li key={r.node.uid} className="text-[11px] flex gap-1.5 items-start">
                        <span className="font-mono font-semibold text-[#111B37] shrink-0">{r.path} =</span>
                        <RuleText text={(r.node as FieldNode).exprText} index={index} />
                      </li>
                    ))}
                </ul>
              </div>
            )}
            {(specBlocking > 0 || blockingCount > 0) && (
              <Banner tone="error" action={<Button size="sm" variant="outline" onClick={() => setStep(2)}>Fix in Body</Button>}>
                {Math.max(specBlocking, blockingCount)} problem(s) must be fixed before saving.
              </Banner>
            )}
            <div className="flex flex-wrap justify-between gap-2 pt-3 border-t border-slate-100">
              <Button variant="outline" size="sm" onClick={() => setStep(2)}>
                <ArrowLeft className="w-3.5 h-3.5" /> Body
              </Button>
              <div className="flex gap-2">
                {isEdit && (
                  <Button variant="outline" size="sm" icon={<Save className="w-3.5 h-3.5" />} disabled={save.pending || specBlocking > 0} onClick={() => void save.run(false)}>
                    {save.pending ? 'Saving…' : detail?.state === 'PAUSED' ? 'Save (keep paused)' : 'Save'}
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Rocket className="w-3.5 h-3.5" />}
                  disabled={save.pending || specBlocking > 0 || fieldCount === 0}
                  aria-busy={save.pending}
                  onClick={() => void save.run(true)}
                >
                  {save.pending ? 'Saving…' : 'Save & run'}
                </Button>
              </div>
            </div>
          </section>
          <section aria-label="Final body" className="bg-white border border-[#CBD5E1] rounded-xl p-5 flex flex-col min-h-[420px]">
            <PreviewPane
              result={preview.result}
              error={preview.error}
              running={preview.running}
              unsupported={preview.unsupported}
              paused={preview.paused}
              onPause={preview.setPaused}
              onRefresh={preview.refresh}
              sampleMs={sampleMs}
              errors={Array.from(issuesByUid.entries()).flatMap(([uid, list]) => {
                const row = flatten(root).find((r) => r.node.uid === uid);
                return list.map((e) => ({ ...e, path: row ? row.pointer : e.path, nodeId: uid }));
              })}
              onJump={(p, id) => {
                setStep(2);
                window.setTimeout(() => jumpTo(p, id), 50);
              }}
              emptyBody={fieldCount === 0}
            />
          </section>
        </div>
      )}

      {ruleCtx && ruleTarget && (
        <RuleEditorDialog
          open
          keyed={ruleCtx.keyed}
          itemLabel={ruleCtx.itemLabel}
          initial={ruleCtx.initial}
          index={index}
          exampleRefs={ruleIndexRefs}
          buildSpec={buildRuleSpec}
          nodeId={ruleCtx.nodeId}
          modelId={modelId}
          siblingKeys={ruleCtx.siblingKeys}
          onApply={applyRule}
          onClose={() => setRuleTarget(null)}
        />
      )}
      <MapAllDialog
        resource={mapAllFor}
        index={index}
        targetLabel={target.label}
        onClose={() => setMapAllFor(null)}
        onApply={(nodes) => {
          insert(nodes, 'keep');
          setMapAllFor(null);
        }}
      />
      <PasteJsonDialog
        open={pasteOpen}
        index={index}
        targetLabel={target.label}
        defaultScopeId={defaultScopeId}
        onClose={() => setPasteOpen(false)}
        onApply={(nodes) => {
          insert(nodes, 'firstUnmapped');
          setPasteOpen(false);
        }}
      />
      <ConfirmDialog
        isOpen={confirmLeave || Boolean(guard.pending)}
        title="Discard unsaved changes?"
        message={`Your changes to ${trimmedName ? `“${trimmedName}”` : 'this data model'} are not saved.`}
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        variant="warning"
        onConfirm={() => {
          if (guard.pending) guard.proceed();
          else {
            setConfirmLeave(false);
            guard.allowNext();
            onCancel();
          }
        }}
        onCancel={() => {
          setConfirmLeave(false);
          guard.cancel();
        }}
      />
    </div>
  );
};

