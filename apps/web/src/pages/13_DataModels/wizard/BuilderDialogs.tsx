// "Map all" (auto-mapping) and "Paste JSON" (skeleton + key auto-matching) dialogs of the body builder.
import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardPaste, Wand2 } from 'lucide-react';
import { Button } from '../../../components/common/Button';
import { CatalogIndex, resourceLabel, signalsUnder } from '../rules';
import { BodyNode, CatalogResource, DEPTH_MAX, isContainer } from '../types';
import { EventOption, MapLayout, SkeletonError, SkeletonStats, buildAutoMap, buildSkeleton, contextLevels, detectEventBody, parseSkeleton } from '../spec';
import { Dialog } from '../ui';

function countFields(nodes: BodyNode[]): number {
  return nodes.reduce((n, node) => n + (isContainer(node) ? countFields(node.children) : 1), 0);
}

function outline(nodes: BodyNode[], depth = 0, out: string[] = [], limit = 14): string[] {
  for (const n of nodes) {
    if (out.length >= limit) break;
    out.push(`${'  '.repeat(depth)}${n.key || '[item]'}${isContainer(n) ? (n.type === 'array' ? ' [ ]' : ' { }') : ''}`);
    if (isContainer(n)) outline(n.children, depth + 1, out, limit);
  }
  return out;
}

const LAYOUTS: Array<{ id: MapLayout; title: string; hint: string }> = [
  { id: 'flat', title: 'Flat', hint: 'Keys = signal keys. When two resources share a key, the key is prefixed with the resource name.' },
  { id: 'nested', title: 'Nested by hierarchy', hint: 'One object per child resource, e.g. { "<machine>": { status, … }, … }.' },
  { id: 'grouped', title: 'Grouped by source', hint: 'One object per raw source group (topic / JSON object / connection).' },
];

const DEFAULT_SKIPPED_CONTEXT = new Set(['enterprise', 'site', 'plant']);

export const MapAllDialog: React.FC<{
  resource: CatalogResource | null;
  index: CatalogIndex;
  targetLabel: string;
  onClose: () => void;
  onApply: (nodes: BodyNode[]) => void;
}> = ({ resource, index, targetLabel, onClose, onApply }) => {
  const [layout, setLayout] = useState<MapLayout>('flat');
  const [includeContext, setIncludeContext] = useState(true);
  const [contextTypes, setContextTypes] = useState<string[]>([]);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);

  const levels = useMemo(() => (resource ? contextLevels(index, resource.id) : []), [resource, index]);
  useEffect(() => {
    if (!resource) return;
    // Default: the resource itself and its two nearest ancestors (e.g. zone, line, machine).
    setContextTypes(levels.filter((l) => !DEFAULT_SKIPPED_CONTEXT.has(l.type)).slice(-3).map((l) => l.type));
    const owners = new Set(signalsUnder(index, resource.id).map((s) => s.resourceId));
    setLayout(owners.size > 1 ? 'nested' : 'flat');
  }, [resource, levels, index]);

  const nodes = useMemo(
    () => (resource ? buildAutoMap(index, resource.id, { layout, contextTypes: includeContext ? contextTypes : [], includeTimestamps }) : []),
    [resource, index, layout, includeContext, contextTypes, includeTimestamps],
  );
  const total = resource ? signalsUnder(index, resource.id).length : 0;
  const owners = resource ? new Set(signalsUnder(index, resource.id).map((s) => s.resourceId)).size : 0;
  const perObject = layout !== 'flat' && owners > 1;

  return (
    <Dialog
      open={Boolean(resource)}
      onClose={onClose}
      width="lg"
      title={
        <span className="inline-flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-[#134074]" /> Map all signals under {resourceLabel(resource || undefined)}
        </span>
      }
      subtitle={`${total} signal(s) will be added to ${targetLabel}.`}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!nodes.length} onClick={() => onApply(nodes)} data-autofocus>
            Add {countFields(nodes)} field(s)
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-4">
          <fieldset>
            <legend className="text-[12px] font-bold text-[#111B37] mb-2">Layout</legend>
            <div className="space-y-2">
              {LAYOUTS.map((l) => (
                <label key={l.id} className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer ${layout === l.id ? 'border-blue-500 bg-blue-50/50' : 'border-[#E2E8F0] hover:bg-[#F8FAFC]'}`}>
                  <input type="radio" name="map-layout" checked={layout === l.id} onChange={() => setLayout(l.id)} className="mt-0.5" />
                  <span>
                    <span className="block text-[12px] font-semibold text-[#111B37]">{l.title}</span>
                    <span className="block text-[11px] text-[#657794]">{l.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-2">
            <label className="flex items-center gap-2 text-[12px] font-semibold text-[#111B37]">
              <input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} />
              Include context fields (names of the hierarchy)
            </label>
            {includeContext && (
              <div className="flex flex-wrap gap-1.5 ml-6">
                {levels.map((l) => {
                  const on = contextTypes.includes(l.type);
                  return (
                    <label key={l.type} className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] cursor-pointer ${on ? 'border-blue-300 bg-blue-50 text-blue-900' : 'border-[#E2E8F0] text-[#334568]'}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setContextTypes((prev) => (on ? prev.filter((t) => t !== l.type) : levels.map((x) => x.type).filter((t) => t === l.type || prev.includes(t))))}
                      />
                      <span className="font-mono">{l.type}_name</span>
                      <span className="text-[#657794] truncate max-w-[140px]">= {l.label}</span>
                    </label>
                  );
                })}
              </div>
            )}
            <label className="flex items-start gap-2 text-[12px] font-semibold text-[#111B37]">
              <input type="checkbox" checked={includeTimestamps} onChange={(e) => setIncludeTimestamps(e.target.checked)} className="mt-0.5" />
              <span>
                Add <code className="font-mono">source_timestamp</code> and <code className="font-mono">publish_timestamp</code>
                <span className="block text-[11px] font-normal text-[#657794]">
                  {perObject
                    ? `One source_timestamp per resource object = latest_ts(its own signals) (${owners} resources) · publish_timestamp = now().`
                    : 'source_timestamp = latest_ts(all mapped signals) · publish_timestamp = now().'}{' '}
                  Raw signals with these keys are not mapped again.
                </span>
              </span>
            </label>
          </fieldset>
        </div>
        <div>
          <div className="text-[12px] font-bold text-[#111B37] mb-2">Result</div>
          <pre className="font-mono text-[11px] leading-relaxed bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3 max-h-80 overflow-auto text-[#334568]">
            {outline(nodes).join('\n') || 'Nothing to map.'}
            {countFields(nodes) > 14 ? `\n… ${countFields(nodes)} fields in total` : ''}
          </pre>
        </div>
      </div>
    </Dialog>
  );
};

export const PasteJsonDialog: React.FC<{
  open: boolean;
  index: CatalogIndex;
  targetLabel: string;
  /** Suggested machine scope (e.g. the resource used most by the body). */
  defaultScopeId: string;
  onClose: () => void;
  onApply: (nodes: BodyNode[]) => void;
}> = ({ open, index, targetLabel, defaultScopeId, onClose, onApply }) => {
  const [text, setText] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [recognise, setRecognise] = useState(true);
  // R4-DM-03: event-style is an explicit, optional choice; detection only offers it and pre-fills the keys.
  const [eventOn, setEventOn] = useState(false);
  const [eventKeys, setEventKeys] = useState<EventOption>({ triggers: [], snapshots: [] });

  useEffect(() => {
    if (open) setScopeId(defaultScopeId);
  }, [open, defaultScopeId]);

  const sample = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return parseSkeleton(text);
    } catch {
      return null;
    }
  }, [text]);
  const detected = useMemo(() => (sample && recognise ? detectEventBody(sample, index, scopeId || null) : null), [sample, index, scopeId, recognise]);
  const detectedKey = detected ? `${detected.triggers.join(',')}|${detected.snapshots.join(',')}` : '';
  useEffect(() => {
    setEventKeys(detected || { triggers: [], snapshots: [] });
    if (!detected) setEventOn(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedKey]);
  const toggleEventKey = (kind: keyof EventOption, key: string) =>
    setEventKeys((prev) => ({ ...prev, [kind]: prev[kind].includes(key) ? prev[kind].filter((k) => k !== key) : [...prev[kind], key] }));

  const scopes = useMemo(
    () =>
      index.catalog.resources
        .filter((r) => signalsUnder(index, r.id).length > 0)
        .map((r) => ({ id: r.id, label: `${resourceLabel(r)} (${index.catalog.typeNames[r.type] || r.type})` })),
    [index],
  );

  const parsed = useMemo((): { nodes: BodyNode[]; stats: SkeletonStats } | { error: string } | null => {
    if (!text.trim()) return null;
    try {
      const event = eventOn && eventKeys.triggers.length && eventKeys.snapshots.length ? eventKeys : null;
      return buildSkeleton(parseSkeleton(text), index, scopeId || null, recognise, event);
    } catch (err) {
      return { error: err instanceof SkeletonError || err instanceof Error ? err.message : 'Invalid JSON.' };
    }
  }, [text, index, scopeId, recognise, eventOn, eventKeys]);

  const ok = parsed && 'nodes' in parsed ? parsed : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="lg"
      title={
        <span className="inline-flex items-center gap-2">
          <ClipboardPaste className="w-4 h-4 text-[#134074]" /> Paste JSON
        </span>
      }
      subtitle={`Creates the key skeleton in ${targetLabel} and matches keys to signals of the chosen resource.`}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!ok || !ok.nodes.length}
            onClick={() => {
              if (ok) onApply(ok.nodes);
              setText('');
              setEventOn(false);
            }}
          >
            Create {ok ? ok.stats.fields : 0} field(s)
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="block text-[12px] font-semibold text-[#334568] mb-1">Sample body</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={'{\n  "status": 1,\n  "electrical": { "voltage_1": 230.1 }\n}\n\nA key list such as { "status", "mode" } also works.'}
            className="w-full p-3 font-mono text-[12px] border border-[#D4DFEC] rounded-lg focus:outline-none focus:border-blue-500"
          />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex-1 min-w-[220px]">
            <span className="block text-[12px] font-semibold text-[#334568] mb-1">Match keys to signals of</span>
            <select value={scopeId} onChange={(e) => setScopeId(e.target.value)} className="w-full h-8 px-2 border border-[#D4DFEC] rounded-lg text-[12px] bg-white">
              <option value="">Do not match (skeleton only)</option>
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[12px] text-[#334568] pb-1.5">
            <input type="checkbox" checked={recognise} onChange={(e) => setRecognise(e.target.checked)} />
            Recognise <code className="font-mono">&lt;type&gt;_name</code> and timestamp keys
          </label>
        </div>
        {parsed && 'error' in parsed && (
          <p role="alert" className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5">
            {parsed.error}
          </p>
        )}
        {detected && (
          <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-[12px] text-[#334568] space-y-2">
            <label className="flex items-start gap-2 font-semibold text-[#111B37] cursor-pointer">
              <input type="checkbox" checked={eventOn} onChange={(e) => setEventOn(e.target.checked)} className="mt-0.5" />
              <span>
                This looks like an event body. Snapshot the order context at the event time?
                <span className="block text-[11px] font-normal text-[#657794]">
                  Context keys become <code className="font-mono">value_at(key, ts(trigger))</code> and source_timestamp becomes{' '}
                  <code className="font-mono">latest_ts(triggers)</code>, so an order change right after the event is not reported with it.
                </span>
              </span>
            </label>
            {eventOn && (
              <div className="ml-6 space-y-1.5">
                {(['triggers', 'snapshots'] as const).map((kind) => (
                  <div key={kind} className="flex flex-wrap items-center gap-1.5">
                    <span className="w-32 text-[11px] font-semibold text-[#334568]">{kind === 'triggers' ? 'Event (trigger) keys' : 'Snapshot keys'}</span>
                    {detected[kind].map((k) => {
                      const on = eventKeys[kind].includes(k);
                      return (
                        <label
                          key={k}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-mono cursor-pointer ${on ? 'border-blue-300 bg-white text-blue-900' : 'border-[#E2E8F0] text-[#657794]'}`}
                        >
                          <input type="checkbox" checked={on} onChange={() => toggleEventKey(kind, k)} />
                          {k}
                        </label>
                      );
                    })}
                  </div>
                ))}
                {(!eventKeys.triggers.length || !eventKeys.snapshots.length) && (
                  <p className="text-[11px] text-amber-800">Keep at least one trigger and one snapshot key, or untick the option.</p>
                )}
              </div>
            )}
          </div>
        )}
        {ok && (ok.stats.truncated.length > 0 || ok.stats.emptyKeys > 0) && (
          <div role="alert" className="text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1">
            {ok.stats.truncated.length > 0 && (
              <div>
                The sample is nested deeper than {DEPTH_MAX} levels. Content below <span className="font-mono">{ok.stats.truncated.slice(0, 3).join(', ')}</span>
                {ok.stats.truncated.length > 3 ? ` and ${ok.stats.truncated.length - 3} more` : ''} is not created; those keys become plain fields.
              </div>
            )}
            {ok.stats.emptyKeys > 0 && (
              <div>
                {ok.stats.emptyKeys} empty key{ok.stats.emptyKeys === 1 ? ' was' : 's were'} renamed to <span className="font-mono">field</span>
                {ok.stats.emptyKeys > 1 ? '_N' : ''}. Rename {ok.stats.emptyKeys === 1 ? 'it' : 'them'} after creating.
              </div>
            )}
          </div>
        )}
        {ok && (
          <div className="text-[12px] text-[#334568] bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3 space-y-1">
            <div>
              <strong>{ok.stats.fields}</strong> field(s): <strong className="text-emerald-700">{ok.stats.matched}</strong> matched to signals,{' '}
              <strong>{ok.stats.context}</strong> context, <strong>{ok.stats.timestamps}</strong> timestamp rule(s)
              {ok.stats.snapshots > 0 && (
                <>
                  , <strong>{ok.stats.snapshots}</strong> snapshot rule(s)
                </>
              )}
              .
            </div>
            {ok.stats.unmatched.length > 0 && (
              <div className="text-amber-800">
                Not matched ({ok.stats.unmatched.length}): <span className="font-mono">{ok.stats.unmatched.slice(0, 20).join(', ')}</span>
                {ok.stats.unmatched.length > 20 ? ' …' : ''}. Pick a signal for each in the data tree after creating.
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
};
