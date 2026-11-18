/**
 * Read-only views of one TDengine storage object, shared by the drawer and the detail page so both
 * show the same properties, schema tables, bindings and DDL (Data Collector / Data Models look).
 */
import React from 'react';
import { Database, Layers, Table } from 'lucide-react';
import { StatusBadge } from '../../components/common/StatusBadge';
import type { TDDatabase, TDStable, TDSubtable } from '../../lib/storagePhysicalApi';
import { EmptyState, TimeCell } from '../historian/hsUi';

export type StorageKind = 'database' | 'stable' | 'subtable';
export type StorageObjectData = (TDDatabase | TDStable | TDSubtable) & { object_type: StorageKind };

export function kindOfId(id: string): StorageKind {
  if (id.startsWith('db:') || id.startsWith('db/')) return 'database';
  if (id.startsWith('stable:') || id.startsWith('stable/')) return 'stable';
  return 'subtable';
}

export const KIND_LABEL: Record<StorageKind, string> = { database: 'Database', stable: 'Supertable', subtable: 'Subtable' };

/** 16 px type glyph: DB ink, STable info, Subtable violet (tokens only, icons only). */
export const StorageTypeIcon: React.FC<{ kind: string; className?: string }> = ({ kind, className = 'w-4 h-4' }) => {
  if (kind === 'database') return <Database className={`${className} text-[#111B37] shrink-0`} aria-hidden="true" />;
  if (kind === 'stable') return <Layers className={`${className} text-[#2A82E7] shrink-0`} aria-hidden="true" />;
  return <Table className={`${className} text-[#8858EA] shrink-0`} aria-hidden="true" />;
};

/** Storage status → the shared StatusBadge ("● Active", "● Paused", …). */
export const StorageStatusBadge: React.FC<{ status?: string | null }> = ({ status }) => {
  const s = String(status || 'UNKNOWN').toUpperCase();
  if (s === 'OUT_OF_SYNC') return <StatusBadge status="WARN" label="Out of sync" />;
  if (s === 'RETIRED') return <StatusBadge status="DISABLED" label="Retired" />;
  if (s === 'READ_ONLY') return <StatusBadge status="DISABLED" label="Read-only" />;
  if (s === 'CREATING' || s === 'VERIFYING') return <StatusBadge status="UNCERTAIN" label={s === 'CREATING' ? 'Creating…' : 'Verifying…'} />;
  return <StatusBadge status={s} />;
};

/** "Historian" deep link of a subtable (token `subtable:<db>.<table>`). */
export function historianLinkFor(objectId: string, range = '24h'): string {
  const token = objectId.startsWith('subtable:') ? objectId : `subtable:${objectId}`;
  return `/historian/historian?sources=${encodeURIComponent(token)}&range=${range}`;
}

const SIZED = ['VARCHAR', 'NCHAR', 'BINARY', 'VARBINARY'];
const sized = (type: string, length?: number | null) =>
  length && SIZED.includes(String(type).toUpperCase()) && !String(type).includes('(') ? `${type}(${length})` : type;

/** Schema as DDL, reconstructed from DESCRIBE (what TDengine reports, not what a wizard planned). */
export function ddlOf(obj: StorageObjectData): string {
  if (obj.object_type === 'database') {
    const db = obj as unknown as TDDatabase;
    return `CREATE DATABASE \`${db.physical_name}\` PRECISION '${db.precision || 'us'}'${db.retention_days ? ` KEEP ${db.retention_days}` : ''};`;
  }
  if (obj.object_type === 'stable') {
    const st = obj as unknown as TDStable;
    return (
      `CREATE STABLE \`${st.database_name}\`.\`${st.physical_name}\` (\n` +
      (st.columns || [])
        .map((c) => `  \`${c.name}\` ${sized(c.td_type, c.length)}${c.primary_key ? ' COMPOSITE KEY' : ''}`)
        .join(',\n') +
      `\n) TAGS (\n` +
      (st.tags || []).map((t) => `  \`${t.name}\` ${sized(t.td_type, t.length)}`).join(',\n') +
      `\n);`
    );
  }
  const sub = obj as unknown as TDSubtable;
  return (
    `CREATE TABLE \`${sub.database_name}\`.\`${sub.physical_name}\` USING \`${sub.database_name}\`.\`${sub.stable_name}\` TAGS (\n` +
    (sub.tag_values || []).map((t) => `  '${String(t.value ?? '').replace(/'/g, "''")}'  -- ${t.name}`).join(',\n') +
    `\n);`
  );
}

/** Small "label / value" tiles (Model wizard review style). */
export const PropGrid: React.FC<{ items: [string, React.ReactNode][]; cols?: string }> = ({ items, cols = 'grid-cols-2' }) => (
  <dl className={`grid ${cols} gap-3`}>
    {items.map(([k, v]) => (
      <div key={k} className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 min-w-0">
        <dt className="text-[10px] font-bold uppercase tracking-wide text-[#657794]">{k}</dt>
        <dd className="text-[13px] font-semibold text-[#111B37] truncate" title={typeof v === 'string' ? v : undefined}>
          {v}
        </dd>
      </div>
    ))}
  </dl>
);

export function propItems(obj: StorageObjectData): [string, React.ReactNode][] {
  const items: [string, React.ReactNode][] = [['Status', <StorageStatusBadge key="s" status={obj.status} />]];
  if (obj.object_type === 'database') {
    const db = obj as unknown as TDDatabase;
    items.push(['Precision', db.precision || '—'], ['Retention', db.retention_days ? `${db.retention_days} days` : 'Unlimited']);
    if (db.stable_count != null) items.push(['Supertables', String(db.stable_count)]);
    if (db.subtable_count != null) items.push(['Subtables', String(db.subtable_count)]);
  } else if (obj.object_type === 'stable') {
    const st = obj as unknown as TDStable;
    items.push(['Database', st.database_name || '—'], ['Subtables', String(st.subtable_count ?? '—')]);
    items.push(['Columns', String(st.columns?.length ?? '—')], ['Tags', String(st.tags?.length ?? '—')]);
    if (st.default_recording_mode) items.push(['Default recording', st.default_recording_mode.replace(/_/g, ' ').toLowerCase()]);
  } else {
    const sub = obj as unknown as TDSubtable & { parent_name?: string };
    items.push(['Supertable', sub.stable_name || sub.parent_name || '—'], ['Database', sub.database_name || '—']);
    items.push(['Recording', sub.recording_mode ? sub.recording_mode.replace(/_/g, ' ').toLowerCase() : '—']);
    items.push(['Bindings', String(sub.bindings?.length ?? 0)]);
    if (sub.latest_row_at) items.push(['Last row', <TimeCell key="lr" iso={sub.latest_row_at} />]);
  }
  items.push(['Observed', <TimeCell key="o" iso={obj.observed_at} />]);
  return items;
}

export const ColumnsTable: React.FC<{ stable: TDStable }> = ({ stable }) => (
  <div className="border border-[#E3EAF3] rounded-lg overflow-x-auto">
    <table className="fx-table">
      <thead>
        <tr>
          <th>Column</th>
          <th>Type</th>
          <th>Role</th>
          <th>Nullable</th>
        </tr>
      </thead>
      <tbody>
        {(stable.columns || []).map((c, i) => (
          <tr key={c.name}>
            <td className="font-mono font-semibold text-[#111B37] whitespace-nowrap">
              {c.name}
              {i === 0 && <span className="ml-2 text-[10px] font-bold text-[#657794]">TIMESTAMP KEY</span>}
              {c.primary_key && <span className="ml-2 text-[10px] font-bold text-[#657794]">COMPOSITE KEY</span>}
            </td>
            <td className="font-mono whitespace-nowrap">{sized(c.td_type, c.length)}</td>
            <td className="capitalize">{c.role || '—'}</td>
            <td>{c.nullable ? 'Yes' : 'No'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const TagsTable: React.FC<{ tags: { name: string; td_type?: string; length?: number | null; value?: string | null }[]; withValues?: boolean }> = ({ tags, withValues }) =>
  tags.length === 0 ? (
    <p className="text-[12px] text-[#657794]">No tags.</p>
  ) : (
    <div className="border border-[#E3EAF3] rounded-lg overflow-x-auto">
      <table className="fx-table">
        <thead>
          <tr>
            <th>Tag</th>
            {withValues ? <th>Value</th> : <th>Type</th>}
          </tr>
        </thead>
        <tbody>
          {tags.map((t) => (
            <tr key={t.name}>
              <td className="font-mono font-semibold text-[#111B37] whitespace-nowrap">{t.name}</td>
              <td className="font-mono break-all">{withValues ? (t.value ?? '—') : sized(t.td_type || '', t.length)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

export const BindingsList: React.FC<{ subtable: TDSubtable }> = ({ subtable }) => {
  const list = subtable.bindings || [];
  if (list.length === 0) return <EmptyState dashed title="No binding">Nothing is recorded into this subtable yet. Edit it to bind a Data Model field.</EmptyState>;
  return (
    <div className="border border-[#E3EAF3] rounded-lg overflow-x-auto">
      <table className="fx-table">
        <thead>
          <tr>
            <th>Column</th>
            <th>Source</th>
            <th>Recording</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {list.map((raw) => {
            const b = raw as typeof raw & { column_name?: string; model_name?: string; model_field_path?: string; signal_key?: string };
            return (
              <tr key={b.id}>
                <td className="font-mono font-semibold text-[#111B37] whitespace-nowrap">{b.column_name || b.destination_column}</td>
                <td className="min-w-[180px]">
                  <div className="text-[#111B37]">{b.model_name || b.signal_key || (b.source_kind === 'model_field' ? 'Data Model field' : 'Signal')}</div>
                  <div className="font-mono text-[11px] text-[#657794] break-all">{b.model_field_path || b.source_path}</div>
                </td>
                <td className="whitespace-nowrap">{(b.recording_mode || 'ON_CHANGE').replace(/_/g, ' ').toLowerCase()}</td>
                <td>
                  <StorageStatusBadge status={b.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export const DdlBlock: React.FC<{ obj: StorageObjectData }> = ({ obj }) => (
  <div className="space-y-2">
    <p className="text-[12px] text-[#657794]">Reconstructed from what TDengine reports (DESCRIBE), not from the wizard input.</p>
    <pre className="p-4 bg-[#111B37] text-white rounded-lg font-mono text-[12px] overflow-x-auto leading-relaxed whitespace-pre">{ddlOf(obj)}</pre>
  </div>
);
