import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ActionToast, useActionToast } from '../../components/common/ActionToast';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { once } from '../../lib/useSubmit';
import { deleteModel, errorText, setRunning } from './api';
import { DuplicateDialog, DuplicateToMachinesDialog } from './DuplicateDialogs';
import { useModelList } from './hooks';
import { BulkActions, CardActions, ModelCatalog } from './ModelCatalog';
import { ModelView } from './ModelView';
import type { ModelListItem } from './types';
import { ModelWizard } from './wizard/ModelWizard';

/**
 * Data Models (/models): catalog of cards, model view (?model=<id>) and the create / edit wizard
 * (?edit=new | ?edit=<id>). The URL keeps the open screen so it can be linked and survives reloads.
 */
export const DataModelsPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const list = useModelList();
  const { toast, show, dismiss } = useActionToast();
  const [dup, setDup] = useState<ModelListItem | null>(null);
  const [dupMachines, setDupMachines] = useState<ModelListItem[] | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [bulkOp, setBulkOp] = useState<{ kind: 'pause' | 'resume' | 'delete'; models: ModelListItem[] } | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ModelListItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [refreshToken, setRefreshToken] = useState(0);

  const editParam = params.get('edit');
  const modelParam = params.get('model');

  const go = useCallback(
    (next: { model?: string | null; edit?: string | null }) => {
      const p = new URLSearchParams(params);
      p.delete('model');
      p.delete('edit');
      if (next.model) p.set('model', next.model);
      if (next.edit) p.set('edit', next.edit);
      setParams(p);
    },
    [params, setParams],
  );

  const toggleRunning = async (m: ModelListItem) => {
    if (busyIds.has(m.id)) return;
    setBusyIds((s) => new Set(s).add(m.id));
    const resume = m.state !== 'RUNNING';
    try {
      // `once` keeps a double click (card menu + header button) to a single request.
      await once(`dm-run:${m.id}`, () => setRunning(m.id, resume));
      list.setModels((prev) => prev.map((x) => (x.id === m.id ? { ...x, state: resume ? 'RUNNING' : 'PAUSED' } : x)));
      setRefreshToken((n) => n + 1);
      show({ message: `${resume ? 'Resumed' : 'Paused'} “${m.name}”.`, tone: 'success' });
    } catch (err) {
      show({ message: errorText(err, `Could not ${resume ? 'resume' : 'pause'} the model.`), tone: 'error' });
    } finally {
      setBusyIds((s) => {
        const n = new Set(s);
        n.delete(m.id);
        return n;
      });
    }
  };

  const actions: CardActions = {
    open: (m) => go({ model: m.id }),
    edit: (m) => go({ edit: m.id }),
    duplicate: setDup,
    duplicateToMachines: (m) => setDupMachines([m]),
    toggleRunning: (m) => void toggleRunning(m),
    remove: (m) => {
      setDeleteError(null);
      setToDelete(m);
    },
  };

  const summary = list.models.find((m) => m.id === modelParam) || null;

  // UX#4: bulk Pause / Resume / Delete on the selected cards, after a confirmation with the count.
  const bulk: BulkActions = {
    pause: (models) => {
      setBulkError(null);
      setBulkOp({ kind: 'pause', models: models.filter((m) => m.state === 'RUNNING') });
    },
    resume: (models) => {
      setBulkError(null);
      setBulkOp({ kind: 'resume', models: models.filter((m) => m.state !== 'RUNNING') });
    },
    remove: (models) => {
      setBulkError(null);
      setBulkOp({ kind: 'delete', models });
    },
    duplicateToMachines: (models) => setDupMachines(models),
  };

  const runBulk = async () => {
    if (!bulkOp) return;
    const { kind, models } = bulkOp;
    const failed: string[] = [];
    let done = 0;
    await Promise.all(
      models.map(async (m) => {
        try {
          if (kind === 'delete') await once(`dm-del:${m.id}`, () => deleteModel(m.id));
          else await once(`dm-run:${m.id}`, () => setRunning(m.id, kind === 'resume'));
          done += 1;
        } catch (err) {
          failed.push(`${m.name}: ${errorText(err, 'failed')}`);
        }
      }),
    );
    const ids = new Set(models.map((m) => m.id));
    if (kind === 'delete') list.setModels((prev) => prev.filter((m) => !ids.has(m.id) || failed.some((f) => f.startsWith(`${m.name}:`))));
    else list.setModels((prev) => prev.map((m) => (ids.has(m.id) && !failed.some((f) => f.startsWith(`${m.name}:`)) ? { ...m, state: kind === 'resume' ? 'RUNNING' : 'PAUSED' } : m)));
    void list.reload(true);
    setRefreshToken((n) => n + 1);
    const verb = kind === 'delete' ? 'Deleted' : kind === 'pause' ? 'Paused' : 'Resumed';
    if (failed.length) {
      setBulkError(`${verb} ${done} of ${models.length}. Failed: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? ' …' : ''}`);
      return;
    }
    setBulkOp(null);
    setSelection(new Set());
    show({ message: `${verb} ${done} model${done === 1 ? '' : 's'}.`, tone: 'success' });
  };

  return (
    <div className="space-y-6">
      {editParam ? (
        <ModelWizard
          key={editParam}
          modelId={editParam === 'new' ? null : editParam}
          models={list.models}
          onCancel={() => go(editParam !== 'new' ? { model: editParam } : {})}
          onSaved={(id, message) => {
            void list.reload(true);
            setRefreshToken((n) => n + 1);
            show({ message, tone: 'success' });
            go({ model: id });
          }}
        />
      ) : modelParam ? (
        <ModelView
          key={modelParam}
          modelId={modelParam}
          summary={summary}
          refreshToken={refreshToken}
          busy={busyIds.has(modelParam)}
          onBack={() => go({})}
          onEdit={() => go({ edit: modelParam })}
          onDuplicate={setDup}
          onDuplicateToMachines={(m) => setDupMachines([m])}
          onToggleRunning={(m) => void toggleRunning(m)}
          onDelete={actions.remove}
        />
      ) : (
        <ModelCatalog
          models={list.models}
          loading={list.loading}
          loaded={list.loaded}
          error={list.error}
          onReload={() => void list.reload()}
          onCreate={() => go({ edit: 'new' })}
          actions={actions}
          bulk={bulk}
          busyIds={busyIds}
          selection={selection}
          onSelection={setSelection}
        />
      )}

      <DuplicateDialog
        model={dup}
        models={list.models}
        onClose={() => setDup(null)}
        onDone={(id, message) => {
          setDup(null);
          void list.reload(true);
          show({ message, tone: 'success' });
          if (id) go({ model: id });
        }}
      />
      <DuplicateToMachinesDialog
        models={dupMachines}
        onClose={() => setDupMachines(null)}
        onDone={(ids, message) => {
          setDupMachines(null);
          setSelection(new Set());
          void list.reload(true);
          if (ids.length) show({ message, tone: 'success' });
          if (ids.length) go({});
        }}
      />
      <ConfirmDialog
        isOpen={Boolean(toDelete)}
        title={`Delete “${toDelete?.name || ''}”?`}
        message="The model stops sampling and leaves the catalog. Its recent snapshots are discarded. Signals and machines are not affected."
        confirmLabel="Delete model"
        busyLabel="Deleting…"
        error={deleteError}
        onCancel={() => setToDelete(null)}
        onConfirm={async () => {
          if (!toDelete) return;
          setDeleteError(null);
          try {
            await once(`dm-del:${toDelete.id}`, () => deleteModel(toDelete.id));
            const name = toDelete.name;
            const id = toDelete.id;
            setToDelete(null);
            list.setModels((prev) => prev.filter((m) => m.id !== id));
            void list.reload(true);
            show({ message: `Deleted “${name}”.`, tone: 'success' });
            if (modelParam === id || editParam === id) go({});
          } catch (err) {
            setDeleteError(errorText(err, 'Could not delete the model.'));
          }
        }}
      />
      <ConfirmDialog
        isOpen={Boolean(bulkOp)}
        title={
          !bulkOp
            ? ''
            : bulkOp.kind === 'delete'
            ? `Delete ${bulkOp.models.length} data model${bulkOp.models.length === 1 ? '' : 's'}?`
            : bulkOp.kind === 'pause'
            ? `Pause ${bulkOp.models.length} data model${bulkOp.models.length === 1 ? '' : 's'}?`
            : `Resume ${bulkOp.models.length} data model${bulkOp.models.length === 1 ? '' : 's'}?`
        }
        message={
          !bulkOp
            ? ''
            : bulkOp.models.length === 0
            ? `None of the selected models can be ${bulkOp.kind === 'pause' ? 'paused (all are paused already)' : 'resumed (all are running already)'}.`
            : bulkOp.kind === 'delete'
            ? 'They stop sampling and leave the catalog. Their recent snapshots are discarded. Signals and machines are not affected.'
            : bulkOp.kind === 'pause'
            ? 'They stop producing bodies until resumed. Their definitions are kept.'
            : 'They start sampling again at their own rate.'
        }
        confirmLabel={bulkOp ? `${bulkOp.kind === 'delete' ? 'Delete' : bulkOp.kind === 'pause' ? 'Pause' : 'Resume'} ${bulkOp.models.length}` : ''}
        busyLabel={bulkOp?.kind === 'delete' ? 'Deleting…' : 'Working…'}
        variant={bulkOp?.kind === 'delete' ? 'danger' : 'primary'}
        confirmDisabled={!bulkOp || bulkOp.models.length === 0}
        error={bulkError}
        onCancel={() => setBulkOp(null)}
        onConfirm={runBulk}
      >
        {bulkOp && bulkOp.models.length > 0 && (
          <ul className="mt-2 max-h-40 overflow-y-auto text-[12px] text-[#334568] list-disc ml-5">
            {bulkOp.models.slice(0, 12).map((m) => (
              <li key={m.id}>{m.name}</li>
            ))}
            {bulkOp.models.length > 12 && <li className="list-none text-[#657794]">… and {bulkOp.models.length - 12} more</li>}
          </ul>
        )}
      </ConfirmDialog>
      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
};
