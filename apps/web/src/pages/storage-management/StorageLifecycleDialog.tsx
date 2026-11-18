/**
 * Lifecycle actions of a user-created storage object (R1-05): pause / resume recording, retire
 * (keep rows, stop writes) and permanent delete with typed confirmation. FactoriX system objects
 * (operational history, model snapshots, the tenant database) are read-only and say so.
 */
import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Banner, Dialog } from '../historian/hsUi';
import {
  isSystemStorageName,
  pauseStorageObject,
  purgeStorageObject,
  resumeStorageObject,
  retireStorageObject,
} from '../../lib/storagePhysicalApi';

export interface LifecycleTarget {
  id: string; // canonical id: db:<name> | stable:<db>.<name> | subtable:<db>.<name>
  kind: 'database' | 'stable' | 'subtable';
  name: string;
  status?: string | null;
}

export function lifecycleTargetOf(id: string, status?: string | null): LifecycleTarget {
  if (id.startsWith('db:')) return { id, kind: 'database', name: id.slice(3), status };
  const kind = id.startsWith('stable:') ? 'stable' : 'subtable';
  const ref = id.replace(/^(stable|subtable):/, '');
  return { id, kind, name: ref.includes('.') ? ref.split('.').slice(1).join('.') : ref, status };
}

export function isProtectedTarget(t: LifecycleTarget): boolean {
  if (t.kind === 'database') return t.name.startsWith('fx_t_');
  return isSystemStorageName(t.name);
}

export const StorageLifecycleDialog: React.FC<{
  target: LifecycleTarget;
  onClose: () => void;
  onDone: (message: string) => void;
}> = ({ target, onClose, onDone }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const locked = isProtectedTarget(target);

  const run = async (action: 'pause' | 'resume' | 'retire' | 'purge') => {
    setBusy(action);
    setError(null);
    try {
      if (action === 'pause') await pauseStorageObject(target.id);
      if (action === 'resume') await resumeStorageObject(target.id);
      if (action === 'retire') await retireStorageObject(target.id);
      if (action === 'purge') await purgeStorageObject(target.id, confirm);
      onDone(
        action === 'purge' ? `Deleted ${target.name}` : action === 'retire' ? `Retired ${target.name}` :
        action === 'pause' ? `Recording paused for ${target.name}` : `Recording started for ${target.name}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The action failed.');
    } finally {
      setBusy(null);
    }
  };

  const title = `Manage ${target.kind === 'stable' ? 'supertable' : target.kind}`;
  return (
    <Dialog open title={title} subtitle={<span className="font-mono break-all">{target.name}</span>} onClose={onClose} busy={!!busy} width="sm"
      footer={<Button variant="outline" size="sm" onClick={onClose} disabled={!!busy}>Close</Button>}>
      <div className="space-y-4">
        {locked ? (
          <p className="text-[13px] text-[#334568]">This is a FactoriX system object (operational history). It is read-only here and cannot be paused, retired or deleted.</p>
        ) : (
          <>
            {target.kind !== 'database' && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="md" disabled={!!busy} loading={busy === 'pause' || busy === 'resume'} onClick={() => run(target.status === 'ACTIVE' ? 'pause' : 'resume')}>
                  {target.status === 'ACTIVE' ? 'Pause recording' : 'Start recording'}
                </Button>
                <Button variant="outline" size="md" disabled={!!busy} loading={busy === 'retire'} onClick={() => run('retire')}>
                  Retire (keep data)
                </Button>
              </div>
            )}
            <div className="p-3 rounded-lg border border-red-200 bg-red-50/60 space-y-2">
              <p className="text-[12px] text-[#334568] flex gap-1.5"><AlertTriangle className="w-4 h-4 text-[#F2343B] shrink-0" />
                Delete permanently drops the {target.kind} and all its rows in TDengine. Type its name to confirm.</p>
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Type the name to confirm"
                className="w-full h-9 px-3 rounded-lg border border-[#D4DFEC] text-[13px] font-mono bg-white focus:outline-none focus:border-blue-500" placeholder={target.name} />
              <Button variant="danger" size="md" disabled={!!busy || confirm !== target.name} loading={busy === 'purge'} onClick={() => run('purge')}>
                Delete permanently
              </Button>
            </div>
          </>
        )}
        {error && <Banner tone="error">{error}</Banner>}
      </div>
    </Dialog>
  );
};
