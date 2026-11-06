import React, { useEffect, useMemo, useState } from 'react';
import type { ResourceNode } from '../../types';
import { Button } from '../../components/common/Button';
import type { MemberRow, ModelKind, ResourceSignal } from './types';
import { JsonMappingResult, mapSampleJson, parentPathLabel } from './modelLogic';
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
  sourceResource: ResourceNode | undefined;
  resources: ResourceNode[];
  onDone: (newId: string, missingKeys: string[]) => void;
}> = ({ open, onClose, modelId, modelName, sourceResource, resources, onDone }) => {
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(
    () =>
      resources
        .filter((r) => r.id !== sourceResource?.id && (!sourceResource || r.type === sourceResource.type))
        .map((r) => ({ r, path: parentPathLabel(resources, r.id) }))
        .sort((a, b) => a.path.localeCompare(b.path) || a.r.name.localeCompare(b.r.name)),
    [resources, sourceResource],
  );

  useEffect(() => {
    if (!open) return;
    setTarget('');
    setName('');
    setNameTouched(false);
    setError(null);
  }, [open]);

  const suggestName = (targetId: string) => {
    const t = resources.find((r) => r.id === targetId);
    if (!t) return modelName;
    if (sourceResource?.name && modelName.includes(sourceResource.name)) return modelName.split(sourceResource.name).join(t.name);
    return `${t.name} ${modelName}`;
  };

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await duplicateModel(modelId, target, name.trim() || undefined);
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
          <Button size="sm" disabled={!target} loading={busy} onClick={() => void submit()}>
            Duplicate
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Banner tone="error">{error}</Banner>}
        <div>
          <label className="block text-[11px] font-semibold uppercase text-[#657794] mb-1">Target resource</label>
          {candidates.length === 0 ? (
            <p className="text-[12px] text-[#657794]">No other resource of the same type exists.</p>
          ) : (
            <select
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                if (!nameTouched) setName(suggestName(e.target.value));
              }}
              className="w-full h-9 px-2.5 border border-slate-300 rounded text-[13px] bg-white focus:outline-none focus:border-blue-500"
            >
              <option value="">Choose…</option>
              {candidates.map(({ r, path }) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {path ? ` — ${path}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className="block text-[11px] font-semibold uppercase text-[#657794] mb-1">New model name</label>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            placeholder={modelName}
            className="w-full h-9 px-2.5 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500"
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
