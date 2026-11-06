import React, { useEffect, useId, useState } from 'react';
import { SignalItem } from '../../types';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { api, ApiError } from '../../api/client';
import { useApp } from '../../store/AppContext';

interface SignalEditDialogProps {
  signal: SignalItem;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Edits the signal definition (PATCH /api/v1/signals/{id} with the current `version`).
 * Moving to another connection keeps the source address, so only connections of the same protocol
 * and site are offered (the Center rebinds and rejects anything else).
 */
export const SignalEditDialog: React.FC<SignalEditDialogProps> = ({ signal, isOpen, onClose, onSaved }) => {
  const titleId = useId();
  const { connections } = useApp();
  const currentConnectionId = signal.sourceConnectionId || signal.connectionId || '';
  const currentConnection = connections.find((c) => c.id === currentConnectionId);
  const moveTargets = currentConnection
    ? connections.filter((c) => c.protocol === currentConnection.protocol && c.siteId === currentConnection.siteId && c.lifecycleStatus !== 'ARCHIVED')
    : [];
  const [connectionId, setConnectionId] = useState(currentConnectionId);
  const [displayName, setDisplayName] = useState(signal.displayName || signal.name || '');
  const [unit, setUnit] = useState(signal.unit || '');
  const [description, setDescription] = useState(signal.description || '');
  const [intervalMs, setIntervalMs] = useState(String(signal.expectedIntervalMs ?? signal.sampleIntervalMs ?? 1000));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, saving]);

  if (!isOpen) return null;

  const handleSave = async () => {
    const interval = Number(intervalMs);
    if (!Number.isInteger(interval) || interval < 100) {
      setError('Expected interval must be a whole number of milliseconds (100 or more).');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api(`/api/v1/signals/${encodeURIComponent(signal.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: signal.version ?? 1,
          display_name: displayName.trim() || undefined,
          unit: unit.trim(),
          description: description.trim(),
          expected_interval_ms: interval,
          ...(connectionId && connectionId !== currentConnectionId ? { connection_id: connectionId } : {}),
        }),
      });
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RESOURCE_VERSION_CONFLICT') {
        setError('This signal was changed elsewhere. Close the dialog and try again with the latest version.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not save the signal.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md p-5 bg-white border border-slate-300 shadow-xl space-y-4">
        <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="space-y-4">
          <div>
            <h3 id={titleId} className="text-[14px] font-bold text-[#111B37]">Edit signal</h3>
            <p className="text-[12px] text-[#657794] mt-0.5">
              Key <span className="font-mono font-semibold text-[#111B37]">{signal.key || signal.name}</span> stays unchanged; data models refer to it.
            </p>
          </div>

          {error && (
            <div role="alert" className="p-2.5 bg-red-50 border border-red-200 text-red-700 text-[12px] rounded">
              {error}
            </div>
          )}

          <div className="space-y-3 text-[12px]">
            {moveTargets.length > 1 && (
              <div>
                <label htmlFor={`${titleId}-conn`} className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                  Data connection
                </label>
                <select
                  id={`${titleId}-conn`}
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] bg-white focus:outline-none focus:border-blue-500"
                >
                  {moveTargets.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.endpoint})
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-slate-500 mt-1">Moves the binding with the same source address to another {currentConnection?.protocol} connection.</p>
              </div>
            )}
            <div>
              <label htmlFor={`${titleId}-name`} className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                Display name
              </label>
              <input
                id={`${titleId}-name`}
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label htmlFor={`${titleId}-unit`} className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                Unit
              </label>
              <input
                id={`${titleId}-unit`}
                type="text"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500"
                placeholder="e.g. kW, °C, rpm"
              />
            </div>
            <div>
              <label htmlFor={`${titleId}-desc`} className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                Description
              </label>
              <textarea
                id={`${titleId}-desc`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label htmlFor={`${titleId}-interval`} className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
                Expected interval (ms)
              </label>
              <input
                id={`${titleId}-interval`}
                type="number"
                min={100}
                value={intervalMs}
                onChange={(e) => setIntervalMs(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500 font-mono"
              />
              <p className="text-[10px] text-slate-500 mt-1">The signal turns Stale after max(2 × interval, 12 s) without a new read.</p>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};
