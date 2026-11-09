import React, { useMemo, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { indeterminateRef, useRangeSelection } from '../08_SignalsCatalog/useRangeSelection';
import { ProtocolType } from '../../types';
import {
  DATA_TYPE_LABEL,
  FieldRow,
  MODBUS_TYPES,
  ModbusNativeType,
  REGISTER_AREAS,
  RegisterArea,
  SignalDataType,
  dataTypeForNative,
  registersFor,
} from './wizardModel';

interface FieldTableProps {
  protocol: ProtocolType;
  rows: FieldRow[];
  onChange: (rows: FieldRow[]) => void;
  /** Values returned by the last real test read, keyed by row id. */
  liveValues?: Record<string, string>;
}

const cell = 'py-1.5 px-1.5 align-top';
const input = 'w-full px-1.5 py-1 border border-slate-300 rounded text-[11px]';
const mono = `${input} font-mono`;

export const FieldTable: React.FC<FieldTableProps> = ({ protocol, rows, onChange, liveValues }) => {
  const update = (id: string, patch: Partial<FieldRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch, error: undefined } : row)));
  };
  const remove = (id: string) => onChange(rows.filter((row) => row.id !== id));
  const json = protocol === 'mqtt' || protocol === 'http' || protocol === 'websocket';

  // Bulk edit: select rows (Shift+click = range), then set one value on every selected row.
  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const selection = useRangeSelection(ids);
  const headerState = selection.stateOf(ids);
  const [bulkUnit, setBulkUnit] = useState('');
  const [bulkRound, setBulkRound] = useState('');
  const applyToSelected = (patch: Partial<FieldRow>) => {
    onChange(rows.map((row) => (selection.selected.has(row.id) ? { ...row, ...patch, error: undefined } : row)));
  };
  const removeSelected = () => {
    onChange(rows.filter((row) => !selection.selected.has(row.id)));
    selection.clear();
  };
  const bulkSelect = 'px-1.5 py-1 border border-slate-300 rounded text-[11px] bg-white';
  const onEnter = (run: () => void) => (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      run();
    }
  };

  return (
    <div className="space-y-1.5">
    {selection.count > 0 && (
      <div role="toolbar" aria-label="Edit the selected fields" className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 rounded-lg border border-blue-200 bg-blue-50/70 text-[11px] text-[#0B2545]">
        <span className="font-bold">{selection.count} of {rows.length} selected</span>
        <select
          aria-label="Set the signal type of the selected fields"
          value=""
          onChange={(e) => e.target.value && applyToSelected({ dataType: e.target.value as SignalDataType })}
          className={bulkSelect}
        >
          <option value="">Set type…</option>
          {(Object.keys(DATA_TYPE_LABEL) as SignalDataType[]).map((t) => (
            <option key={t} value={t}>{DATA_TYPE_LABEL[t]}</option>
          ))}
        </select>
        <span className="inline-flex items-center gap-1">
          <input
            aria-label="Unit for the selected fields"
            value={bulkUnit}
            placeholder="Unit"
            onChange={(e) => setBulkUnit(e.target.value)}
            onKeyDown={onEnter(() => applyToSelected({ unit: bulkUnit.trim() }))}
            className={`${bulkSelect} w-20`}
          />
          <button type="button" onClick={() => applyToSelected({ unit: bulkUnit.trim() })} className="font-semibold text-blue-700 hover:underline">
            Set unit
          </button>
        </span>
        <select
          aria-label="Set nullable on the selected fields"
          value=""
          onChange={(e) => e.target.value && applyToSelected({ nullable: e.target.value === 'yes' })}
          className={bulkSelect}
        >
          <option value="">Nullable…</option>
          <option value="yes">Nullable: yes</option>
          <option value="no">Nullable: no</option>
        </select>
        <span className="inline-flex items-center gap-1">
          <input
            aria-label="Round digits for the selected fields (empty = no rounding)"
            type="number"
            min={0}
            max={12}
            value={bulkRound}
            placeholder="Round"
            onChange={(e) => setBulkRound(e.target.value)}
            onKeyDown={onEnter(() => applyToSelected({ roundDigits: bulkRound }))}
            className={`${bulkSelect} w-16 font-mono`}
          />
          <button type="button" onClick={() => applyToSelected({ roundDigits: bulkRound })} className="font-semibold text-blue-700 hover:underline">
            Set round
          </button>
        </span>
        {protocol === 'modbus' && (
          <>
            <select
              aria-label="Set the register area of the selected fields"
              value=""
              onChange={(e) => e.target.value && applyToSelected({ registerArea: e.target.value as RegisterArea })}
              className={bulkSelect}
            >
              <option value="">Area…</option>
              {REGISTER_AREAS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <select
              aria-label="Set the word order of the selected fields"
              value=""
              onChange={(e) => e.target.value && applyToSelected({ wordOrder: e.target.value as 'big' | 'little' })}
              className={bulkSelect}
            >
              <option value="">Word order…</option>
              <option value="big">big (high word first)</option>
              <option value="little">little</option>
            </select>
          </>
        )}
        <button type="button" onClick={removeSelected} className="inline-flex items-center gap-1 font-semibold text-red-700 hover:underline">
          <Trash2 className="w-3 h-3" aria-hidden="true" /> Remove selected
        </button>
        <button type="button" onClick={selection.clear} className="inline-flex items-center gap-1 text-[#657794] hover:text-[#111B37]">
          <X className="w-3 h-3" aria-hidden="true" /> Clear selection
        </button>
      </div>
    )}
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className={`w-full text-left text-[11px] ${protocol === 'modbus' ? 'min-w-[1240px]' : 'min-w-[960px]'}`}>
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-[#657794] font-semibold text-[10px] uppercase tracking-wide">
            <th className={`${cell} w-6`}>
              <input
                type="checkbox"
                ref={indeterminateRef(headerState === 'some')}
                checked={headerState === 'all'}
                onChange={() => selection.setMany(ids, headerState !== 'all')}
                aria-label={`Select all ${rows.length} fields`}
                title="Select all fields. Shift+click a row checkbox to select a range."
              />
            </th>
            <th className={cell}>Key</th>
            <th className={cell}>Display name</th>
            {protocol === 'mqtt' && <th className={cell}>Topic</th>}
            {protocol === 'http' && <th className={cell}>Path</th>}
            {json && <th className={cell}>JSONPath</th>}
            {protocol === 'opcua' && <th className={cell}>Node ID</th>}
            {protocol === 'modbus' && (
              <>
                <th className={cell}>Area</th>
                <th className={cell}>Offset</th>
                <th className={cell}>Native type</th>
                <th className={cell} title="Registers; derived from the type (editable for ascii)">Regs</th>
                <th className={cell}>Word order</th>
                <th className={cell} title="This field carries the machine's source timestamp (uint64 epoch ms)">Source ts</th>
              </>
            )}
            <th className={cell}>Type</th>
            <th className={cell}>Unit</th>
            <th className={cell} title="A null value from a successful read is Good">Nullable</th>
            <th className={cell} title="Round numeric values on the edge (decimal digits)">Round</th>
            <th className={cell}>Sample / test value</th>
            <th className={cell} />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const type = row.nativeType || 'uint16';
            const fixedCount = registersFor(type);
            const live = liveValues?.[row.id];
            return (
              <tr key={row.id} className={row.error ? 'bg-red-50/40' : selection.isSelected(row.id) ? 'bg-blue-50/40' : 'hover:bg-slate-50'}>
                <td className={`${cell} w-6`}>
                  <input
                    type="checkbox"
                    checked={selection.isSelected(row.id)}
                    onChange={() => undefined}
                    onClick={(e) => selection.toggle(row.id, e.shiftKey)}
                    aria-label={`Select field ${row.key || 'without key'}`}
                  />
                </td>
                <td className={cell}>
                  <input aria-label="Signal key" value={row.key} onChange={(e) => update(row.id, { key: e.target.value })} className={`${mono} min-w-[110px]`} />
                  {row.error && <p className="text-[10px] text-red-600 mt-0.5 max-w-[220px]">{row.error}</p>}
                  {!row.error && row.warning && <p className="text-[10px] text-amber-700 mt-0.5 max-w-[220px]">{row.warning}</p>}
                </td>
                <td className={cell}>
                  <input aria-label="Display name" value={row.displayName} placeholder={row.key} onChange={(e) => update(row.id, { displayName: e.target.value })} className={`${input} min-w-[110px]`} />
                </td>
                {protocol === 'mqtt' && (
                  <td className={cell}>
                    <input aria-label="Topic" value={row.topic || ''} onChange={(e) => update(row.id, { topic: e.target.value })} className={`${mono} min-w-[180px]`} />
                  </td>
                )}
                {protocol === 'http' && (
                  <td className={cell}>
                    <input aria-label="Path" value={row.path || ''} onChange={(e) => update(row.id, { path: e.target.value })} className={`${mono} min-w-[180px]`} />
                  </td>
                )}
                {json && (
                  <td className={cell}>
                    <input aria-label="JSONPath" value={row.jsonpath || ''} onChange={(e) => update(row.id, { jsonpath: e.target.value })} className={`${mono} min-w-[180px]`} />
                  </td>
                )}
                {protocol === 'opcua' && (
                  <td className={cell}>
                    <input aria-label="Node ID" value={row.nodeId || ''} onChange={(e) => update(row.id, { nodeId: e.target.value })} className={`${mono} min-w-[260px]`} />
                  </td>
                )}
                {protocol === 'modbus' && (
                  <>
                    <td className={cell}>
                      <select aria-label="Register area" value={row.registerArea || 'holding'} onChange={(e) => update(row.id, { registerArea: e.target.value as RegisterArea })} className={`${input} min-w-[100px] bg-white`}>
                        {REGISTER_AREAS.map((a) => (
                          <option key={a} value={a}>{a}</option>
                        ))}
                      </select>
                    </td>
                    <td className={cell}>
                      <input aria-label="Offset" type="number" min={0} value={row.offset ?? ''} onChange={(e) => update(row.id, { offset: e.target.value })} className={`${mono} w-20 min-w-[72px]`} />
                    </td>
                    <td className={cell}>
                      <select
                        aria-label="Native type"
                        value={type}
                        onChange={(e) => {
                          const next = e.target.value as ModbusNativeType;
                          update(row.id, {
                            nativeType: next,
                            registerCount: String(registersFor(next) ?? (Number(row.registerCount) || 8)),
                            dataType: dataTypeForNative(next, row.isTimestamp),
                            nullable: next === 'ascii' ? true : row.nullable,
                          });
                        }}
                        className={`${input} min-w-[96px] bg-white`}
                      >
                        {MODBUS_TYPES.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td className={cell}>
                      <input
                        aria-label="Register count"
                        type="number"
                        min={1}
                        value={fixedCount !== null ? String(fixedCount) : row.registerCount || ''}
                        disabled={fixedCount !== null}
                        onChange={(e) => update(row.id, { registerCount: e.target.value })}
                        className={`${mono} w-14 disabled:bg-slate-100`}
                      />
                    </td>
                    <td className={cell}>
                      <select
                        aria-label="Word order"
                        value={row.wordOrder || 'big'}
                        disabled={(fixedCount ?? 1) < 2}
                        onChange={(e) => update(row.id, { wordOrder: e.target.value as 'big' | 'little' })}
                        className={`${input} min-w-[164px] bg-white disabled:bg-slate-100`}
                      >
                        <option value="big">big (high word first)</option>
                        <option value="little">little</option>
                      </select>
                    </td>
                    <td className={`${cell} text-center`}>
                      <input
                        aria-label="Source timestamp"
                        type="checkbox"
                        checked={Boolean(row.isTimestamp)}
                        onChange={(e) =>
                          update(row.id, {
                            isTimestamp: e.target.checked,
                            nativeType: e.target.checked ? 'uint64' : row.nativeType,
                            registerCount: e.target.checked ? '4' : row.registerCount,
                            dataType: dataTypeForNative(e.target.checked ? 'uint64' : type, e.target.checked),
                          })
                        }
                      />
                    </td>
                  </>
                )}
                <td className={cell}>
                  <select aria-label="Signal type" value={row.dataType} onChange={(e) => update(row.id, { dataType: e.target.value as SignalDataType })} className={`${input} min-w-[100px] bg-white`}>
                    {(Object.keys(DATA_TYPE_LABEL) as SignalDataType[]).map((t) => (
                      <option key={t} value={t}>{DATA_TYPE_LABEL[t]}</option>
                    ))}
                  </select>
                </td>
                <td className={cell}>
                  <input aria-label="Unit" value={row.unit} placeholder="—" onChange={(e) => update(row.id, { unit: e.target.value })} className={`${input} w-16`} />
                </td>
                <td className={`${cell} text-center`}>
                  <input aria-label="Nullable" type="checkbox" checked={row.nullable} onChange={(e) => update(row.id, { nullable: e.target.checked })} />
                </td>
                <td className={cell}>
                  <input aria-label="Round digits" type="number" min={0} max={12} value={row.roundDigits} placeholder="—" onChange={(e) => update(row.id, { roundDigits: e.target.value })} className={`${mono} w-12`} />
                </td>
                <td className={`${cell} font-mono text-[11px] text-[#111B37] max-w-[180px] break-all`}>
                  {live !== undefined ? <span className="text-emerald-700" title="Value from the last test">{live}</span> : row.sample ?? '—'}
                </td>
                <td className={`${cell} text-right`}>
                  <button type="button" aria-label={`Remove ${row.key || 'field'}`} onClick={() => remove(row.id)} className="p-1 text-slate-400 hover:text-red-600">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
  );
};
