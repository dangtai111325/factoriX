/** Studio dialogs: validation issues, publish, version conflict, revisions (view / restore), save as template. */
import React, { useEffect, useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, History, RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from '../../../components/common/Button';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { Dialog, timeAgo } from '../../13_DataModels/ui';
import { errorLine, getRevision, listRevisions } from '../../../features/dashboard/api';
import { DashboardCanvas } from '../../../features/dashboard/components/DashboardCanvas';
import { normalizeDocument } from '../../../features/dashboard/document';
import { DashboardRuntimeProvider } from '../../../features/dashboard/runtime/RuntimeProvider';
import { resolveTheme } from '../../../features/dashboard/theme';
import type { DashboardDocument, RegistryLimits, RevisionSummary, SourceResource, ThemePreset, ValidationIssue, WidgetTypeDef } from '../../../features/dashboard/types';

// ------------------------------------------------------------------ issues list

export const IssueList: React.FC<{
  issues: ValidationIssue[];
  widgetTitle: (id: string) => string | null;
  onPick?: (issue: ValidationIssue) => void;
}> = ({ issues, widgetTitle, onPick }) => {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity !== 'error');
  if (!issues.length)
    return (
      <p className="flex items-center gap-2 text-[13px] text-emerald-800">
        <CircleCheck className="w-4 h-4" aria-hidden="true" /> No issue found: every widget is valid and every data source resolves.
      </p>
    );
  return (
    <div className="space-y-2">
      <p className="text-[12px] text-[#334568]">
        {errors.length} error{errors.length === 1 ? '' : 's'}
        {warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}
        {errors.length ? ' — errors block publishing.' : ''}
      </p>
      <ul className="space-y-1 max-h-[50vh] overflow-y-auto">
        {[...errors, ...warnings].map((i, k) => {
          const title = i.widget_id ? widgetTitle(i.widget_id) : null;
          const body = (
            <>
              {i.severity === 'error' ? <CircleAlert className="w-4 h-4 text-red-600 shrink-0 mt-px" aria-hidden="true" /> : <TriangleAlert className="w-4 h-4 text-amber-600 shrink-0 mt-px" aria-hidden="true" />}
              <span className="min-w-0">
                {title !== null && i.widget_id && <span className="block text-[11px] font-semibold text-[#111B37]">{title || i.widget_id}</span>}
                <span className="block text-[12px] text-[#334568]">{i.message}</span>
                <span className="block text-[10px] font-mono text-[#94A3B8]">{i.code}</span>
              </span>
            </>
          );
          return (
            <li key={`${i.code}-${i.widget_id || ''}-${i.binding_id || ''}-${k}`}>
              {onPick && i.widget_id ? (
                <button type="button" onClick={() => onPick(i)} className="w-full flex items-start gap-2 p-2 rounded-lg border border-[#E3EAF3] text-left hover:bg-[#F9FAFD] hover:border-[#CBD5E1]" title="Select this widget">
                  {body}
                </button>
              ) : (
                <div className="flex items-start gap-2 p-2 rounded-lg border border-[#E3EAF3]">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export const ValidateDialog: React.FC<{
  open: boolean;
  loading: boolean;
  error: string | null;
  issues: ValidationIssue[];
  widgetTitle: (id: string) => string | null;
  onPick: (i: ValidationIssue) => void;
  onClose: () => void;
  onRerun: () => void;
}> = ({ open, loading, error, issues, widgetTitle, onPick, onClose, onRerun }) => (
  <Dialog
    open={open}
    onClose={onClose}
    title="Validation"
    subtitle="Checks the current draft (including unsaved changes): structure, limits, and that every data source resolves and fits its widget."
    width="md"
    footer={
      <>
        <Button variant="outline" onClick={onRerun} loading={loading}>
          Check again
        </Button>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </>
    }
  >
    {loading ? <p className="text-[13px] text-[#657794]">Checking…</p> : error ? <p className="text-[12px] text-red-700">{error}</p> : <IssueList issues={issues} widgetTitle={widgetTitle} onPick={onPick} />}
  </Dialog>
);

export const PublishDialog: React.FC<{
  open: boolean;
  dirty: boolean;
  checking: boolean;
  checkError: string | null;
  issues: ValidationIssue[];
  widgetCount: number;
  nextRevision: number;
  widgetTitle: (id: string) => string | null;
  onPick: (i: ValidationIssue) => void;
  onClose: () => void;
  onPublish: (note: string) => Promise<void>;
}> = ({ open, dirty, checking, checkError, issues, widgetCount, nextRevision, widgetTitle, onPick, onClose, onPublish }) => {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setNote('');
      setError(null);
    }
  }, [open]);
  const blocked = issues.some((i) => i.severity === 'error') || widgetCount === 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      title={`Publish revision ${nextRevision}`}
      subtitle="Viewers will see this revision. Later edits stay a draft until you publish again; earlier revisions stay available."
      width="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={checking || blocked}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onPublish(note.trim());
              } catch (e) {
                setError(errorLine(e, 'Publishing failed.'));
              } finally {
                setBusy(false);
              }
            }}
          >
            {dirty ? 'Save and publish' : 'Publish'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {widgetCount === 0 && <p className="text-[12px] text-red-700">An empty dashboard cannot be published. Add at least one widget.</p>}
        {checking ? (
          <p className="text-[13px] text-[#657794]">Checking the draft…</p>
        ) : checkError ? (
          <p className="text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">The check failed ({checkError}); the server checks again when you publish.</p>
        ) : (
          <IssueList issues={issues} widgetTitle={widgetTitle} onPick={onPick} />
        )}
        <div>
          <label htmlFor="publish-note" className="block text-[12px] font-semibold text-[#334568] mb-1">
            Note <span className="font-normal text-[#94A3B8]">(optional, shown in the revision history)</span>
          </label>
          <textarea id="publish-note" className="fx-input h-auto min-h-[64px] py-2" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed" />
        </div>
        {error && (
          <p role="alert" className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
};

export const ConflictDialog: React.FC<{
  open: boolean;
  onReload: () => Promise<void>;
  onOverwrite: () => Promise<void>;
  onClose: () => void;
}> = ({ open, onReload, onOverwrite, onClose }) => {
  const [busy, setBusy] = useState<'reload' | 'overwrite' | null>(null);
  const run = async (kind: 'reload' | 'overwrite') => {
    setBusy(kind);
    try {
      await (kind === 'reload' ? onReload() : onOverwrite());
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy !== null}
      title="This dashboard was changed elsewhere"
      subtitle="Someone saved, published or restored it in another tab or session after you opened it. Your changes are not saved yet."
      width="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy !== null}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={() => void run('overwrite')} loading={busy === 'overwrite'} disabled={busy !== null}>
            Overwrite with mine
          </Button>
          <Button variant="primary" onClick={() => void run('reload')} loading={busy === 'reload'} disabled={busy !== null}>
            Reload latest
          </Button>
        </>
      }
    >
      <ul className="text-[12px] text-[#334568] space-y-1.5 list-disc pl-4">
        <li>
          <strong>Reload latest</strong> discards your unsaved changes and opens the newest draft.
        </li>
        <li>
          <strong>Overwrite with mine</strong> saves your version over the other change.
        </li>
      </ul>
    </Dialog>
  );
};

export const RevisionsDialog: React.FC<{
  open: boolean;
  dashboardId: string;
  publishedRevision: number | null;
  defs: Map<string, WidgetTypeDef>;
  limits: RegistryLimits;
  presets: ThemePreset[];
  resources: Map<string, SourceResource>;
  onClose: () => void;
  onRestore: (revision: number) => Promise<void>;
}> = ({ open, dashboardId, publishedRevision, defs, limits, presets, resources, onClose, onRestore }) => {
  const [items, setItems] = useState<RevisionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ revision: number; doc: DashboardDocument | null; error: string | null } | null>(null);
  const [restore, setRestore] = useState<number | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setError(null);
    setViewing(null);
    const ctrl = new AbortController();
    listRevisions(dashboardId, ctrl.signal)
      .then((r) => setItems(r.items || []))
      .catch((e) => !ctrl.signal.aborted && setError(errorLine(e, 'Could not load the revisions.')));
    return () => ctrl.abort();
  }, [open, dashboardId]);

  const view = (revision: number) => {
    setViewing({ revision, doc: null, error: null });
    getRevision(dashboardId, revision)
      .then((r) => setViewing({ revision, doc: normalizeDocument(r.document), error: null }))
      .catch((e) => setViewing({ revision, doc: null, error: errorLine(e, 'Could not load this revision.') }));
  };

  return (
    <>
      <Dialog open={open && !viewing} onClose={onClose} title="Revisions" subtitle="Every publish creates an immutable revision. Restoring copies a revision into the draft." width="md">
        {error ? (
          <p className="text-[12px] text-red-700">{error}</p>
        ) : items === null ? (
          <p className="text-[13px] text-[#657794]">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-[13px] text-[#657794]">Not published yet: revisions appear here after the first publish.</p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((r) => (
              <li key={r.revision} className="flex items-center gap-3 p-2.5 rounded-lg border border-[#E3EAF3]">
                <History className="w-4 h-4 text-[#657794] shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-[#111B37]">
                    Revision {r.revision}
                    {r.revision === publishedRevision && <span className="ml-2 text-[10px] font-bold uppercase text-emerald-700">Published</span>}
                  </div>
                  <div className="text-[11px] text-[#657794] truncate" title={new Date(r.published_at).toLocaleString()}>
                    {timeAgo(r.published_at)}
                    {r.published_by_name || r.published_by ? ` · ${r.published_by_name || r.published_by}` : ''} · {r.widget_count} widget{r.widget_count === 1 ? '' : 's'}
                  </div>
                  {r.note && <div className="text-[11px] text-[#334568] mt-0.5 break-words">{r.note}</div>}
                </div>
                <Button size="sm" variant="outline" onClick={() => view(r.revision)}>
                  View
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  icon={<RotateCcw className="w-3.5 h-3.5" />}
                  onClick={() => {
                    setRestoreError(null);
                    setRestore(r.revision);
                  }}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <Dialog
        open={open && !!viewing}
        onClose={() => setViewing(null)}
        title={`Revision ${viewing?.revision ?? ''}`}
        subtitle="Read-only preview with live data."
        width="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setViewing(null)}>
              Back to revisions
            </Button>
            {viewing && (
              <Button
                variant="primary"
                icon={<RotateCcw className="w-4 h-4" />}
                onClick={() => {
                  setRestoreError(null);
                  setRestore(viewing.revision);
                }}
              >
                Restore to draft
              </Button>
            )}
          </>
        }
      >
        {viewing?.error ? (
          <p className="text-[12px] text-red-700">{viewing.error}</p>
        ) : !viewing?.doc ? (
          <p className="text-[13px] text-[#657794]">Loading…</p>
        ) : (
          <RevisionPreview doc={viewing.doc} defs={defs} limits={limits} presets={presets} resources={resources} />
        )}
      </Dialog>
      <ConfirmDialog
        isOpen={restore !== null}
        title={`Restore revision ${restore ?? ''} to the draft?`}
        message="The draft is replaced by this revision. Unsaved changes in the Studio are lost. The published revision does not change until you publish."
        confirmLabel="Restore"
        busyLabel="Restoring…"
        variant="warning"
        error={restoreError}
        onCancel={() => setRestore(null)}
        onConfirm={async () => {
          if (restore === null) return;
          try {
            await onRestore(restore);
            setRestore(null);
            setViewing(null);
            onClose();
          } catch (e) {
            setRestoreError(errorLine(e, 'Could not restore this revision.'));
          }
        }}
      />
    </>
  );
};

const RevisionPreview: React.FC<{
  doc: DashboardDocument;
  defs: Map<string, WidgetTypeDef>;
  limits: RegistryLimits;
  presets: ThemePreset[];
  resources: Map<string, SourceResource>;
}> = ({ doc, defs, limits, presets, resources }) => {
  const theme = useMemo(() => resolveTheme(doc.settings.theme, presets), [doc.settings.theme, presets]);
  const variables = useMemo(() => Object.fromEntries(doc.variables.map((v) => [v.id, v.default ?? null])), [doc.variables]);
  return (
    <DashboardRuntimeProvider document={doc} timeRange={doc.settings.time_range} variables={variables} defs={defs} limits={limits} theme={theme} resources={resources} mode="view">
      <div className="rounded-xl overflow-hidden border border-[#E3EAF3] max-h-[65vh] overflow-y-auto" style={{ background: theme.canvas }}>
        <DashboardCanvas document={doc} mode="view" onNavigate={() => undefined} empty={<span className="text-[13px]">This revision has no widget.</span>} />
      </div>
    </DashboardRuntimeProvider>
  );
};

export const SaveTemplateDialog: React.FC<{
  open: boolean;
  defaultName: string;
  dirty: boolean;
  onClose: () => void;
  onSave: (name: string, description: string, category: string) => Promise<void>;
}> = ({ open, defaultName, dirty, onClose, onSave }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('custom');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(defaultName.slice(0, 120));
      setDescription('');
      setCategory('custom');
      setError(null);
    }
  }, [open, defaultName]);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim(), description.trim(), category.trim());
    } catch (e) {
      setError(errorLine(e, 'Could not save the template.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      title="Save as template"
      subtitle="The layout, widgets and settings become a template. Every data source becomes a data role that is mapped again when someone creates a dashboard from it."
      width="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!name.trim()}>
            {dirty ? 'Save draft and template' : 'Save template'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div>
          <label htmlFor="tpl-name" className="block text-[12px] font-semibold text-[#334568] mb-1">
            Template name
          </label>
          <input id="tpl-name" className="fx-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="tpl-desc" className="block text-[12px] font-semibold text-[#334568] mb-1">
            Description
          </label>
          <input id="tpl-desc" className="fx-input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label htmlFor="tpl-cat" className="block text-[12px] font-semibold text-[#334568] mb-1">
            Category
          </label>
          <input id="tpl-cat" className="fx-input" value={category} maxLength={40} onChange={(e) => setCategory(e.target.value)} placeholder="custom" />
        </div>
        {error && (
          <p role="alert" className="text-[12px] text-red-700">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
};
