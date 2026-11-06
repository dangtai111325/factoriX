import React, { useEffect, useMemo, useState } from 'react';
import type { ResourceNode } from '../../types';
import { Button } from '../../components/common/Button';
import type { MemberRow, ModelKind, ModelListItem, ResourceSignal } from './types';
import { JsonMappingResult, MODEL_KEY_RE, mapSampleJson, parentPathLabel } from './modelLogic';
import { duplicateModel, errorText } from './modelApi';
import { Banner, Modal } from './ui';

// ---------------------------------------------------------------- paste sample JSON

export const PasteJsonDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  signals: ResourceSignal[];
  kind: ModelKind;
  hasRows: boolean;
  onApply: (rows: MemberRow[], mode: 'replace' | 'append') => void;
}> = ({ open, onClose, signals, kind, hasRows, onApply }) => {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'replace' | 'append'>('replace');

  useEffect(() => {
    if (open) setMode(hasRows ? 'replace' : 'append');
  }, [open, hasRows]);

  const result = useMemo((): { ok: JsonMappingResult | null; error: string | null } => {
    if (!text.trim()) return { ok: null, error: null };
    try {
      return { ok: mapSampleJson(text, signals, kind), error: null };
    } catch (e) {
      return { ok: null, error: e instanceof Error ? e.message : 'Invalid JSON.' };
    }
  }, [text, signals, kind]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="lg"
      title="Paste a sample body"
      subtitle="Each key becomes a field in the same order. Keys are matched to this resource's signals by key; zone_name / line_name / machine_name become context fields and source_timestamp / publish_timestamp become system fields."
      footer={
        <>
          {hasRows && (
            <div className="flex items-center gap-3 mr-auto text-[12px] text-[#334568]">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace current fields
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={mode === 'append'} onChange={() => setMode('append')} /> Append
              </label>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!result.ok}
            onClick={() => {
              if (!result.ok) return;
              onApply(result.ok.rows, mode);
              setText('');
              onClose();
            }}
          >
            Create {result.ok ? result.ok.rows.length : ''} fields
          </Button>
        </>
      }
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={12}
        placeholder={'{\n  "zone_name": "…",\n  "source_timestamp": "…",\n  "status": 1\n}'}
        className="w-full p-3 border border-slate-300 rounded-lg font-mono text-[12px] focus:outline-none focus:border-blue-500"
      />
      <div className="mt-3 space-y-2">
        {result.error && <Banner tone="error">{result.error}</Banner>}
        {result.ok && (
          <Banner tone={result.ok.unmatched.length ? 'warning' : 'success'}>
            {result.ok.rows.length} fields: {result.ok.matched} matched to signals, {result.ok.context} context, {result.ok.system} system
            {result.ok.unmatched.length > 0 && (
              <>
                , {result.ok.unmatched.length} without a matching signal (kept as rows to map manually):{' '}
                <span className="font-mono">{result.ok.unmatched.join(', ')}</span>
              </>
            )}
            .
          </Banner>
        )}
        {signals.length === 0 && (
          <Banner tone="info">This resource has no active signals, so no signal can be matched yet. Rows are still created.</Banner>
        )}
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------- duplicate to another resource

export const DuplicateDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  modelId: string;
  modelName: string;
  /** Key of the source model; prefilled as the key of the copy. */
  modelKey: string;
  sourceResource: ResourceNode | undefined;
  resources: ResourceNode[];
  /** Existing (non-archived) models, used to disable targets that already use the key. */
  existing: ModelListItem[];
  onDone: (newId: string, missingKeys: string[]) => void;
}> = ({ open, onClose, modelId, modelName, modelKey, sourceResource, resources, existing, onDone }) => {
  const [target, setTarget] = useState('');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedKey = key.trim();
  const keyError = !trimmedKey
    ? 'Enter a key.'
    : !MODEL_KEY_RE.test(trimmedKey)
      ? 'Use 1–64 letters, digits, "_", "-" or ".", starting with a letter or digit.'
      : null;

  /** resourceId -> keys of the models that already exist on it. */
  const keysByResource = useMemo(() => {
    const map = new Map<string, Set<string>>();
    existing.forEach((m) => {
      if (m.status === 'ARCHIVED') return;
      const set = map.get(m.resource_id) || new Set<string>();
      set.add(m.key);
      map.set(m.resource_id, set);
    });
    return map;
  }, [existing]);

  const candidates = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return resources
      .filter((r) => r.id !== sourceResource?.id && (!sourceResource || r.type === sourceResource.type))
      .map((r) => ({ r, path: parentPathLabel(resources, r.id) }))
      .filter(({ r, path }) => !needle || `${r.name} ${r.code} ${path}`.toLowerCase().includes(needle))
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path, undefined, { numeric: true }) || a.r.name.localeCompare(b.r.name, undefined, { numeric: true }),
      );
  }, [resources, sourceResource, filter]);

  const takenOn = (resourceId: string) => Boolean(trimmedKey && keysByResource.get(resourceId)?.has(trimmedKey));
  const available = candidates.filter(({ r }) => !takenOn(r.id)).length;

  useEffect(() => {
    if (!open) return;
    setTarget('');
    setKey(modelKey);
    setName('');
    setNameTouched(false);
    setFilter('');
    setError(null);
  }, [open, modelKey]);

  const suggestName = (targetId: string) => {
    const t = resources.find((r) => r.id === targetId);
    if (!t) return modelName;
    if (sourceResource?.name && modelName.includes(sourceResource.name)) return modelName.split(sourceResource.name).join(t.name);
    return `${t.name} ${modelName}`;
  };

  const targetTaken = Boolean(target && takenOn(target));
  const canSubmit = Boolean(target) && !keyError && !targetTaken && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await duplicateModel(modelId, target, { displayName: name.trim() || undefined, key: trimmedKey });
      if (res.id) onDone(res.id, res.missingKeys);
      else if (res.missingKeys.length)
        setError(
          `Not duplicated: the target resource has no active signal with key ${res.missingKeys.map((k) => `"${k}"`).join(', ')}. Create those signals (same keys) first.`,
        );
      else setError('The server did not return the new model.');
    } catch (err) {
      setError(errorText(err, 'Could not duplicate the model.'));
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'w-full h-9 px-2.5 border rounded text-[13px] focus:outline-none focus:border-blue-500';

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="md"
      title="Duplicate to another resource"
      subtitle="Creates a draft copy on the chosen resource. Signal fields are re-matched by signal key on that resource."
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} loading={busy} onClick={() => void submit()}>
            Duplicate
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}
        <div>
          <label htmlFor="dup-key" className="block text-[11px] font-semibold uppercase text-[#657794] mb-1">
            Key of the copy
          </label>
          <input
            id="dup-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            spellCheck={false}
            aria-invalid={Boolean(keyError)}
            aria-describedby="dup-key-hint"
            className={`${inputCls} font-mono ${keyError ? 'border-red-400' : 'border-slate-300'}`}
          />
          <p id="dup-key-hint" className={`text-[11px] mt-1 ${keyError ? 'text-red-600' : 'text-[#657794]'}`}>
            {keyError || 'Unique per resource. Change it to add a second model of the same kind to a resource.'}
          </p>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <span id="dup-target-label" className="block text-[11px] font-semibold uppercase text-[#657794]">
              Target resource
            </span>
            {candidates.length > 0 && (
              <span className="text-[11px] text-[#657794]">
                {available} of {candidates.length} available
              </span>
            )}
          </div>
          {candidates.length === 0 && !filter ? (
            <p className="text-[12px] text-[#657794]">No other resource of the same type exists.</p>
          ) : (
            <>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by name, code or path"
                aria-label="Filter target resources"
                className={`${inputCls} border-slate-300 mb-1.5`}
              />
              <div
                role="radiogroup"
                aria-labelledby="dup-target-label"
                className="max-h-60 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100"
              >
                {candidates.length === 0 && <p className="p-3 text-[12px] text-[#657794]">No resource matches the filter.</p>}
                {candidates.map(({ r, path }) => {
                  const taken = takenOn(r.id);
                  const on = target === r.id;
                  return (
                    <label
                      key={r.id}
                      className={`flex items-start gap-2 px-3 py-2 text-[12px] ${
                        taken ? 'bg-slate-50 cursor-not-allowed' : on ? 'bg-blue-50/60 cursor-pointer' : 'hover:bg-slate-50 cursor-pointer'
                      }`}
                      title={taken ? `Already has a model with key '${trimmedKey}'` : undefined}
                    >
                      <input
                        type="radio"
                        name="dup-target"
                        className="mt-0.5"
                        checked={on}
                        disabled={taken}
                        onChange={() => {
                          setTarget(r.id);
                          if (!nameTouched) setName(suggestName(r.id));
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className={`block font-semibold truncate ${taken ? 'text-slate-400' : 'text-[#111B37]'}`} title={r.name}>
                          {r.name}
                        </span>
                        {path && (
                          <span className={`block text-[10px] truncate ${taken ? 'text-slate-400' : 'text-[#657794]'}`} title={path}>
                            {path}
                          </span>
                        )}
                      </span>
                      {taken && (
                        <span className="text-[10px] font-semibold text-amber-800 whitespace-nowrap">Already has a model with key '{trimmedKey}'</span>
                      )}
                    </label>
                  );
                })}
              </div>
            </>
          )}
          {targetTaken && (
            <p className="text-[11px] text-red-600 mt-1">
              The selected resource already has a model with key '{trimmedKey}'. Change the key or choose another resource.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="dup-name" className="block text-[11px] font-semibold uppercase text-[#657794] mb-1">
            New model name
          </label>
          <input
            id="dup-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            placeholder={modelName}
            className={`${inputCls} border-slate-300`}
          />
        </div>
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------- save as template

export const SaveTemplateDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  defaultName: string;
  onSave: (name: string) => Promise<void>;
}> = ({ open, onClose, defaultName, onSave }) => {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(defaultName);
      setError(null);
    }
  }, [open, defaultName]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      width="md"
      title="Save as template"
      subtitle="Stores the field order, kinds and signal keys (not the signals themselves) so the same body can be created for other resources."
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onSave(name.trim());
                onClose();
              } catch (err) {
                setError(errorText(err, 'Could not save the template.'));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save template
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}
        <label className="block text-[11px] font-semibold uppercase text-[#657794] mb-1">Template name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full h-9 px-2.5 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500"
        />
      </div>
    </Modal>
  );
};
