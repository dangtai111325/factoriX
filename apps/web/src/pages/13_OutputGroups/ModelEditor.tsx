import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  Calculator,
  CheckCircle2,
  Copy,
  Eye,
  LayoutTemplate,
  Lock,
  MoreHorizontal,
  Rocket,
  Save,
  Settings2,
  Undo2,
} from 'lucide-react';
import type { ResourceNode } from '../../types';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { MemberRow, ModelDetail, ModelKind, ModelListItem, memberToRow, rowToMember } from './types';
import {
  archiveModel,
  createModel,
  createTemplate,
  errorText,
  getModel,
  isMembersUnresolved,
  isVersionConflict,
  publishModel,
  unpublishModel,
  updateModel,
} from './modelApi';
import { useResourceSignals } from './hooks';
import {
  DEFAULT_TOPIC,
  TOPIC_TOKENS,
  modelKeyFromName,
  MAX_REPUBLISH_SEC,
  parentPathLabel,
  republishLabel,
  resolveTopicPreview,
  standardHeaderRows,
  validateModel,
} from './modelLogic';
import { FieldsEditor } from './FieldsEditor';
import { PreviewPanel } from './PreviewPanel';
import { DuplicateDialog, PasteJsonDialog, SaveTemplateDialog } from './dialogs';
import { Banner, KindBadge, ModelStatusBadge } from './ui';

interface Props {
  modelId: string; // 'new' for a new model
  resources: ResourceNode[];
  /** Catalog rows (non-archived), used by "Duplicate to…" to flag targets that already use a key. */
  models: ModelListItem[];
  initialResourceId?: string;
  onBack: () => void;
  onChanged: () => void; // reload the catalog
  onOpen: (id: string, flash?: string) => void;
  flash?: string | null;
}

interface FormState {
  name: string;
  resourceId: string;
  topic: string;
  kind: ModelKind;
  republishSec: string;
  rows: MemberRow[];
}

const snapshotOf = (f: FormState) =>
  JSON.stringify({ ...f, rows: f.rows.map(({ uid: _uid, ...rest }) => rest) });

function formFromDetail(d: ModelDetail): FormState {
  return {
    name: d.display_name || d.key,
    resourceId: d.resource_id,
    topic: d.topic_template || DEFAULT_TOPIC,
    kind: d.kind,
    republishSec: d.emit_policy.republish_ms ? String(Math.round(d.emit_policy.republish_ms / 1000)) : '',
    rows: d.members.map(memberToRow),
  };
}

type Confirm = null | 'publish' | 'unpublish' | 'archive' | 'discard';

export const ModelEditor: React.FC<Props> = ({ modelId, resources, models, initialResourceId, onBack, onChanged, onOpen, flash }) => {
  const isNew = modelId === 'new';
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => newForm(resources, initialResourceId));
  const [baseline, setBaseline] = useState<string>(() => snapshotOf(newForm(resources, initialResourceId)));
  const [tab, setTab] = useState<'design' | 'preview'>('design');
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'publish' | 'unpublish' | 'archive'>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error' | 'warning'; text: string; conflict?: boolean } | null>(
    flash ? { tone: 'warning', text: flash } : null,
  );
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [previewToken, setPreviewToken] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // Resources may arrive after mount: give a new model a default scope once they do.
  useEffect(() => {
    if (!isNew || form.resourceId || resources.length === 0) return;
    const f = newForm(resources, initialResourceId);
    if (!f.resourceId) return;
    setForm((cur) => ({ ...cur, resourceId: f.resourceId }));
    setBaseline((b) => {
      const parsed = JSON.parse(b) as Record<string, unknown>;
      return JSON.stringify({ ...parsed, resourceId: f.resourceId });
    });
  }, [isNew, form.resourceId, resources, initialResourceId]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const load = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    try {
      const d = await getModel(modelId);
      const f = formFromDetail(d);
      setDetail(d);
      setForm(f);
      setBaseline(snapshotOf(f));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, 'Could not load this model.'));
    } finally {
      setLoading(false);
    }
  }, [isNew, modelId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenuOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menuOpen]);

  const { signals, latest, loading: signalsLoading, error: signalsError, signalIds } = useResourceSignals(form.resourceId, tab === 'design');
  const signalKeyById = useMemo(() => new Map(signals.map((s) => [s.id, s.key])), [signals]);

  // New model: when the scope changes, re-match signal rows by key on the new resource.
  const lastMatchedFor = useRef<string>('');
  useEffect(() => {
    if (!isNew || !signalIds || lastMatchedFor.current === form.resourceId) return;
    lastMatchedFor.current = form.resourceId;
    const byKey = new Map(signals.map((s) => [s.key.toLowerCase(), s]));
    setForm((f) => ({
      ...f,
      rows: f.rows.map((r) => {
        if ((r.kind !== 'signal' && r.kind !== 'snapshot') || (r.signalId && signalIds.has(r.signalId))) return r;
        const key = (r.signalKey || r.alias).toLowerCase();
        const hit = byKey.get(key);
        return { ...r, signalId: hit ? hit.id : '', signalKey: hit ? hit.key : r.signalKey || r.alias };
      }),
    }));
  }, [isNew, signalIds, signals, form.resourceId]);

  const dirty = snapshotOf(form) !== baseline;
  const validation = useMemo(
    () =>
      validateModel({
        name: form.name,
        resourceId: form.resourceId,
        topic: form.topic,
        kind: form.kind,
        republishSec: form.republishSec,
        rows: form.rows,
        signalIds,
        resources,
      }),
    [form, signalIds, resources],
  );

  const resource = resources.find((r) => r.id === form.resourceId);
  const scopeOptions = useMemo(
    () =>
      resources
        .map((r) => ({ r, path: parentPathLabel(resources, r.id) }))
        .sort((a, b) => a.path.localeCompare(b.path) || a.r.name.localeCompare(b.r.name)),
    [resources],
  );
  const groupKey = detail?.key || modelKeyFromName(form.name);
  const topicPreview = resolveTopicPreview(resources, form.resourceId, form.topic, groupKey);
  const status = detail?.status ?? 'DRAFT';
  const republishSecNum = Number(form.republishSec);
  const republishPreviewMs =
    form.republishSec.trim() && Number.isFinite(republishSecNum) && republishSecNum >= 1 && republishSecNum <= MAX_REPUBLISH_SEC
      ? Math.round(republishSecNum * 1000)
      : null;
  const errorCount = Object.keys(validation.form).length + Object.values(validation.rows).reduce((n, l) => n + l.length, 0);

  const payload = () => ({
    display_name: form.name.trim(),
    topic_template: form.topic.trim(),
    kind: form.kind,
    emit_policy: { republish_ms: form.kind === 'STATE' && form.republishSec.trim() ? Math.round(Number(form.republishSec) * 1000) : null },
    members: form.rows.map((r) => rowToMember(r, form.kind, signalKeyById)),
  });

  const save = async () => {
    setShowErrors(true);
    setNotice(null);
    if (!validation.ok) {
      setNotice({ tone: 'error', text: `Fix ${errorCount} issue${errorCount === 1 ? '' : 's'} before saving.` });
      setTab('design');
      return;
    }
    setBusy('save');
    try {
      if (isNew) {
        const res = await createModel({ ...payload(), resource_id: form.resourceId, key: modelKeyFromName(form.name) });
        setBaseline(snapshotOf(form));
        onChanged();
        onOpen(res.id);
        return;
      }
      if (!detail) return;
      const updated = await updateModel(modelId, { ...payload(), version: detail.version });
      const d = updated || (await getModel(modelId));
      const f = formFromDetail(d);
      setDetail(d);
      setForm(f);
      setBaseline(snapshotOf(f));
      setShowErrors(false);
      setPreviewToken((t) => t + 1);
      setNotice({ tone: 'success', text: 'Model saved.' });
      onChanged();
    } catch (err) {
      if (isVersionConflict(err))
        setNotice({ tone: 'warning', text: 'Someone else changed this model since you opened it. Reload to get the latest version (your edits will be lost).', conflict: true });
      else if (isMembersUnresolved(err)) setNotice({ tone: 'error', text: unresolvedText(err) });
      else setNotice({ tone: 'error', text: errorText(err, 'Save failed.') });
    } finally {
      setBusy(null);
    }
  };

  const runAction = async (action: 'publish' | 'unpublish' | 'archive') => {
    setConfirm(null);
    if (!detail) return;
    setBusy(action);
    setNotice(null);
    try {
      if (action === 'archive') {
        await archiveModel(detail.id);
        onChanged();
        onBack();
        return;
      }
      if (action === 'publish') await publishModel(detail.id, detail.version);
      else await unpublishModel(detail.id, detail.version);
      await load();
      setPreviewToken((t) => t + 1);
      onChanged();
      setNotice({ tone: 'success', text: action === 'publish' ? 'Model published. Bodies are emitted when member signals change.' : 'Model unpublished. It no longer emits bodies.' });
    } catch (err) {
      if (isVersionConflict(err))
        setNotice({ tone: 'warning', text: 'This model changed elsewhere. Reload and try again.', conflict: true });
      else if (isMembersUnresolved(err)) setNotice({ tone: 'error', text: unresolvedText(err) });
      else setNotice({ tone: 'error', text: errorText(err, `Could not ${action} the model.`) });
    } finally {
      setBusy(null);
    }
  };

  const saveTemplate = async (name: string) => {
    const members = form.rows.map((r) => {
      const m = rowToMember(r, form.kind, signalKeyById);
      return { ...m, signal_id: undefined };
    });
    await createTemplate({
      key: modelKeyFromName(name),
      display_name: name,
      kind: form.kind,
      topic_template: form.topic.trim(),
      emit_policy: payload().emit_policy,
      members,
    });
    setNotice({ tone: 'success', text: `Template "${name}" saved. Use "New from template" in the catalog to apply it.` });
  };

  // The shared api client keeps only message/code, so name the rows we know cannot resolve.
  const unresolvedText = (err: unknown) => {
    const rows = form.rows.filter((r) => (r.kind === 'signal' || r.kind === 'snapshot') && (!r.signalId || (signalIds && !signalIds.has(r.signalId))));
    const list = rows.map((r) => r.signalKey || r.alias).filter(Boolean);
    return `${errorText(err)}${list.length ? ` Unresolved: ${list.join(', ')}.` : ''} A signal may have been archived or re-keyed; reopen the model to reload its signals.`;
  };

  const goBack = () => (dirty ? setConfirm('discard') : onBack());

  if (loading) return <div className="p-12 text-center text-[12px] text-[#657794]">Loading model…</div>;
  if (loadError)
    return (
      <div className="space-y-3">
        <Button variant="outline" size="sm" onClick={onBack} icon={<ArrowLeft className="w-3.5 h-3.5" />}>
          All models
        </Button>
        <Banner tone="error" action={<Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      </div>
    );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-slate-200">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="outline" size="sm" onClick={goBack} icon={<ArrowLeft className="w-3.5 h-3.5" />}>
            All models
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[18px] font-bold text-[#111B37] truncate">{form.name || 'New model'}</h2>
              <KindBadge kind={form.kind} />
              <ModelStatusBadge status={isNew ? 'NEW' : status} />
              {dirty && !isNew && <span className="text-[11px] font-semibold text-amber-700">Unsaved changes</span>}
            </div>
            <div className="text-[11px] text-[#657794] truncate">
              {resource ? `${resource.name}${parentPathLabel(resources, resource.id) ? ` · ${parentPathLabel(resources, resource.id)}` : ''}` : detail?.resource_name || ''}
              {detail && <span className="font-mono"> · {detail.key} · v{detail.version}</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {dirty && !isNew && (
            <Button variant="ghost" size="sm" onClick={() => detail && (setForm(formFromDetail(detail)), setShowErrors(false))} icon={<Undo2 className="w-3.5 h-3.5" />}>
              Discard
            </Button>
          )}
          {!isNew &&
            (status === 'PUBLISHED' ? (
              <Button variant="outline" size="sm" loading={busy === 'unpublish'} disabled={!!busy} onClick={() => setConfirm('unpublish')}>
                Unpublish
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                loading={busy === 'publish'}
                disabled={!!busy || dirty || !validation.ok}
                title={dirty ? 'Save your changes before publishing' : !validation.ok ? 'Fix validation issues first' : undefined}
                onClick={() => setConfirm('publish')}
                icon={<Rocket className="w-3.5 h-3.5" />}
              >
                Publish
              </Button>
            ))}
          <Button
            variant="primary"
            size="sm"
            loading={busy === 'save'}
            disabled={!!busy || (!dirty && !isNew)}
            title={!busy && !dirty && !isNew ? 'No unsaved changes' : undefined}
            onClick={() => void save()}
            icon={<Save className="w-3.5 h-3.5" />}
          >
            {isNew ? 'Create model' : 'Save'}
          </Button>
          {!isNew && (
            <div className="relative" ref={menuRef}>
              <Button variant="icon" size="sm" aria-label="More actions" onClick={() => setMenuOpen((o) => !o)}>
                <MoreHorizontal className="w-4 h-4" />
              </Button>
              {menuOpen && (
                <div className="absolute right-0 z-30 mt-1 w-56 bg-white border border-slate-300 rounded-lg shadow-xl py-1 text-[12px]">
                  <MenuItem icon={<Copy className="w-3.5 h-3.5" />} onClick={() => (setMenuOpen(false), dirty ? setNotice({ tone: 'warning', text: 'Save or discard your changes before duplicating.' }) : setDupOpen(true))}>
                    Duplicate to another resource…
                  </MenuItem>
                  <MenuItem icon={<LayoutTemplate className="w-3.5 h-3.5" />} onClick={() => (setMenuOpen(false), setTplOpen(true))}>
                    Save as template…
                  </MenuItem>
                  <div className="my-1 border-t border-slate-100" />
                  <MenuItem danger icon={<Archive className="w-3.5 h-3.5" />} onClick={() => (setMenuOpen(false), setConfirm('archive'))}>
                    Archive model
                  </MenuItem>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {notice && (
        <Banner
          tone={notice.tone}
          onClose={() => setNotice(null)}
          action={
            notice.conflict ? (
              <Button size="sm" variant="outline" onClick={() => (setNotice(null), void load())}>
                Reload latest
              </Button>
            ) : undefined
          }
        >
          {notice.tone === 'success' && <CheckCircle2 className="inline w-3.5 h-3.5 mr-1" />}
          {notice.text}
        </Banner>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200">
        <TabButton active={tab === 'design'} onClick={() => setTab('design')} icon={<Settings2 className="w-3.5 h-3.5" />}>
          Design
          {showErrors && errorCount > 0 && <span className="ml-1 px-1.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold">{errorCount}</span>}
        </TabButton>
        <TabButton active={tab === 'preview'} disabled={isNew} title={isNew ? 'Create the model first' : undefined} onClick={() => setTab('preview')} icon={<Eye className="w-3.5 h-3.5" />}>
          Live preview{form.kind === 'EVENT' ? ' & events' : ''}
        </TabButton>
        <TabButton active={false} disabled title="Calculations are coming soon" onClick={() => undefined} icon={<Calculator className="w-3.5 h-3.5" />}>
          Calculations
          <span className="ml-1 text-[10px] font-normal px-1.5 bg-slate-100 rounded text-slate-500">Soon</span>
        </TabButton>
      </div>

      {tab === 'design' && (
        <div className="space-y-4">
          <Card className="p-5 border border-[#CBD5E1] bg-white space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Model name" required error={showErrors ? validation.form.name : undefined}>
                <input
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="e.g. Line 1 machine state"
                  className={`w-full h-9 px-3 border rounded text-[13px] focus:outline-none focus:border-blue-500 ${
                    showErrors && validation.form.name ? 'border-red-400' : 'border-slate-300'
                  }`}
                />
                {isNew && form.name.trim() && <p className="text-[11px] text-[#657794] mt-1">Key: <span className="font-mono">{modelKeyFromName(form.name)}</span></p>}
              </Field>

              <Field
                label="Scope (resource)"
                required
                error={showErrors ? validation.form.scope : undefined}
                hint={isNew ? 'Signal fields can only use signals of this resource.' : undefined}
              >
                {isNew ? (
                  <select
                    value={form.resourceId}
                    onChange={(e) => set('resourceId', e.target.value)}
                    className="w-full h-9 px-2.5 border border-slate-300 rounded text-[13px] bg-white focus:outline-none focus:border-blue-500"
                  >
                    <option value="">Choose a resource…</option>
                    {scopeOptions.map(({ r, path }) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.type}){path ? ` — ${path}` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-9 px-3 flex items-center gap-2 border border-slate-200 bg-slate-50 rounded text-[13px] text-[#334568] min-w-0">
                      <Lock className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      <span className="truncate">{resource?.name || detail?.resource_name || 'Unknown resource'}</span>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => (dirty ? setNotice({ tone: 'warning', text: 'Save or discard your changes before duplicating.' }) : setDupOpen(true))}>
                      Duplicate to…
                    </Button>
                  </div>
                )}
              </Field>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Model kind" hint={form.kind === 'STATE' ? 'Emits the latest body whenever a contributing value changes.' : 'Emits one body per trigger (e.g. each completed part) and keeps a history.'}>
                <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
                  {(['STATE', 'EVENT'] as ModelKind[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => set('kind', k)}
                      className={`px-4 h-9 text-[12px] font-semibold ${form.kind === k ? 'bg-[#111B37] text-white' : 'bg-white text-[#334568] hover:bg-slate-50'}`}
                    >
                      {k === 'STATE' ? 'State' : 'Event'}
                    </button>
                  ))}
                </div>
                {showErrors && validation.form.trigger && <p className="text-[11px] text-red-600 mt-1">{validation.form.trigger}</p>}
              </Field>
              {form.kind === 'STATE' && (
                <Field
                  label="Re-publish when unchanged"
                  error={showErrors ? validation.form.republish : undefined}
                  hint={
                    republishPreviewMs
                      ? `${republishLabel(republishPreviewMs, form.kind)}. Re-published bodies keep source_timestamp and get a new publish_timestamp. Leave empty to emit only on change.`
                      : `${republishLabel(null, form.kind)}. Enter seconds to re-send the last body periodically while nothing changes.`
                  }
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      value={form.republishSec}
                      onChange={(e) => set('republishSec', e.target.value)}
                      placeholder="Off"
                      className="w-32 h-9 px-3 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500"
                    />
                    <span className="text-[12px] text-[#657794]">seconds</span>
                  </div>
                </Field>
              )}
            </div>

            <div className="pt-3 border-t border-slate-100">
              <Field label="Topic template" required error={showErrors || form.topic ? validation.form.topic : undefined}>
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  {TOPIC_TOKENS.map((tok) => (
                    <button
                      key={tok}
                      type="button"
                      onClick={() => set('topic', form.topic && !form.topic.endsWith('/') ? `${form.topic}/{${tok}}` : `${form.topic}{${tok}}`)}
                      className="px-2 py-0.5 rounded text-[11px] font-mono bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200"
                    >
                      +{`{${tok}}`}
                    </button>
                  ))}
                </div>
                <input
                  value={form.topic}
                  onChange={(e) => set('topic', e.target.value)}
                  spellCheck={false}
                  className={`w-full h-9 px-3 border rounded font-mono text-[12px] focus:outline-none focus:border-blue-500 ${
                    validation.form.topic && (showErrors || form.topic) ? 'border-red-400' : 'border-slate-300'
                  }`}
                />
                <div className="mt-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded text-[11px] flex flex-wrap items-center gap-2">
                  <span className="text-[#657794]">Resolves to approximately</span>
                  <span className="font-mono text-[#111B37] font-semibold break-all">{topicPreview}</span>
                </div>
              </Field>
            </div>
          </Card>

          <Card className="p-5 border border-[#CBD5E1] bg-white space-y-3">
            {signalsError && <Banner tone="error">{signalsError}</Banner>}
            {showErrors &&
              ['rows', 'sourceTs'].map((k) =>
                validation.form[k] ? (
                  <Banner key={k} tone="error">
                    {validation.form[k]}
                  </Banner>
                ) : null,
              )}
            {validation.formWarnings.map((w) => (
              <Banner key={w} tone="warning">
                {w}
              </Banner>
            ))}
            <FieldsEditor
              rows={form.rows}
              onChange={(rows) => set('rows', rows)}
              modelKind={form.kind}
              resourceId={form.resourceId}
              resources={resources}
              signals={signals}
              latest={latest}
              signalsLoading={signalsLoading}
              rowErrors={validation.rows}
              rowWarnings={validation.rowWarnings}
              showErrors={showErrors}
              onPasteJson={() => setPasteOpen(true)}
            />
          </Card>
        </div>
      )}

      {tab === 'preview' && detail && (
        <Card className="p-5 border border-[#CBD5E1] bg-white">
          <PreviewPanel modelId={detail.id} kind={detail.kind} status={detail.status} dirty={dirty} refreshToken={previewToken} />
        </Card>
      )}

      <PasteJsonDialog
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        signals={signals}
        kind={form.kind}
        hasRows={form.rows.length > 0}
        onApply={(rows, mode) => set('rows', mode === 'replace' ? rows : [...form.rows, ...rows])}
      />
      {detail && (
        <DuplicateDialog
          open={dupOpen}
          onClose={() => setDupOpen(false)}
          modelId={detail.id}
          modelName={detail.display_name}
          modelKey={detail.key}
          sourceResource={resource}
          resources={resources}
          existing={models}
          onDone={(id, missing) => {
            setDupOpen(false);
            onChanged();
            onOpen(
              id,
              missing.length
                ? `Duplicated as a draft. No matching signal on the target for: ${missing.join(', ')}. Map these fields before publishing.`
                : undefined,
            );
          }}
        />
      )}
      <SaveTemplateDialog open={tplOpen} onClose={() => setTplOpen(false)} defaultName={form.name} onSave={saveTemplate} />

      <ConfirmDialog
        isOpen={confirm === 'publish'}
        variant="primary"
        title={`Publish "${form.name}"?`}
        message="The model starts emitting bodies on its topic whenever a contributing signal changes."
        confirmLabel="Publish"
        onConfirm={() => void runAction('publish')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        isOpen={confirm === 'unpublish'}
        variant="warning"
        title={`Unpublish "${form.name}"?`}
        message="Consumers stop receiving bodies from this model. You can publish it again at any time."
        confirmLabel="Unpublish"
        onConfirm={() => void runAction('unpublish')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        isOpen={confirm === 'archive'}
        variant="danger"
        title={`Archive "${form.name}"?`}
        message="The model stops publishing and is removed from the catalog. Its key on this resource becomes available again."
        confirmLabel="Archive"
        onConfirm={() => void runAction('archive')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        isOpen={confirm === 'discard'}
        variant="warning"
        title="Leave without saving?"
        message="Your unsaved changes to this model will be lost."
        confirmLabel="Discard changes"
        onConfirm={() => (setConfirm(null), onBack())}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
};

function newForm(resources: ResourceNode[], initialResourceId?: string): FormState {
  const resourceId = initialResourceId || resources.find((r) => r.type === 'machine')?.id || '';
  return {
    name: '',
    resourceId,
    topic: DEFAULT_TOPIC,
    kind: 'STATE',
    republishSec: '',
    rows: standardHeaderRows(true),
  };
}

const Field: React.FC<{ label: string; required?: boolean; error?: string; hint?: string; children: React.ReactNode }> = ({
  label,
  required,
  error,
  hint,
  children,
}) => (
  <div>
    <label className="block text-[11px] font-semibold uppercase text-[#657794] mb-1">
      {label}
      {required && <span className="text-[#EF1B24]">*</span>}
    </label>
    {children}
    {error ? <p className="text-[11px] text-red-600 mt-1">{error}</p> : hint ? <p className="text-[11px] text-[#657794] mt-1">{hint}</p> : null}
  </div>
);

const TabButton: React.FC<{
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}> = ({ active, disabled, title, onClick, icon, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px transition ${
      active ? 'border-[#EF1B24] text-[#111B37]' : disabled ? 'border-transparent text-slate-300 cursor-not-allowed' : 'border-transparent text-[#657794] hover:text-[#111B37]'
    }`}
  >
    {icon}
    {children}
  </button>
);

const MenuItem: React.FC<{ icon: React.ReactNode; onClick: () => void; danger?: boolean; children: React.ReactNode }> = ({ icon, onClick, danger, children }) => (
  <button type="button" onClick={onClick} className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 ${danger ? 'text-red-700' : 'text-[#111B37]'}`}>
    {icon}
    {children}
  </button>
);
