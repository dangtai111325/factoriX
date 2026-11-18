/**
 * Lifecycle actions of a user-created storage object (R1-05): pause / resume recording, retire
 * (keep rows, stop writes) and permanent delete with typed confirmation. FactoriX system objects
 * (operational history, model snapshots, the tenant database) are read-only and say so.
 */
import React, { useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { ModalPortal } from '../../components/modals/ModalPortal';
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

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 bg-[#111B37]/40 flex items-center justify-center p-4" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div role="dialog" aria-modal="true" aria-label={`Manage ${target.name}`} className="bg-white rounded-xl border border-[#E3EAF3] shadow-xl w-full max-w-md p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[16px] font-bold text-[#111B37]">Manage {target.kind}</h2>
              <p className="text-[13px] font-mono text-[#334568] break-all">{target.name}</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="text-[#657794] hover:text-[#111B37]"><X className="w-4 h-4" /></button>
          </div>
          {locked ? (
            <p className="text-[13px] text-[#334568]">This is a FactoriX system object (operational history). It is read-only here and cannot be paused, retired or deleted.</p>
          ) : (
            <>
              {target.kind !== 'database' && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={!!busy} onClick={() => run(target.status === 'ACTIVE' ? 'pause' : 'resume')}
                    className="h-9 px-4 rounded-lg border border-[#D4DFEC] bg-white text-[13px] font-semibold text-[#334568] disabled:opacity-50">
                    {busy === 'pause' || busy === 'resume' ? <Loader2 className="w-4 h-4 animate-spin inline" /> : target.status === 'ACTIVE' ? 'Pause recording' : 'Start recording'}
                  </button>
                  <button type="button" disabled={!!busy} onClick={() => run('retire')}
                    className="h-9 px-4 rounded-lg border border-[#D4DFEC] bg-white text-[13px] font-semibold text-[#334568] disabled:opacity-50">
                    {busy === 'retire' ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Retire (keep data)'}
                  </button>
                </div>
              )}
              <div className="p-3 rounded-lg border border-[#FAC6C9] bg-[#FFF7F8] space-y-2">
                <p className="text-[12px] text-[#334568] flex gap-1.5"><AlertTriangle className="w-4 h-4 text-[#F2343B] shrink-0" />
                  Delete permanently drops the {target.kind} and all its rows in TDengine. Type its name to confirm.</p>
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Type the name to confirm"
                  className="w-full h-9 px-3 rounded-lg border border-[#D4DFEC] text-[13px] font-mono" placeholder={target.name} />
                <button type="button" disabled={!!busy || confirm !== target.name} onClick={() => run('purge')}
                  className="h-9 px-4 rounded-lg bg-white border border-[#FAC6C9] text-[#F2343B] text-[13px] font-semibold disabled:opacity-50">
                  {busy === 'purge' ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Delete permanently'}
                </button>
              </div>
            </>
          )}
          {error && <p className="text-[12px] text-[#F2343B]">{error}</p>}
        </div>
      </div>
    </ModalPortal>
  );
};
