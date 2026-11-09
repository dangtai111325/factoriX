import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { SignalItem } from '../../types';
import { isEnterSubmit } from './enterSubmit';
import { Button } from '../../components/common/Button';
import { Card } from '../../components/common/Card';
import { ModalPortal } from '../../components/modals/ModalPortal';
import { api, ApiError } from '../../api/client';
import { useApp } from '../../store/AppContext';
import { PROTOCOL_LABEL } from '../../lib/protocols';
import { AddressFieldSpec, addressPatch, describeAddressError, normaliseValue, protocolOfSignal, validateAddressValue, ADDRESS_FIELDS } from './signalAddress';

interface SignalEditDialogProps {
  signal: SignalItem;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type TsMode = 'sibling' | 'custom' | 'none';

const labelCls = 'block text-[11px] font-semibold text-[#657794] uppercase mb-1';
const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded text-[13px] focus:outline-none focus:border-blue-500';

/** Form value of a stored address value. */
function formValue(spec: AddressFieldSpec, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (spec.kind === 'bool') return value ? 'true' : 'false';
  return String(value);
}

/**
 * Edits the signal definition and its source address (PATCH /api/v1/signals/{id} with the current
 * `version`; the address goes in `address_patch`). Moving to another connection keeps the source
 * address, so only connections of the same protocol and site are offered; moving and changing the
 * address in one save is not allowed by the Center.
 */
export const SignalEditDialog: React.FC<SignalEditDialogProps> = ({ signal, isOpen, onClose, onSaved }) => {
  const titleId = useId();
  const { connections } = useApp();
  const currentConnectionId = signal.sourceConnectionId || signal.connectionId || '';
  const currentConnection = connections.find((c) => c.id === currentConnectionId);
  const moveTargets = currentConnection
    ? connections.filter((c) => c.protocol === currentConnection.protocol && c.siteId === currentConnection.siteId && c.lifecycleStatus !== 'ARCHIVED')
    : [];
  const protocol = currentConnectionId ? protocolOfSignal(signal) : null;
  const specs = protocol ? ADDRESS_FIELDS[protocol] : [];
  const storedAddress = useMemo(() => ({ ...((signal.addressJson || {}) as Record<string, unknown>) }), [signal.addressJson]);

  const [connectionId, setConnectionId] = useState(currentConnectionId);
  const [displayName, setDisplayName] = useState(signal.displayName || signal.name || '');
  const [unit, setUnit] = useState(signal.unit || '');
  const [description, setDescription] = useState(signal.description || '');
  const [intervalMs, setIntervalMs] = useState(String(signal.expectedIntervalMs ?? signal.sampleIntervalMs ?? 1000));
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(specs.map((spec) => [spec.key, formValue(spec, storedAddress[spec.key])])),
  );
  const storedTs = storedAddress.timestamp_path;
  const [tsMode, setTsMode] = useState<TsMode>(storedTs === undefined || storedTs === null ? 'sibling' : storedTs === '' ? 'none' : 'custom');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverFieldErrors, setServerFieldErrors] = useState<Record<string, string>>({});
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

  /** Edited address (normalised) for the keys shown in the form. */
  const editedAddress = useMemo(() => {
    if (!protocol) return {};
    const out: Record<string, unknown> = {};
    specs.forEach((spec) => {
      if (spec.kind === 'timestamp_path') {
        out[spec.key] = tsMode === 'sibling' ? null : tsMode === 'none' ? '' : normaliseValue(protocol, spec.key, values[spec.key] || '');
        return;
      }
      const raw = values[spec.key] ?? '';
      if (spec.kind === 'bool') {
        out[spec.key] = raw === 'true' ? true : storedAddress[spec.key] === undefined ? undefined : false;
        return;
      }
      if (raw === '' && storedAddress[spec.key] === undefined) return;
      out[spec.key] = normaliseValue(protocol, spec.key, raw);
    });
    return out;
  }, [protocol, specs, values, tsMode, storedAddress]);

  const patch = useMemo(() => addressPatch(storedAddress, editedAddress), [storedAddress, editedAddress]);
  const addressChanged = Object.keys(patch).length > 0;
  const moving = Boolean(connectionId && connectionId !== currentConnectionId);

  const fieldErrors = useMemo(() => {
    const out: Record<string, string> = {};
    if (!protocol) return out;
    Object.entries(editedAddress).forEach(([key, value]) => {
      if (value === undefined) return;
      const problem = validateAddressValue(protocol, key, value);
      if (problem) out[key] = problem;
    });
    if (tsMode === 'custom' && !String(values.timestamp_path || '').trim()) out.timestamp_path = 'Enter the source time JSONPath, or choose the default.';
    return out;
  }, [protocol, editedAddress, tsMode, values.timestamp_path]);

  if (!isOpen) return null;

  const setValue = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setServerFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  // In-flight guard (R3-DM-04): `saving` only disables the button after the next render.
  const savingRef = useRef(false);
  const handleSave = async () => {
    if (savingRef.current) return;
    const interval = Number(intervalMs);
    if (!Number.isInteger(interval) || interval < 100) {
      setError('Expected interval must be a whole number of milliseconds (100 or more).');
      return;
    }
    if (addressChanged && Object.keys(fieldErrors).length) {
      setTouched(Object.fromEntries(Object.keys(fieldErrors).map((k) => [k, true])));
      setError('Fix the highlighted address fields.');
      return;
    }
    if (addressChanged && moving) {
      setError('Change the address or move the signal to another connection, not both at once.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setServerFieldErrors({});
    try {
      await api(`/api/v1/signals/${encodeURIComponent(signal.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: signal.version ?? 1,
          display_name: displayName.trim() || undefined,
          unit: unit.trim(),
          description: description.trim(),
          expected_interval_ms: interval,
          ...(moving ? { connection_id: connectionId } : {}),
          ...(addressChanged ? { address_patch: patch } : {}),
        }),
      });
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RESOURCE_VERSION_CONFLICT') {
        setError('This signal was changed elsewhere. Close the dialog and try again with the latest version.');
      } else {
        const described = describeAddressError(err);
        setServerFieldErrors(described.fields);
        setError(described.message);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const errorOf = (key: string) => serverFieldErrors[key] || (touched[key] ? fieldErrors[key] : undefined);

  const renderField = (spec: AddressFieldSpec) => {
    const id = `${titleId}-addr-${spec.key}`;
    const problem = errorOf(spec.key);
    const errId = problem ? `${id}-err` : undefined;
    const value = values[spec.key] ?? '';
    const common = {
      id,
      'aria-invalid': Boolean(problem) || undefined,
      'aria-describedby': errId,
      onBlur: () => setTouched((prev) => ({ ...prev, [spec.key]: true })),
    };
    const border = problem ? 'border-red-400' : '';
    let control: React.ReactNode;
    if (spec.kind === 'bool') {
      return (
        <label key={spec.key} className="flex items-start gap-2 text-[12px] text-[#334568] sm:col-span-2 cursor-pointer">
          <input type="checkbox" checked={value === 'true'} onChange={(e) => setValue(spec.key, e.target.checked ? 'true' : 'false')} className="mt-0.5" />
          <span>
            <span className="font-semibold">{spec.label}</span>
            {spec.help && <span className="block text-[10px] text-slate-500">{spec.help}</span>}
          </span>
        </label>
      );
    }
    if (spec.kind === 'timestamp_path') {
      control = (
        <div className="space-y-1.5">
          <select
            aria-label="Source time mode"
            value={tsMode}
            onChange={(e) => setTsMode(e.target.value as TsMode)}
            className={`${inputCls} bg-white`}
          >
            <option value="sibling">Sibling source_timestamp (default)</option>
            <option value="custom">Custom JSONPath</option>
            <option value="none">None (use read time only)</option>
          </select>
          {tsMode === 'custom' && (
            <input {...common} value={value} placeholder={spec.placeholder} onChange={(e) => setValue(spec.key, e.target.value)} className={`${inputCls} font-mono ${border}`} />
          )}
        </div>
      );
    } else if (spec.kind === 'select') {
      control = (
        <select {...common} value={value} onChange={(e) => setValue(spec.key, e.target.value)} className={`${inputCls} bg-white ${border}`}>
          {(spec.removable || !value) && !spec.options?.some((o) => o.value === '') && <option value="">{spec.removable ? 'Default' : '—'}</option>}
          {spec.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    } else {
      control = (
        <input
          {...common}
          type={spec.kind === 'int' ? 'number' : 'text'}
          min={spec.min}
          max={spec.max}
          value={value}
          placeholder={spec.placeholder}
          onChange={(e) => setValue(spec.key, e.target.value)}
          className={`${inputCls} ${spec.kind === 'text' ? 'font-mono text-[12px]' : 'font-mono'} ${border}`}
        />
      );
    }
    const wide = spec.kind === 'text' || spec.kind === 'timestamp_path';
    return (
      <div key={spec.key} className={wide ? 'sm:col-span-2' : ''}>
        <label htmlFor={spec.kind === 'timestamp_path' && tsMode !== 'custom' ? undefined : id} className={labelCls}>
          {spec.label}
          {spec.required && '*'}
        </label>
        {control}
        {problem ? (
          <p id={errId} className="text-[11px] text-red-600 mt-1">
            {problem}
          </p>
        ) : (
          spec.help && <p className="text-[10px] text-slate-500 mt-1">{spec.help}</p>
        )}
      </div>
    );
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
        onKeyDown={(event) => {
          // Enter in a field saves (not in textareas); the in-flight guard prevents a double save.
          if (!isEnterSubmit(event)) return;
          event.preventDefault();
          void handleSave();
        }}
      >
        <Card className={`w-full ${protocol ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto p-5 bg-white border border-slate-300 shadow-xl space-y-4`}>
          <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="space-y-4">
            <div>
              <h3 id={titleId} className="text-[14px] font-bold text-[#111B37]">
                Edit signal
              </h3>
              <p className="text-[12px] text-[#657794] mt-0.5">
                Key <span className="font-mono font-semibold text-[#111B37]">{signal.key || signal.name}</span> stays unchanged; data models refer to it.
              </p>
            </div>

            {error && (
              <div role="alert" className="p-2.5 bg-red-50 border border-red-200 text-red-700 text-[12px] rounded">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px]">
              <div className="sm:col-span-2">
                <label htmlFor={`${titleId}-name`} className={labelCls}>
                  Display name
                </label>
                <input id={`${titleId}-name`} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label htmlFor={`${titleId}-unit`} className={labelCls}>
                  Unit
                </label>
                <input id={`${titleId}-unit`} type="text" value={unit} onChange={(e) => setUnit(e.target.value)} className={inputCls} placeholder="e.g. kW, °C, rpm" />
              </div>
              <div>
                <label htmlFor={`${titleId}-interval`} className={labelCls}>
                  Expected interval (ms)
                </label>
                <input
                  id={`${titleId}-interval`}
                  type="number"
                  min={100}
                  value={intervalMs}
                  onChange={(e) => setIntervalMs(e.target.value)}
                  className={`${inputCls} font-mono`}
                />
              </div>
              <p className="sm:col-span-2 -mt-1 text-[10px] text-slate-500">The signal turns Stale after max(2 × interval, 12 s) without a new read.</p>
              <div className="sm:col-span-2">
                <label htmlFor={`${titleId}-desc`} className={labelCls}>
                  Description
                </label>
                <textarea id={`${titleId}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputCls} />
              </div>
            </div>

            {protocol && (
              <fieldset className="border border-slate-200 rounded-lg p-3 space-y-3">
                <legend className="px-1 text-[12px] font-bold text-[#111B37]">Source address</legend>
                <p className="text-[11px] text-[#657794] -mt-1">
                  {currentConnection ? `${currentConnection.name} · ` : ''}Changes are validated by the Center and sent to the collector with a new configuration.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px]">{specs.map(renderField)}</div>
                {addressChanged && (
                  <p className="text-[11px] text-[#134074] bg-[#EEF5FF] border border-[#D2E3FA] rounded px-2 py-1.5">
                    Changed: {Object.keys(patch).map((key) => specs.find((s) => s.key === key)?.label || key).join(', ')}
                  </p>
                )}
              </fieldset>
            )}

            {moveTargets.length > 1 && (
              <div className="text-[12px]">
                <label htmlFor={`${titleId}-conn`} className={labelCls}>
                  Data connection
                </label>
                <select
                  id={`${titleId}-conn`}
                  value={connectionId}
                  disabled={addressChanged}
                  onChange={(e) => setConnectionId(e.target.value)}
                  className={`${inputCls} bg-white disabled:bg-slate-100 disabled:text-slate-500`}
                >
                  {moveTargets.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.endpoint})
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-slate-500 mt-1">
                  {addressChanged
                    ? 'Save the address change first; moving and changing the address are separate saves.'
                    : `Moves the binding with the same source address to another ${currentConnection ? PROTOCOL_LABEL[currentConnection.protocol] : ''} connection.`}
                </p>
              </div>
            )}

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
    </ModalPortal>
  );
};
