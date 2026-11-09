import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ActionToast, useActionToast } from '../../components/common/ActionToast';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { once } from '../../lib/useSubmit';
import { deleteModel, errorText, setRunning } from './api';
import { DuplicateDialog, DuplicateToMachinesDialog } from './DuplicateDialogs';
import { useModelList } from './hooks';
import { CardActions, ModelCatalog } from './ModelCatalog';
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
  const [dupMachines, setDupMachines] = useState<ModelListItem | null>(null);
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
    duplicateToMachines: setDupMachines,
    toggleRunning: (m) => void toggleRunning(m),
    remove: (m) => {
      setDeleteError(null);
      setToDelete(m);
    },
  };

  const summary = list.models.find((m) => m.id === modelParam) || null;

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
          onDuplicateToMachines={setDupMachines}
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
          busyIds={busyIds}
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
        model={dupMachines}
        onClose={() => setDupMachines(null)}
        onDone={(ids, message) => {
          setDupMachines(null);
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
      <ActionToast toast={toast} onDismiss={dismiss} />
    </div>
  );
};
