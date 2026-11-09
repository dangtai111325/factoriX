import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { SignalItem } from '../../types';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { ModalPortal } from '../../components/modals/ModalPortal';
import { api, ApiError } from '../../api/client';
import { translateApiError } from '../../utils/apiErrors';
import { isEnterSubmit } from './enterSubmit';

interface BulkPropertiesDialogProps {
  isOpen: boolean;
  signals: SignalItem[];
  onClose: () => void;
  /** Called after a successful update with the number of updated / unchanged signals. */
  onApplied: (updated: number, unchanged: number) => void;
}

const labelCls = 'block text-[11px] font-semibold text-[#657794] uppercase mb-1';
const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500 disabled:bg-slate-100 disabled:text-slate-400';

type RoundMode = 'keep' | 'set' | 'remove';

const NUMERIC = new Set(['int64', 'float64', 'number', 'integer', 'float', 'double']);

function isNumeric(signal: SignalItem): boolean {
  return NUMERIC.has(String(signal.dataType || signal.data_type || '').toLowerCase());
}

/** The single value all signals share, or null when they differ. */
function common<T>(values: T[]): T | null {
  if (!values.length) return null;
  return values.every((v) => v === values[0]) ? values[0] : null;
}

interface ItemError {
  signal_id?: string;
  message?: string;
}

/**
 * "Edit properties…" for the selected signals (R4-SG-02): unit, expected interval (which sets when a
 * signal turns Stale) and round digits, applied to every selected signal in one all-or-nothing
 * request (POST /api/v1/signals/bulk-properties). Only the properties ticked are changed.
 */
export const BulkPropertiesDialog: React.FC<BulkPropertiesDialogProps> = ({ isOpen, signals, onClose, onApplied }) => {
  const titleId = useId();
  const [setUnit, setSetUnit] = useState(false);
  const [unit, setUnitValue] = useState('');
  const [changeInterval, setChangeInterval] = useState(false);
  const [intervalMs, setIntervalMsValue] = useState('1000');
  const [roundMode, setRoundMode] = useState<RoundMode>('keep');
  const [roundDigits, setRoundDigits] = useState('1');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<ItemError[]>([]);

  const nonNumeric = useMemo(() => signals.filter((s) => !isNumeric(s)), [signals]);
  const unbound = useMemo(() => signals.filter((s) => !(s.sourceConnectionId || s.connectionId)), [signals]);
  const roundBlocked = nonNumeric.length > 0 || unbound.length > 0;

  // Start from the values the selection already shares.
  useEffect(() => {
    if (!isOpen) return;
    setSetUnit(false);
    setUnitValue(common(signals.map((s) => s.unit || '')) ?? '');
    setChangeInterval(false);
    const sharedInterval = common(signals.map((s) => s.expectedIntervalMs ?? s.sampleIntervalMs ?? null));
    setIntervalMsValue(String(sharedInterval ?? 1000));
    setRoundMode('keep');
    const sharedRound = common(signals.map((s) => (s.addressJson as Record<string, unknown> | undefined)?.round_digits ?? null));
    setRoundDigits(sharedRound === null || sharedRound === undefined ? '1' : String(sharedRound));
    setError(null);
    setItemErrors([]);
    // Initialise once per opening; later changes of the live signal list must not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const names = new Map(signals.map((s) => [s.id, s.displayName || s.key || s.name]));
  const nothingChosen = !setUnit && !changeInterval && roundMode === 'keep';

  const validate = (): string | null => {
    if (nothingChosen) return 'Tick at least one property to change.';
    if (setUnit && unit.trim().length > 32) return 'Unit must be at most 32 characters.';
    if (changeInterval) {
      const n = Number(intervalMs);
      if (!Number.isInteger(n) || n < 100 || n > 86_400_000) return 'Expected interval must be a whole number of milliseconds from 100 to 86400000.';
    }
    if (roundMode === 'set') {
      const d = Number(roundDigits);
      if (!Number.isInteger(d) || d < 0 || d > 10) return 'Round digits must be a whole number from 0 to 10.';
    }
    if (roundMode !== 'keep' && roundBlocked) return 'Rounding can be changed only when every selected signal is numeric and has a source.';
    return null;
  };

  const handleApply = async () => {
    if (savingRef.current) return;
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setItemErrors([]);
    try {
      const body: Record<string, unknown> = {
        items: signals.map((s) => ({ signal_id: s.id, version: s.version ?? 1 })),
      };
      if (setUnit) body.unit = unit.trim();
      if (changeInterval) body.expected_interval_ms = Number(intervalMs);
      if (roundMode === 'set') body.round_digits = Number(roundDigits);
      if (roundMode === 'remove') body.round_digits = null;
      const result = await api<{ count?: number; unchanged?: string[] }>('/api/v1/signals/bulk-properties', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onApplied(result?.count ?? 0, result?.unchanged?.length ?? 0);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RESOURCE_VERSION_CONFLICT') {
        setError('A selected signal was changed elsewhere. Close the dialog, let the list refresh and try again.');
      } else {
        setError(translateApiError(err));
      }
      setItemErrors(err instanceof ApiError ? (err.itemErrors as ItemError[]).slice(0, 20) : []);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const count = signals.length;
  const noun = count === 1 ? 'signal' : 'signals';

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
        onKeyDown={(event) => {
          if (!isEnterSubmit(event)) return;
          event.preventDefault();
          void handleApply();
        }}
      >
        <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto p-5 bg-white border border-slate-300 shadow-xl">
          <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="space-y-4">
            <div>
              <h3 id={titleId} className="text-[14px] font-bold text-[#111B37]">
                Edit properties of {count} {noun}
              </h3>
              <p className="text-[12px] text-[#657794] mt-0.5">
                Tick the properties to set on every selected signal. Unticked properties stay as they are. All signals are changed, or none.
              </p>
            </div>

            {error && (
              <div role="alert" className="p-2.5 bg-red-50 border border-red-200 text-red-700 text-[12px] rounded space-y-1">
                <p>{error}</p>
                {itemErrors.length > 0 && (
                  <ul className="list-disc pl-4 space-y-0.5">
                    {itemErrors.map((row, index) => (
                      <li key={`${row.signal_id || ''}-${index}`}>{row.message || names.get(row.signal_id || '') || row.signal_id}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="space-y-3 text-[12px]">
              <div className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1">
                <input id={`${titleId}-set-unit`} type="checkbox" checked={setUnit} onChange={(e) => setSetUnit(e.target.checked)} className="mt-2" aria-label="Change the unit" />
                <div>
                  <label htmlFor={`${titleId}-unit`} className={labelCls}>
                    Unit
                  </label>
                  <input
                    id={`${titleId}-unit`}
                    type="text"
                    value={unit}
                    disabled={!setUnit}
                    onChange={(e) => setUnitValue(e.target.value)}
                    className={inputCls}
                    placeholder="e.g. kW, °C, rpm (empty = no unit)"
                    aria-describedby={`${titleId}-unit-help`}
                  />
                  <p id={`${titleId}-unit-help`} className="text-[10px] text-slate-500 mt-1">
                    {setUnit ? 'Leave empty to remove the unit.' : 'Tick to change the unit.'}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1">
                <input id={`${titleId}-set-interval`} type="checkbox" checked={changeInterval} onChange={(e) => setChangeInterval(e.target.checked)} className="mt-2" aria-label="Change the expected interval" />
                <div>
                  <label htmlFor={`${titleId}-interval`} className={labelCls}>
                    Expected interval (ms)
                  </label>
                  <input
                    id={`${titleId}-interval`}
                    type="number"
                    min={100}
                    value={intervalMs}
                    disabled={!changeInterval}
                    onChange={(e) => setIntervalMsValue(e.target.value)}
                    className={`${inputCls} font-mono`}
                  />
                  <p className="text-[10px] text-slate-500 mt-1">A signal turns Stale after max(2 × interval, 12 s) without a new read.</p>
                </div>
              </div>

              <fieldset className="border border-slate-200 rounded-lg p-3 space-y-2">
                <legend className="px-1 text-[11px] font-semibold text-[#657794] uppercase">Round digits</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {(
                    [
                      ['keep', 'Keep as is'],
                      ['set', 'Round to'],
                      ['remove', 'No rounding'],
                    ] as Array<[RoundMode, string]>
                  ).map(([value, label]) => (
                    <label key={value} className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name={`${titleId}-round`}
                        value={value}
                        checked={roundMode === value}
                        disabled={value !== 'keep' && roundBlocked}
                        onChange={() => setRoundMode(value)}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                  {roundMode === 'set' && (
                    <input
                      type="number"
                      min={0}
                      max={10}
                      aria-label="Number of decimal digits"
                      value={roundDigits}
                      onChange={(e) => setRoundDigits(e.target.value)}
                      className="w-20 px-2 py-1 border border-slate-300 rounded text-[13px] font-mono"
                    />
                  )}
                </div>
                <p className="text-[10px] text-slate-500">
                  {roundBlocked
                    ? `Not available: ${nonNumeric.length ? `${nonNumeric.length} selected signal${nonNumeric.length === 1 ? ' is' : 's are'} not numeric` : ''}${nonNumeric.length && unbound.length ? '; ' : ''}${unbound.length ? `${unbound.length} ${unbound.length === 1 ? 'has' : 'have'} no source` : ''}.`
                    : 'Rounding is part of the source address: the collector receives a new configuration and rounds new values.'}
                </p>
              </fieldset>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => void handleApply()} disabled={saving || nothingChosen}>
                {saving ? 'Applying…' : `Apply to ${count} ${noun}`}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </ModalPortal>
  );
};
