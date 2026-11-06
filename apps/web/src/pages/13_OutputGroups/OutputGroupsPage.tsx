import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApp } from '../../store/AppContext';
import { useModels } from './hooks';
import { ModelCatalog } from './ModelCatalog';
import { ModelEditor } from './ModelEditor';
import { TemplateWizard } from './TemplateWizard';

/**
 * Data Models (/models): catalog of output models, template-based bulk creation and the model editor.
 * The open model is kept in the URL (?model=<id> or ?model=new) so it can be linked and survives reloads.
 */
export const OutputGroupsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { resources } = useApp();
  const { models, loading, error, reload } = useModels();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const modelParam = searchParams.get('model');
  const resourceParam = searchParams.get('resource') || undefined;

  const openModel = useCallback(
    (id: string | null, message?: string) => {
      setFlash(message || null);
      const next = new URLSearchParams(searchParams);
      next.delete('tab');
      if (id) next.set('model', id);
      else next.delete('model');
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  return (
    <div className="space-y-6">
      {modelParam ? (
        <ModelEditor
          key={modelParam}
          modelId={modelParam}
          resources={resources}
          initialResourceId={resourceParam}
          flash={flash}
          onBack={() => openModel(null)}
          onChanged={() => void reload()}
          onOpen={(id, message) => openModel(id, message)}
        />
      ) : (
        <ModelCatalog
          models={models}
          loading={loading}
          error={error}
          onReload={() => void reload()}
          resources={resources}
          onOpen={(id) => openModel(id)}
          onNew={() => openModel('new')}
          onFromTemplate={() => setWizardOpen(true)}
        />
      )}

      <TemplateWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onCreated={() => void reload()} resources={resources} />
    </div>
  );
};
