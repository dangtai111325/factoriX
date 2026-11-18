import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Activity, Copy, Edit, MoreHorizontal, Plus, Rows3, Settings2 } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Tabs } from '../../components/common/Tabs';
import { MenuButton, MenuItem } from '../../components/common/MenuButton';
import { ActionToast, useActionToast } from '../../components/common/ActionToast';
import { getStorageObject, TDStable, TDSubtable } from '../../lib/storagePhysicalApi';
import { ErrorBanner, LoadingBlock, WizardHeader, cardCls } from '../historian/hsUi';
import { StorageLifecycleDialog, LifecycleTarget, lifecycleTargetOf, isProtectedTarget } from './StorageLifecycleDialog';
import { useStorageBackTarget } from './wizards/WizardShared';
import {
  BindingsList,
  ColumnsTable,
  DdlBlock,
  KIND_LABEL,
  PropGrid,
  StorageObjectData,
  StorageStatusBadge,
  StorageTypeIcon,
  TagsTable,
  historianLinkFor,
  kindOfId,
  propItems,
} from './objectViews';

type DetailTab = 'overview' | 'schema' | 'bindings' | 'ddl';

export const StorageObjectDetailPage: React.FC = () => {
  const { objectId = '' } = useParams<{ objectId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const here = `${location.pathname}${location.search}`;
  const backTarget = useStorageBackTarget('/historian/storage?tab=objects');
  const { toast, show: showToast, dismiss: dismissToast } = useActionToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown | null>(null);
  const [objectData, setObjectData] = useState<StorageObjectData | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [lifecycle, setLifecycle] = useState<LifecycleTarget | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const fetchObject = useCallback(() => {
    if (!objectId) return;
    setLoading(true);
    setError(null);
    getStorageObject(objectId)
      .then((obj) => setObjectData({ ...obj, object_type: kindOfId(objectId) } as StorageObjectData))
      .catch((err) => {
        setError(err);
        setObjectData(null);
      })
      .finally(() => setLoading(false));
  }, [objectId]);

  useEffect(() => {
    fetchObject();
  }, [fetchObject, reloadKey]);

  const kind = objectData?.object_type || kindOfId(objectId);
  const target = lifecycleTargetOf(objectId, objectData?.status);
  const locked = isProtectedTarget(target);
  const ref = objectId.replace(/^(db|stable|subtable):/, '');
  const name = objectData?.physical_name || target.name;
  const go = (to: string) => navigate(to, { state: { from: here } });

  const header = (
    <WizardHeader
      backLabel="Storage Management"
      onBack={() => navigate(backTarget)}
      title={
        <span className="inline-flex items-center gap-2 min-w-0">
          <StorageTypeIcon kind={kind} className="w-5 h-5" />
          <span className="font-mono truncate">{name}</span>
        </span>
      }
      chip={
        <>
          <span className="text-[10px] px-2 py-0.5 rounded bg-[#EFF6FF] text-[#134074] font-bold">{KIND_LABEL[kind]}</span>
          {objectData && <StorageStatusBadge status={objectData.status} />}
          {locked && <span className="text-[11px] text-[#657794]">FactoriX system object · read-only</span>}
        </>
      }
      stepper={
        objectData ? (
          <div className="flex flex-wrap items-center gap-2">
            {kind === 'subtable' && (
              <Button variant="outline" size="md" icon={<Activity className="w-4 h-4" />} onClick={() => navigate(historianLinkFor(objectId))}>
                Open in Historian
              </Button>
            )}
            {!locked && (
              <Button variant="outline" size="md" icon={<Edit className="w-4 h-4" />} onClick={() => go(`/historian/storage/edit/${encodeURIComponent(objectId)}`)}>
                Edit
              </Button>
            )}
            {kind === 'stable' && !locked && (
              <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={() => go(`/historian/storage/create?kind=subtable&stable=${encodeURIComponent(ref)}`)}>
                Create subtable
              </Button>
            )}
            {kind === 'database' && (
              <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={() => go(`/historian/storage/create?kind=stable&database=${encodeURIComponent(name)}`)}>
                Create supertable
              </Button>
            )}
            {!locked && kind !== 'database' && (
              <MenuButton
                label="More"
                icon={<MoreHorizontal className="w-4 h-4" />}
                ariaLabel="More actions"
                items={
                  [
                    kind === 'stable'
                      ? { key: 'bulk', label: 'Subtables from Data Models', icon: <Rows3 className="w-3.5 h-3.5" />, onSelect: () => go(`/historian/storage/bulk?stable=${encodeURIComponent(ref)}`) }
                      : null,
                    { key: 'dup', label: 'Duplicate', icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => go(`/historian/storage/create?kind=${kind}&duplicate=${encodeURIComponent(objectId)}`) },
                    { key: 'life', label: 'Pause / Retire / Delete…', icon: <Settings2 className="w-3.5 h-3.5" />, danger: true, onSelect: () => setLifecycle(target) },
                  ].filter(Boolean) as MenuItem[]
                }
              />
            )}
          </div>
        ) : undefined
      }
    />
  );

  if (loading && !objectData) {
    return (
      <div className="space-y-4">
        {header}
        <LoadingBlock label={`Loading ${name}…`} />
      </div>
    );
  }

  if (error || !objectData) {
    return (
      <div className="space-y-4">
        {header}
        <ErrorBanner error={error || new Error('Storage object not found')} subject={name} onRetry={fetchObject} />
      </div>
    );
  }

  const stableObj = kind === 'stable' ? (objectData as unknown as TDStable) : null;
  const subObj = kind === 'subtable' ? (objectData as unknown as TDSubtable) : null;
  const tabs = [
    { id: 'overview', label: 'Overview' },
    ...(stableObj || subObj ? [{ id: 'schema', label: stableObj ? 'Columns & Tags' : 'Tags' }] : []),
    ...(subObj ? [{ id: 'bindings', label: 'Bindings', count: subObj.bindings?.length ?? 0 }] : []),
    { id: 'ddl', label: 'DDL' },
  ];

  return (
    <div className="space-y-4">
      <ActionToast toast={toast} onDismiss={dismissToast} />
      {header}
      {objectData.description && <p className="text-[13px] text-[#657794] whitespace-pre-wrap">{objectData.description}</p>}
      <Tabs tabs={tabs} activeTab={activeTab} onChange={(id) => setActiveTab(id as DetailTab)} />

      <section className={`${cardCls} p-4 sm:p-5 space-y-4 min-w-0`}>
        {activeTab === 'overview' && <PropGrid items={propItems(objectData)} cols="grid-cols-2 md:grid-cols-4" />}
        {activeTab === 'schema' && stableObj && (
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4">
            <div className="space-y-2 min-w-0">
              <h2 className="text-[14px] font-bold text-[#111B37]">Columns ({stableObj.columns?.length || 0})</h2>
              <ColumnsTable stable={stableObj} />
            </div>
            <div className="space-y-2 min-w-0">
              <h2 className="text-[14px] font-bold text-[#111B37]">Tags ({stableObj.tags?.length || 0})</h2>
              <TagsTable tags={stableObj.tags || []} />
            </div>
          </div>
        )}
        {activeTab === 'schema' && subObj && (
          <div className="space-y-2 max-w-3xl">
            <h2 className="text-[14px] font-bold text-[#111B37]">Tag values</h2>
            <TagsTable tags={subObj.tag_values || []} withValues />
          </div>
        )}
        {activeTab === 'bindings' && subObj && <BindingsList subtable={subObj} />}
        {activeTab === 'ddl' && <DdlBlock obj={objectData} />}
      </section>

      {lifecycle && (
        <StorageLifecycleDialog
          target={lifecycle}
          onClose={() => setLifecycle(null)}
          onDone={(msg) => {
            setLifecycle(null);
            // The page goes away: hand the confirmation to the list page so the toast is not lost (R2-22).
            if (msg.startsWith('Deleted')) navigate(backTarget, { state: { notice: msg } });
            else {
              showToast({ message: msg, tone: 'success' });
              setReloadKey((k) => k + 1);
            }
          }}
        />
      )}
    </div>
  );
};
