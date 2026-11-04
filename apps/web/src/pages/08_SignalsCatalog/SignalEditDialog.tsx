import React, { useState } from 'react';
import { SignalItem } from '../../types';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { api } from '../../api/client';
import { useApp } from '../../store/AppContext';

interface SignalEditDialogProps {
  signal: SignalItem;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const SignalEditDialog: React.FC<SignalEditDialogProps> = ({
  signal,
  isOpen,
  onClose,
  onSaved,
}) => {
  const { connections } = useApp();
  const [displayName, setDisplayName] = useState(signal.displayName || signal.name || '');
  const [unit, setUnit] = useState(signal.unit || '');
  const [description, setDescription] = useState(signal.description || '');
  const [selectedConnectionId, setSelectedConnectionId] = useState(
    signal.sourceConnectionId || signal.connectionId || (connections[0]?.id || '')
  );
  const [staleAfterSec, setStaleAfterSec] = useState(
    signal.expectedIntervalMs ? String(Math.round(signal.expectedIntervalMs / 1000)) : '10'
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const intervalMs = Math.max(1, Number(staleAfterSec) || 10) * 1000;
      await api(`/api/v1/signals/${signal.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          display_name: displayName.trim() || undefined,
          unit: unit.trim() || undefined,
          description: description.trim() || undefined,
          expected_interval_ms: intervalMs,
          connection_id: selectedConnectionId || undefined,
        }),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save signal');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md p-5 bg-white border border-slate-300 shadow-xl space-y-4">
        <div>
          <h3 className="text-[14px] font-bold text-[#111B37]">Edit Signal</h3>
          <p className="text-[12px] text-[#657794] mt-0.5">
            Update display details, data connection, and quality thresholds for {signal.name || signal.key}
          </p>
        </div>

        {error && (
          <div className="p-2.5 bg-red-50 border border-red-200 text-red-700 text-[12px] rounded">
            {error}
          </div>
        )}

        <div className="space-y-3 text-[12px]">
          <div>
            <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
              Data Connection
            </label>
            <select
              value={selectedConnectionId}
              onChange={(e) => setSelectedConnectionId(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] bg-white font-medium text-[#0B2545] focus:outline-none focus:border-blue-500"
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.protocol.toUpperCase()} — {c.endpoint})
                </option>
              ))}
            </select>
            <p className="text-[10px] text-slate-500 mt-1">
              Reassign this signal to a different data broker or PLC without recreating data definitions.
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500"
              placeholder="e.g. Power consumption"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
              Unit
            </label>
            <input
              type="text"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500"
              placeholder="e.g. kW, °C, bar"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500"
              placeholder="Operational context or notes"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-[#657794] uppercase mb-1">
              Mark STALE After (seconds)
            </label>
            <input
              type="number"
              min={1}
              value={staleAfterSec}
              onChange={(e) => setStaleAfterSec(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </Button>
        </div>
      </Card>
    </div>
  );
};
