// Custom Rule editor: `key = expression` with syntax highlighting, `$` autocomplete over
// types › names › signal keys (with live values), the function reference, examples, debounced
// server validation (/data-models/validate) and a result preview (/data-models/preview).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, CheckCircle2, ChevronDown, Loader2, Search } from 'lucide-react';
import { Button } from '../../../components/common/Button';
import { formatValue } from '../../../lib/format';
import { errorText, getRuleFunctions, isNotFound, previewSpec, validateSpec } from '../api';
import {
  CatalogIndex,
  Completion,
  FUNCTION_GROUP_LABEL,
  RULE_EXAMPLES,
  RULE_FUNCTIONS,
  RuleFunction,
  Token,
  completions,
  localProblems,
  tokenize,
} from '../rules';
import { ApiSpec, FieldError, KEY_MAX, ValueType, VALUE_TYPES } from '../types';
import { Dialog } from '../ui';

// ------------------------------------------------------------------ highlighting

const TOKEN_CLS: Record<Token['kind'], string> = {
  ref: 'text-[#1D4ED8] bg-blue-50 rounded-sm',
  broken: 'text-red-700 bg-red-50 rounded-sm underline decoration-wavy decoration-red-500',
  string: 'text-[#047857]',
  number: 'text-[#B45309]',
  keyword: 'text-[#7C3AED] font-semibold',
  func: 'text-[#0E7490] font-semibold',
  ident: 'text-red-700 underline decoration-dotted',
  op: 'text-slate-600',
  punct: 'text-slate-500',
  space: '',
  error: 'text-red-700 underline decoration-wavy decoration-red-500',
};

function highlight(tokens: Token[], errorRange?: { pos: number; end: number } | null): React.ReactNode[] {
  return tokens.map((t, i) => {
    const inRange = errorRange && t.start < errorRange.end && t.start + t.text.length > errorRange.pos && t.kind !== 'space';
    return (
      <span
        key={i}
        className={`${TOKEN_CLS[t.kind]} ${inRange ? 'underline decoration-wavy decoration-red-500' : ''}`}
        title={t.message ? `${t.message}${t.suggestions?.length ? `\nDid you mean: ${t.suggestions.join(', ')}` : ''}` : undefined}
      >
        {t.text}
      </span>
    );
  });
}

/** Read-only highlighted rule (table cells, review). */
export const RuleText: React.FC<{ text: string; index: CatalogIndex | null; className?: string }> = ({ text, index, className = '' }) => {
  const tokens = useMemo(() => tokenize(text, index), [text, index]);
  if (!text.trim()) return <span className="text-[11px] italic text-slate-400">empty rule</span>;
  return <code className={`font-mono [font-variant-ligatures:none] text-[11px] whitespace-pre-wrap break-all ${className}`}>{highlight(tokens)}</code>;
};

// ------------------------------------------------------------------ function reference (server list when available)

let functionCache: Promise<{ functions: RuleFunction[]; examples: Array<{ label: string; expr: string }> }> | null = null;

function loadFunctions() {
  if (!functionCache) {
    functionCache = getRuleFunctions()
      .then((res) => {
        if (!res.functions.length) return { functions: RULE_FUNCTIONS, examples: res.examples };
        const local = new Map(RULE_FUNCTIONS.map((f) => [f.name, f]));
        const merged = res.functions.map((f) => {
          const l = local.get(f.name);
          const group = (['math', 'logic', 'string', 'time', 'filter'].includes(f.group) ? f.group : l?.group || 'math') as RuleFunction['group'];
          return { name: f.name, signature: f.signature || l?.signature || `${f.name}()`, description: f.description || l?.description || '', example: l?.example || f.signature, group };
        });
        return { functions: merged, examples: res.examples };
      })
      .catch((err) => {
        if (!isNotFound(err)) functionCache = null; // retry later on transient errors
        return { functions: RULE_FUNCTIONS, examples: [] };
      });
  }
  return functionCache;
}

function useRuleFunctions() {
  const [state, setState] = useState<{ functions: RuleFunction[]; examples: Array<{ label: string; expr: string }> }>({ functions: RULE_FUNCTIONS, examples: [] });
  useEffect(() => {
    let alive = true;
    void loadFunctions().then((r) => alive && setState(r));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

// ------------------------------------------------------------------ editor

export interface RuleDraft {
  key: string;
  expr: string;
  valueType: ValueType;
}

interface Props {
  open: boolean;
  /** Whether the key can be edited (array items have no key). */
  keyed: boolean;
  initial: RuleDraft;
  index: CatalogIndex | null;
  /** Mapped references of the body, used to fill the examples. */
  exampleRefs: string[];
  /** Spec with this field replaced by the draft (for in-context validation / preview), and the row id. */
  buildSpec: (draft: RuleDraft) => ApiSpec;
  nodeId: string;
  modelId: string | null;
  /** Keys already used by siblings (duplicate check). */
  siblingKeys: string[];
  onApply: (draft: RuleDraft) => void;
  onClose: () => void;
}

export const RuleEditorDialog: React.FC<Props> = ({ open, keyed, initial, index, exampleRefs, buildSpec, nodeId, modelId, siblingKeys, onApply, onClose }) => {
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [cursor, setCursor] = useState(initial.expr.length);
  const [acOpen, setAcOpen] = useState(false);
  const [acIndex, setAcIndex] = useState(0);
  const [fnQuery, setFnQuery] = useState('');
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [check, setCheck] = useState<{ pending: boolean; errors: FieldError[]; value: unknown; valueError: string | null; ran: boolean; failure: string | null }>({
    pending: false,
    errors: [],
    value: undefined,
    valueError: null,
    ran: false,
    failure: null,
  });
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const { functions, examples: serverExamples } = useRuleFunctions();
  const sessionId = useMemo(() => `rule-${Date.now().toString(36)}`, []);

  useEffect(() => {
    if (open) {
      setDraft(initial);
      setCursor(initial.expr.length);
      setAcOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tokens = useMemo(() => tokenize(draft.expr, index), [draft.expr, index]);
  const problems = useMemo(() => localProblems(tokens), [tokens]);
  const suggestions = useMemo<Completion[]>(() => (acOpen ? completions(draft.expr, cursor, index) : []), [acOpen, draft.expr, cursor, index]);

  const keyError = !keyed
    ? null
    : !draft.key.trim()
    ? 'Key is required.'
    : draft.key.length > KEY_MAX
    ? `At most ${KEY_MAX} characters.`
    : siblingKeys.includes(draft.key)
    ? 'Another field in this object already uses this key.'
    : null;

  // Debounced in-context validation + preview.
  useEffect(() => {
    if (!open) return;
    if (!draft.expr.trim()) {
      setCheck({ pending: false, errors: [], value: undefined, valueError: null, ran: false, failure: null });
      return;
    }
    const ctrl = new AbortController();
    setCheck((c) => ({ ...c, pending: true }));
    const t = window.setTimeout(async () => {
      const spec = buildSpec(draft);
      const [v, p] = await Promise.allSettled([validateSpec(spec, modelId, ctrl.signal), previewSpec(spec, { sessionId, modelId }, ctrl.signal)]);
      if (ctrl.signal.aborted) return;
      const errors = v.status === 'fulfilled' ? v.value.errors.filter((e) => e.nodeId === nodeId) : [];
      const field = p.status === 'fulfilled' ? p.value.fields.find((f) => f.nodeId === nodeId) : undefined;
      const runtime = p.status === 'fulfilled' ? p.value.errors.find((e) => e.nodeId === nodeId) : undefined;
      const failure =
        v.status === 'rejected' && !isNotFound(v.reason) ? errorText(v.reason, 'Validation failed.') : p.status === 'rejected' && !isNotFound(p.reason) ? errorText(p.reason, 'Preview failed.') : null;
      setCheck({
        pending: false,
        errors,
        value: field ? field.value : undefined,
        valueError: field?.error || runtime?.message || null,
        ran: v.status === 'fulfilled' || p.status === 'fulfilled',
        failure,
      });
    }, 500);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft.expr, draft.valueType, nodeId, modelId]);

  const serverError = check.errors.find((e) => e.severity !== 'warning');
  const errorRange = serverError && serverError.pos !== undefined ? { pos: serverError.pos, end: serverError.end ?? serverError.pos + 1 } : null;
  const blocking = Boolean(keyError) || !draft.expr.trim() || Boolean(serverError);

  const setExpr = (expr: string, caret?: number) => {
    setDraft((d) => ({ ...d, expr }));
    const pos = caret ?? expr.length;
    setCursor(pos);
    window.requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const insertAtCursor = (text: string) => {
    const ta = taRef.current;
    const start = ta ? ta.selectionStart : cursor;
    const end = ta ? ta.selectionEnd : cursor;
    const next = draft.expr.slice(0, start) + text + draft.expr.slice(end);
    setExpr(next, start + text.length);
  };

  const accept = (c: Completion) => {
    // After a resource name, continue straight to its signal keys / attributes.
    const insert = c.kind === 'resource' && draft.expr[cursor] !== '.' ? `${c.insert}.` : c.insert;
    const next = draft.expr.slice(0, c.from) + insert + draft.expr.slice(cursor);
    const caret = c.from + insert.length;
    setExpr(next, caret);
    // Keep the list open while the reference is still being built.
    setAcOpen(c.insert.endsWith('[') || c.kind === 'resource' || c.kind === 'type');
    setAcIndex(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (acOpen && suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(suggestions[Math.min(acIndex, suggestions.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setAcOpen(false);
        return;
      }
    }
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      setAcOpen(true);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!blocking) onApply(draft);
    }
  };

  const fnList = functions.filter((f) => !fnQuery || f.name.includes(fnQuery.toLowerCase()) || f.description.toLowerCase().includes(fnQuery.toLowerCase()));
  const groups = Array.from(new Set(fnList.map((f) => f.group)));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      escapeCloses={!(acOpen && suggestions.length > 0) && !examplesOpen}
      width="xl"
      title="Rule"
      subtitle="An expression evaluated at every sample. Type $ to reference data, Ctrl+Space for suggestions, Ctrl+Enter to apply."
      footer={
        <>
          <span className="mr-auto text-[11px] text-[#657794]">Runtime errors (e.g. division by zero) output null for this field only.</span>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={blocking} onClick={() => onApply(draft)} title={blocking ? 'Fix the errors first' : undefined}>
            Apply rule
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        <div className="space-y-3 min-w-0">
          <div className="flex flex-wrap items-end gap-3">
            {keyed && (
              <label className="flex-1 min-w-[180px]">
                <span className="block text-[11px] font-semibold text-[#334568] mb-1">Key</span>
                <input
                  value={draft.key}
                  onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
                  aria-invalid={Boolean(keyError)}
                  className={`w-full h-8 px-2 border rounded-lg font-mono text-[12px] focus:outline-none focus:border-blue-500 ${keyError ? 'border-red-400' : 'border-[#D4DFEC]'}`}
                />
              </label>
            )}
            <label>
              <span className="block text-[11px] font-semibold text-[#334568] mb-1">Output type</span>
              <select
                value={draft.valueType}
                onChange={(e) => setDraft((d) => ({ ...d, valueType: e.target.value as ValueType }))}
                className="h-8 px-2 border border-[#D4DFEC] rounded-lg text-[12px] bg-white"
              >
                {VALUE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <div className="relative">
              <Button variant="outline" size="sm" onClick={() => setExamplesOpen((v) => !v)} aria-expanded={examplesOpen} aria-haspopup="menu">
                Examples <ChevronDown className="w-3 h-3" />
              </Button>
              {examplesOpen && (
                <div role="menu" className="absolute right-0 top-full mt-1 z-20 min-w-[260px] bg-white border border-[#D4DFEC] rounded-xl shadow-xl py-1">
                  {RULE_EXAMPLES.map((ex) => (
                    <button
                      key={ex.label}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setExamplesOpen(false);
                        setDraft((d) => ({ ...d, valueType: ex.valueType && d.valueType === 'auto' ? ex.valueType : d.valueType }));
                        setExpr(ex.build(exampleRefs));
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-[#F8FAFC] text-[12px]"
                    >
                      <div className="font-semibold text-[#111B37]">{ex.label}</div>
                      <div className="font-mono text-[10px] text-[#657794] truncate">{ex.build(exampleRefs)}</div>
                    </button>
                  ))}
                  {serverExamples.filter((ex) => !/\$machine\[M1\]|#/.test(ex.expr)).map((ex) => (
                    <button
                      key={`s-${ex.label}`}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setExamplesOpen(false);
                        setExpr(ex.expr);
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-[#F8FAFC] text-[12px]"
                    >
                      <div className="font-semibold text-[#111B37]">{ex.label}</div>
                      <div className="font-mono text-[10px] text-[#657794] truncate">{ex.expr}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {keyError && <p className="text-[11px] text-red-700">{keyError}</p>}

          <div>
            <div className="flex items-stretch border border-[#D4DFEC] rounded-lg bg-white focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100 overflow-hidden">
              {keyed && (
                <span className="px-2.5 py-2 font-mono text-[12px] text-[#657794] bg-[#F8FAFC] border-r border-[#E2E8F0] whitespace-nowrap select-none" aria-hidden="true">
                  {draft.key || 'key'} =
                </span>
              )}
              <div className="relative flex-1 min-w-0">
                <pre
                  ref={preRef}
                  aria-hidden="true"
                  className="absolute inset-0 m-0 px-2.5 py-2 [font-variant-ligatures:none] font-mono text-[12px] leading-[1.6] whitespace-pre-wrap break-all overflow-hidden pointer-events-none text-[#111B37]"
                >
                  {highlight(tokens, errorRange)}
                  {'\n'}
                </pre>
                <textarea
                  ref={taRef}
                  data-autofocus
                  value={draft.expr}
                  spellCheck={false}
                  rows={Math.min(8, Math.max(2, draft.expr.split('\n').length + 1))}
                  aria-label={`Expression${keyed ? ` for ${draft.key}` : ''}`}
                  aria-autocomplete="list"
                  aria-expanded={acOpen && suggestions.length > 0}
                  aria-invalid={problems.length > 0 || Boolean(serverError)}
                  onChange={(e) => {
                    const value = e.target.value;
                    const pos = e.target.selectionStart;
                    setDraft((d) => ({ ...d, expr: value }));
                    setCursor(pos);
                    const typed = value.slice(0, pos);
                    if (/\$[^\s()+*/%,<>=!]*$/.test(typed) || /\[[^\]]*$/.test(typed.slice(typed.lastIndexOf('$')))) {
                      setAcOpen(true);
                      setAcIndex(0);
                    } else if (/[A-Za-z_]{2,}$/.test(typed)) {
                      setAcOpen(true);
                      setAcIndex(0);
                    } else setAcOpen(false);
                  }}
                  onSelect={(e) => setCursor((e.target as HTMLTextAreaElement).selectionStart)}
                  onScroll={(e) => {
                    if (preRef.current) preRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
                  }}
                  onKeyDown={onKeyDown}
                  onBlur={() => window.setTimeout(() => setAcOpen(false), 150)}
                  className="relative w-full px-2.5 py-2 [font-variant-ligatures:none] font-mono text-[12px] leading-[1.6] bg-transparent text-transparent caret-[#111B37] resize-y outline-none whitespace-pre-wrap break-all"
                />
              </div>
            </div>
            {acOpen && suggestions.length > 0 && (
              <ul role="listbox" aria-label="Suggestions" className="mt-1 max-h-56 overflow-y-auto border border-[#D4DFEC] rounded-lg bg-white shadow-lg py-1">
                {suggestions.map((s, i) => (
                  <li
                    key={`${s.kind}-${s.insert}-${i}`}
                    role="option"
                    aria-selected={i === acIndex}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      accept(s);
                    }}
                    onMouseEnter={() => setAcIndex(i)}
                    className={`px-2.5 py-1 flex items-center gap-2 cursor-pointer text-[12px] ${i === acIndex ? 'bg-blue-50' : ''}`}
                  >
                    <span
                      className={`text-[9px] font-bold uppercase w-14 shrink-0 ${
                        s.kind === 'signal' ? 'text-blue-700' : s.kind === 'attr' ? 'text-purple-700' : s.kind === 'func' ? 'text-cyan-700' : 'text-slate-500'
                      }`}
                    >
                      {s.kind === 'resource' ? 'name' : s.kind}
                    </span>
                    <span className="font-mono text-[#111B37] truncate">{s.label}</span>
                    {s.detail && <span className="text-[11px] text-[#657794] truncate">{s.detail}</span>}
                    {s.value !== undefined && <span className="ml-auto font-mono text-[11px] text-[#334568] truncate max-w-[35%]">{formatValue(s.value)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1.5" aria-live="polite">
            {!(acOpen && suggestions.length > 0) && problems.map((p) => (
              <p key={p} className="flex items-start gap-1.5 text-[11px] text-red-700">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> {p}
              </p>
            ))}
            {check.errors.map((e, i) => (
              <div key={`${e.code}-${i}`} className={`text-[11px] ${e.severity === 'warning' ? 'text-amber-800' : 'text-red-700'}`}>
                <p className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> {e.message}
                </p>
                {e.suggestions && e.suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1 ml-5">
                    <span className="text-[#657794]">Did you mean</span>
                    {e.suggestions.map((sug) => (
                      <button
                        key={sug}
                        type="button"
                        onClick={() => {
                          if (e.pos !== undefined && e.end !== undefined) setExpr(draft.expr.slice(0, e.pos) + sug + draft.expr.slice(e.end), e.pos + sug.length);
                          else insertAtCursor(sug);
                        }}
                        className="font-mono px-1.5 rounded bg-blue-50 border border-blue-100 text-blue-800 hover:bg-blue-100"
                      >
                        {sug}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {check.failure && <p className="text-[11px] text-amber-800">{check.failure}</p>}
          </div>

          <div className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-[#334568]">
              Result preview
              {check.pending && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
              {!check.pending && check.ran && !serverError && !check.valueError && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
            </div>
            <div className="mt-1 font-mono text-[12px] text-[#111B37] break-all">
              {!draft.expr.trim() ? (
                <span className="text-slate-400">Type an expression.</span>
              ) : check.valueError ? (
                <span className="text-red-700">null · {check.valueError}</span>
              ) : check.value !== undefined ? (
                formatValue(check.value === null ? null : check.value)
              ) : check.ran ? (
                <span className="text-slate-400">null</span>
              ) : (
                <span className="text-slate-400">Evaluated against the current data once the rule is valid.</span>
              )}
            </div>
          </div>
        </div>

        <aside className="border border-[#E2E8F0] rounded-xl p-2.5 bg-white min-h-0 flex flex-col max-h-[60vh]" aria-label="Functions">
          <div className="flex items-center gap-1.5 text-[12px] font-bold text-[#111B37] mb-2">
            <BookOpen className="w-3.5 h-3.5" /> Functions
          </div>
          <div className="relative mb-2">
            <Search className="w-3 h-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={fnQuery}
              onChange={(e) => setFnQuery(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter functions"
              className="w-full h-7 pl-6 pr-2 border border-[#D4DFEC] rounded-md text-[11px] focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="overflow-y-auto flex-1 space-y-2 pr-1">
            <div className="text-[10px] text-[#657794] leading-relaxed">
              Operators: <code>+ - * / // % **</code>, <code>== != &lt; &lt;= &gt; &gt;=</code>, <code>and or not</code>, <code>a if cond else b</code>. Null in arithmetic gives null.
            </div>
            {groups.map((g) => (
              <div key={g}>
                <div className="text-[10px] font-bold uppercase tracking-wide text-[#657794] mb-1">{FUNCTION_GROUP_LABEL[g] || g}</div>
                {fnList
                  .filter((f) => f.group === g)
                  .map((f) => (
                    <button
                      key={f.name}
                      type="button"
                      onClick={() => insertAtCursor(`${f.name}(`)}
                      title={`${f.description}\nExample: ${f.example}`}
                      className="w-full text-left px-1.5 py-1 rounded hover:bg-[#F1F5FA]"
                    >
                      <div className="font-mono text-[11px] text-[#0E7490] font-semibold">{f.signature}</div>
                      <div className="text-[10px] text-[#657794] leading-snug">{f.description}</div>
                    </button>
                  ))}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </Dialog>
  );
};
