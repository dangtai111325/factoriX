import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Activity, Edit, ExternalLink, Plus, Settings2 } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Tabs } from '../../components/common/Tabs';
import type { TDStable, TDSubtable } from '../../lib/storagePhysicalApi';
import { ErrorBanner, LoadingBlock, SideDrawer } from '../historian/hsUi';
import { StorageLifecycleDialog, LifecycleTarget, isProtectedTarget, lifecycleTargetOf } from './StorageLifecycleDialog';
import {
  BindingsList,
  ColumnsTable,
  DdlBlock,
  KIND_LABEL,
  PropGrid,
  StorageObjectData,
  StorageTypeIcon,
  TagsTable,
  historianLinkFor,
  kindOfId,
  propItems,
} from './objectViews';

interface StorageObjectDrawerProps {
  /** Canonical id: db:<name> | stable:<db>.<name> | subtable:<db>.<name>. */
  objectId: string;
  object: StorageObjectData | null;
  error?: unknown;
  onRetry?: () => void;
  onClose: () => void;
  onRefresh?: () => void;
  onNotice?: (message: string) => void;
}

type DrawerTab = 'overview' | 'columns' | 'bindings' | 'ddl';

/** Object details in the shared side drawer (under the top bar, Esc closes) — Connections drawer pattern. */
export const StorageObjectDrawer: React.FC<StorageObjectDrawerProps> = ({ objectId, object, error, onRetry, onClose, onRefresh, onNotice }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const from = `${location.pathname}${location.search}`;
  const [tab, setTab] = useState<DrawerTab>('overview');
  const [lifecycle, setLifecycle] = useState<LifecycleTarget | null>(null);
  useEffect(() => setTab('overview'), [objectId]);

  const kind = object?.object_type || kindOfId(objectId);
  const target = lifecycleTargetOf(objectId, object?.status);
  const locked = isProtectedTarget(target);
  const ref = objectId.replace(/^(db|stable|subtable):/, '');
  const name = object?.physical_name || target.name;
  const stableObj = kind === 'stable' && object ? (object as unknown as TDStable) : null;
  const subObj = kind === 'subtable' && object ? (object as unknown as TDSubtable) : null;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    ...(stableObj || subObj ? [{ id: 'columns', label: stableObj ? 'Columns & Tags' : 'Tags' }] : []),
    ...(subObj ? [{ id: 'bindings', label: 'Bindings', count: subObj.bindings?.length ?? 0 }] : []),
    { id: 'ddl', label: 'DDL' },
  ];

  return (
    <>
      <SideDrawer
        open
        onClose={onClose}
        ariaLabel={`${KIND_LABEL[kind]} ${name}`}
        eyebrow={
          <>
            <StorageTypeIcon kind={kind} />
            <span className="text-[10px] px-2 py-0.5 rounded bg-[#EFF6FF] text-[#134074] font-bold whitespace-nowrap">{KIND_LABEL[kind]}</span>
            {locked && <span className="text-[10px] px-2 py-0.5 rounded bg-[#F1F5FA] text-[#657794] font-bold whitespace-nowrap">System · read-only</span>}
          </>
        }
        title={<span className="font-mono break-all">{name}</span>}
        subtitle={object && 'database_name' in object && kind !== 'database' ? <span className="break-all">{(object as TDStable).database_name}</span> : undefined}
        actions={
          <>
            <Button size="sm" variant="outline" icon={<ExternalLink className="w-3.5 h-3.5" />} onClick={() => navigate(`/historian/storage/object/${encodeURIComponent(objectId)}`, { state: { from } })}>
              Open page
            </Button>
            {!locked && (
              <Button size="sm" variant="outline" icon={<Edit className="w-3.5 h-3.5" />} onClick={() => navigate(`/historian/storage/edit/${encodeURIComponent(objectId)}`, { state: { from } })}>
                Edit
              </Button>
            )}
            {!locked && kind !== 'database' && (
              <Button size="sm" variant="outline" icon={<Settings2 className="w-3.5 h-3.5" />} onClick={() => setLifecycle(target)}>
                Manage…
              </Button>
            )}
            {kind === 'subtable' && (
              <Button size="sm" variant="primary" icon={<Activity className="w-3.5 h-3.5" />} onClick={() => navigate(historianLinkFor(objectId))}>
                Open in Historian
              </Button>
            )}
            {kind === 'stable' && !locked && (
              <Button size="sm" variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => navigate(`/historian/storage/create?kind=subtable&stable=${encodeURIComponent(ref)}`, { state: { from } })}>
                Create subtable
              </Button>
            )}
            {kind === 'database' && (
              <Button size="sm" variant="primary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => navigate(`/historian/storage/create?kind=stable&database=${encodeURIComponent(name)}`, { state: { from } })}>
                Create supertable
              </Button>
            )}
          </>
        }
      >
        {error ? (
          <div className="p-4">
            <ErrorBanner error={error} subject={name} onRetry={onRetry} />
          </div>
        ) : !object ? (
          <LoadingBlock label={`Loading ${name}…`} />
        ) : (
          <div className="p-4 space-y-4">
            <Tabs tabs={tabs} activeTab={tab} onChange={(id) => setTab(id as DrawerTab)} />
            {tab === 'overview' && (
              <div className="space-y-3">
                <PropGrid items={propItems(object)} />
                {object.description && <p className="text-[12px] text-[#334568] whitespace-pre-wrap">{object.description}</p>}
              </div>
            )}
            {tab === 'columns' && stableObj && (
              <div className="space-y-4">
                <section className="space-y-2">
                  <h3 className="text-[12px] font-bold text-[#111B37]">Columns ({stableObj.columns?.length || 0})</h3>
                  <ColumnsTable stable={stableObj} />
                </section>
                <section className="space-y-2">
                  <h3 className="text-[12px] font-bold text-[#111B37]">Tags ({stableObj.tags?.length || 0})</h3>
                  <TagsTable tags={stableObj.tags || []} />
                </section>
              </div>
            )}
            {tab === 'columns' && subObj && <TagsTable tags={subObj.tag_values || []} withValues />}
            {tab === 'bindings' && subObj && <BindingsList subtable={subObj} />}
            {tab === 'ddl' && <DdlBlock obj={object} />}
          </div>
        )}
      </SideDrawer>
      {lifecycle && (
        <StorageLifecycleDialog
          target={lifecycle}
          onClose={() => setLifecycle(null)}
          onDone={(msg) => {
            setLifecycle(null);
            onNotice?.(msg);
            if (msg.startsWith('Deleted')) onClose();
            onRefresh?.();
          }}
        />
      )}
    </>
  );
};
