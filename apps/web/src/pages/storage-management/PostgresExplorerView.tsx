import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Database,
  Table,
  Eye,
  Key,
  Link2,
  Lock,
  Layers,
  Search,
  ShieldCheck,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import {
  PgSchema,
  PgTable,
  PgTableDetail,
  PgErdResponse,
  listPgSchemas,
  listPgTables,
  getPgTableDetail,
  getPgErd,
  getPgTablePreview,
} from '../../lib/storagePhysicalApi';
import {
  RemoteErrorState,
  RemoteLoadingState,
  RemoteEmptyState,
} from '../../components/common/RemoteResourceState';

const SENSITIVE_COL_REGEX = /password|secret|token|hash|salt|credential|private_key|auth_key/i;

function isSensitiveColumn(colName: string): boolean {
  return SENSITIVE_COL_REGEX.test(colName);
}

export const PostgresExplorerView: React.FC = () => {
  const [schemas, setSchemas] = useState<PgSchema[]>([]);
  const [selectedSchema, setSelectedSchema] = useState<string>('public');
  const [schemasError, setSchemasError] = useState<unknown | null>(null);

  const [tables, setTables] = useState<PgTable[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tablesError, setTablesError] = useState<unknown | null>(null);
  const [tablesLoading, setTablesLoading] = useState(false);

  const [tableDetail, setTableDetail] = useState<PgTableDetail | null>(null);
  const [detailError, setDetailError] = useState<unknown | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [erdData, setErdData] = useState<PgErdResponse | null>(null);
  const [erdError, setErdError] = useState<unknown | null>(null);
  const [erdLoading, setErdLoading] = useState(false);

  const [activeTab, setActiveTab] = useState<'erd' | 'columns' | 'preview'>('erd');
  const [previewRows, setPreviewRows] = useState<{
    columns: string[];
    rows: (unknown[] | Record<string, unknown>)[];
    total_estimate: number;
  } | null>(null);
  const [previewError, setPreviewError] = useState<unknown | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);

  const [searchTable, setSearchTable] = useState('');

  // 1. Load schemas
  const fetchSchemas = useCallback(() => {
    setSchemasError(null);
    listPgSchemas()
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          const normalized = data.map((s: any) => ({
            schema_name: s.schema_name || s.name || '',
            table_count: s.table_count || 0,
            view_count: s.view_count || 0,
          }));
          setSchemas(normalized);
          const defaultSchema =
            normalized.find((s) => s.schema_name === 'public')?.schema_name || normalized[0].schema_name;
          setSelectedSchema(defaultSchema);
        } else {
          setSchemas([]);
        }
      })
      .catch((err) => {
        console.error('Failed to load PG schemas:', err);
        setSchemasError(err);
        setSchemas([]);
      });
  }, []);

  useEffect(() => {
    fetchSchemas();
  }, [fetchSchemas]);

  // 2. Load tables for selected schema
  const fetchTables = useCallback((schema: string) => {
    if (!schema) return;
    setTablesLoading(true);
    setTablesError(null);
    listPgTables(schema)
      .then((data) => {
        const normalized = Array.isArray(data)
          ? data.map((t: any) => ({
              schema_name: t.schema_name || t.schema || schema,
              table_name: t.table_name || t.name || '',
              table_type: t.table_type || t.type || 'TABLE',
              row_count_estimate: t.row_count_estimate ?? t.estimated_rows ?? 0,
              column_count: t.column_count || 0,
            }))
          : [];
        setTables(normalized);
        if (normalized.length > 0) {
          setSelectedTable((prev) => (prev && normalized.some((t) => t.table_name === prev) ? prev : normalized[0].table_name));
        } else {
          setSelectedTable(null);
        }
      })
      .catch((err) => {
        console.error('Failed to load PG tables:', err);
        setTablesError(err);
        setTables([]);
        setSelectedTable(null);
      })
      .finally(() => setTablesLoading(false));
  }, []);

  useEffect(() => {
    fetchTables(selectedSchema);
  }, [selectedSchema, fetchTables]);

  // 3. Load ERD data for selected schema
  const fetchErd = useCallback((schema: string) => {
    if (!schema) return;
    setErdLoading(true);
    setErdError(null);
    getPgErd(schema)
      .then((res) => {
        const normalizedTables = Array.isArray(res?.tables)
          ? res.tables.map((t: any) => ({
              schema_name: t.schema_name || t.schema || schema,
              table_name: t.table_name || t.name || '',
              table_type: t.table_type || t.type || 'TABLE',
            }))
          : [];
        const normalizedRels = Array.isArray(res?.relationships)
          ? res.relationships.map((r: any) => ({
              constraint_name: r.constraint_name || '',
              source_table: r.source_table || r.from_table || '',
              source_column: r.source_column || r.from_column || '',
              target_table: r.target_table || r.to_table || '',
              target_column: r.target_column || r.to_column || '',
              is_inferred: Boolean(r.is_inferred ?? r.inferred),
            }))
          : [];
        setErdData({
          tables: normalizedTables,
          relationships: normalizedRels,
          source: res?.source || 'pg_constraint',
          observed_at: res?.observed_at || new Date().toISOString(),
        });
      })
      .catch((err) => {
        console.error('Failed to load PG ERD:', err);
        setErdError(err);
        setErdData(null);
      })
      .finally(() => setErdLoading(false));
  }, []);

  useEffect(() => {
    fetchErd(selectedSchema);
  }, [selectedSchema, fetchErd]);

  // 4. Load table detail when selectedTable changes
  const fetchTableDetail = useCallback((schema: string, table: string) => {
    if (!schema || !table) {
      setTableDetail(null);
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    getPgTableDetail(schema, table)
      .then((data) => setTableDetail(data))
      .catch((err) => {
        console.error('Failed to load PG table detail:', err);
        setDetailError(err);
        setTableDetail(null);
      })
      .finally(() => setDetailLoading(false));
  }, []);

  useEffect(() => {
    if (selectedTable) {
      fetchTableDetail(selectedSchema, selectedTable);
    }
  }, [selectedSchema, selectedTable, fetchTableDetail]);

  // 5. Load table preview when selectedTable or page changes
  const fetchTablePreview = useCallback((schema: string, table: string, page: number) => {
    if (!schema || !table) {
      setPreviewRows(null);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    getPgTablePreview(schema, table, { limit: 20, offset: (page - 1) * 20 })
      .then((res) => {
        setPreviewRows(res);
      })
      .catch((err) => {
        console.error('Failed to load PG table preview:', err);
        setPreviewError(err);
        setPreviewRows(null);
      })
      .finally(() => setPreviewLoading(false));
  }, []);

  useEffect(() => {
    if (selectedTable && activeTab === 'preview') {
      fetchTablePreview(selectedSchema, selectedTable, previewPage);
    }
  }, [selectedSchema, selectedTable, activeTab, previewPage, fetchTablePreview]);

  const filteredTables = useMemo(() => {
    return (tables || []).filter((t) => {
      const name = t?.table_name || (t as any)?.name || '';
      return name.toLowerCase().includes((searchTable || '').toLowerCase());
    });
  }, [tables, searchTable]);

  return (
    <div className="space-y-4">
      {/* Strict Read-Only Security Banner */}
      <div className="flex items-center justify-between p-3 bg-[#F0FDF4] border border-[#BBF7D0] rounded-xl text-[12px] text-[#166534]">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#16A34A] shrink-0" />
          <span className="font-semibold">PostgreSQL Explorer (Strict Read-Only)</span>
          <span className="text-[#4ADE80]">•</span>
          <span>
            Connected under bounded query role <code className="bg-[#DCFCE7] px-1.5 py-0.5 rounded font-mono text-[11px]">factorix_explorer_ro</code>.
            DDL, DML, and sensitive admin secret tables are blocked.
          </span>
        </div>
        <span className="px-2 py-0.5 bg-[#DCFCE7] text-[#15803D] font-bold rounded text-[10px] shrink-0">
          SET TRANSACTION READ ONLY
        </span>
      </div>

      {/* Main split explorer */}
      <div className="grid grid-cols-12 gap-4">
        {/* Left schema & table tree */}
        <div className="col-span-3 bg-white border border-[#E3EAF3] rounded-xl shadow-xs p-3 space-y-3">
          {/* Schema select */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-semibold text-[#657794] uppercase tracking-wider">
                Schema
              </label>
              <button
                type="button"
                onClick={fetchSchemas}
                className="text-[11px] text-[#1976D2] hover:underline flex items-center gap-1"
                title="Refresh schemas"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
            {schemasError ? (
              <div className="p-2 bg-[#FEF2F2] border border-[#FAC6C9] rounded text-[11px] text-[#EF1B24]">
                Failed to load schemas
              </div>
            ) : (
              <select
                value={selectedSchema}
                onChange={(e) => setSelectedSchema(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg text-[13px] font-semibold text-[#111B37] focus:outline-none focus:border-[#EF1B24]"
              >
                {schemas.map((s) => (
                  <option key={s.schema_name} value={s.schema_name}>
                    {s.schema_name} ({s.table_count} tables)
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Table search */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#94A3B8] absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search tables..."
              value={searchTable}
              onChange={(e) => setSearchTable(e.target.value)}
              className="w-full pl-8 pr-2.5 py-1.5 bg-[#F8FAFC] border border-[#E3EAF3] rounded-lg text-[12px] text-[#111B37] placeholder-[#94A3B8] focus:outline-none focus:border-[#EF1B24]"
            />
          </div>

          {/* Tables list */}
          <div className="space-y-1 max-h-[500px] overflow-y-auto">
            {tablesLoading ? (
              <div className="py-8 text-center text-[#657794] text-[12px]">
                <RefreshCw className="w-4 h-4 animate-spin text-[#1976D2] mx-auto mb-1.5" />
                Loading tables...
              </div>
            ) : tablesError ? (
              <div className="p-3 bg-[#FEF2F2] border border-[#FAC6C9] rounded-lg text-center">
                <p className="text-[12px] text-[#EF1B24] font-medium mb-1.5">Failed to load tables</p>
                <button
                  type="button"
                  onClick={() => fetchTables(selectedSchema)}
                  className="px-2.5 py-1 bg-white border border-[#FAC6C9] text-[#EF1B24] rounded text-[11px] font-semibold hover:bg-[#FEF2F2]"
                >
                  Retry
                </button>
              </div>
            ) : filteredTables.length === 0 ? (
              <div className="py-6 text-center text-[#8C9BAE] text-[12px] italic">
                {tables.length === 0 ? 'No tables in this schema' : 'No tables match filter'}
              </div>
            ) : (
              filteredTables.map((t) => (
                <button
                  key={t.table_name}
                  type="button"
                  onClick={() => setSelectedTable(t.table_name)}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left text-[12px] transition-colors ${
                    selectedTable === t.table_name
                      ? 'bg-[#E8EEF8] text-[#1976D2] font-semibold'
                      : 'text-[#334155] hover:bg-[#F8FAFC]'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <Table className="w-3.5 h-3.5 shrink-0 text-[#64748B]" />
                    <span className="truncate">{t.table_name}</span>
                  </div>
                  {t.row_count_estimate != null && (
                    <span className="text-[10px] text-[#94A3B8] font-mono shrink-0">
                      ~{t.row_count_estimate.toLocaleString()}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right view: ERD Canvas or Table Details */}
        <div className="col-span-9 bg-white border border-[#E3EAF3] rounded-xl shadow-xs overflow-hidden flex flex-col min-h-[500px]">
          {/* Top header tabs */}
          <div className="px-4 py-3 border-b border-[#E3EAF3] flex items-center justify-between bg-[#F8FAFC]">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] font-bold text-[#111B37]">
                {selectedSchema}.{selectedTable || 'overview'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('erd')}
                className={`px-3 py-1 rounded-md text-[12px] font-semibold transition-colors ${
                  activeTab === 'erd'
                    ? 'bg-white text-[#1976D2] shadow-xs'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
              >
                ER Diagram
              </button>
              <button
                type="button"
                disabled={!selectedTable}
                onClick={() => setActiveTab('columns')}
                className={`px-3 py-1 rounded-md text-[12px] font-semibold transition-colors disabled:opacity-40 ${
                  activeTab === 'columns'
                    ? 'bg-white text-[#1976D2] shadow-xs'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
              >
                Columns & Keys
              </button>
              <button
                type="button"
                disabled={!selectedTable}
                onClick={() => setActiveTab('preview')}
                className={`px-3 py-1 rounded-md text-[12px] font-semibold transition-colors disabled:opacity-40 ${
                  activeTab === 'preview'
                    ? 'bg-white text-[#1976D2] shadow-xs'
                    : 'text-[#657794] hover:text-[#111B37]'
                }`}
              >
                Data Preview
              </button>
            </div>
          </div>

          {/* Tab contents */}
          <div className="p-4 flex-1 overflow-y-auto">
            {activeTab === 'erd' && (
              <div className="space-y-4">
                <div className="text-[12px] text-[#657794] flex items-center justify-between">
                  <span>
                    Foreign key constraints from <code className="font-mono text-[#111B37]">pg_constraint</code>. Solid lines denote real FKs.
                  </span>
                  <span className="text-[11px] text-[#94A3B8]">
                    {erdData?.relationships.length || 0} relationships
                  </span>
                </div>

                {erdLoading ? (
                  <RemoteLoadingState subject="foreign key ERD" />
                ) : erdError ? (
                  <RemoteErrorState
                    error={erdError}
                    subject="PostgreSQL ERD"
                    onRetry={() => fetchErd(selectedSchema)}
                  />
                ) : !erdData || erdData.tables.length === 0 ? (
                  <RemoteEmptyState
                    title="No ERD Data Available"
                    description={`No tables or foreign keys found in schema "${selectedSchema}".`}
                    icon={Database}
                  />
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {erdData.tables.map((t) => {
                      const tableName = t.table_name || (t as any).name || '';
                      const outgoing = erdData.relationships.filter(
                        (r) => r.source_table === tableName
                      );
                      const isSelected = tableName === selectedTable;

                      return (
                        <div
                          key={tableName}
                          onClick={() => setSelectedTable(tableName)}
                          className={`p-3.5 bg-white border-2 rounded-xl cursor-pointer transition-all hover:shadow-sm ${
                            isSelected
                              ? 'border-[#1976D2] ring-2 ring-[#1976D2]/20'
                              : 'border-[#E3EAF3] hover:border-[#CBD5E1]'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <Table className="w-4 h-4 text-[#1976D2]" />
                            <span className="font-mono text-[12px] font-bold text-[#111B37] truncate">
                              {tableName}
                            </span>
                          </div>

                          {outgoing.length > 0 && (
                            <div className="text-[11px] text-[#657794] space-y-1 border-t border-[#E3EAF3] pt-2">
                              {outgoing.map((rel) => (
                                <div key={rel.constraint_name} className="flex items-center gap-1.5 truncate">
                                  <Link2 className="w-3 h-3 text-[#1976D2] shrink-0" />
                                  <span className="truncate">
                                    {rel.source_column} &rarr; {rel.target_table}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'columns' && (
              <div className="space-y-4">
                {detailLoading ? (
                  <RemoteLoadingState subject="columns and keys" />
                ) : detailError ? (
                  <RemoteErrorState
                    error={detailError}
                    subject={`Schema for "${selectedTable}"`}
                    onRetry={() => selectedTable && fetchTableDetail(selectedSchema, selectedTable)}
                  />
                ) : !tableDetail ? (
                  <RemoteEmptyState
                    title="No Table Selected"
                    description="Select a table on the left to inspect its columns, keys, and indexes."
                    icon={Table}
                  />
                ) : (
                  <>
                    {/* Columns table */}
                    <div className="border border-[#E3EAF3] rounded-lg overflow-hidden">
                      <table className="w-full text-left text-[12px]">
                        <thead className="bg-[#F8FAFC] border-b border-[#E3EAF3] text-[#657794] font-semibold">
                          <tr>
                            <th className="py-2.5 px-3">Column</th>
                            <th className="py-2.5 px-3">Type</th>
                            <th className="py-2.5 px-3">Nullable</th>
                            <th className="py-2.5 px-3">Key</th>
                            <th className="py-2.5 px-3">Reference</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5FA]">
                          {tableDetail.columns.map((col) => (
                            <tr key={col.column_name} className="hover:bg-[#F8FAFC]">
                              <td className="py-2 px-3 font-mono font-semibold text-[#111B37]">
                                {col.column_name}
                              </td>
                              <td className="py-2 px-3 font-mono text-[#657794]">{col.data_type}</td>
                              <td className="py-2 px-3 text-[#657794]">{col.is_nullable ? 'YES' : 'NO'}</td>
                              <td className="py-2 px-3">
                                {col.is_primary_key && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#FEF2F2] text-[#EF1B24] font-bold text-[10px]">
                                    <Key className="w-2.5 h-2.5" /> PK
                                  </span>
                                )}
                                {col.is_foreign_key && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#EFF6FF] text-[#1D4ED8] font-bold text-[10px] ml-1">
                                    <Link2 className="w-2.5 h-2.5" /> FK
                                  </span>
                                )}
                              </td>
                              <td className="py-2 px-3 font-mono text-[11px] text-[#657794]">
                                {col.foreign_table ? `${col.foreign_table}.${col.foreign_column}` : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Indexes list */}
                    {tableDetail.indexes && tableDetail.indexes.length > 0 && (
                      <div>
                        <h4 className="text-[12px] font-bold text-[#111B37] mb-2">Indexes</h4>
                        <div className="border border-[#E3EAF3] rounded-lg divide-y divide-[#F1F5FA] overflow-hidden text-[12px]">
                          {tableDetail.indexes.map((idx) => (
                            <div key={idx.index_name} className="px-3 py-2 flex items-center justify-between">
                              <span className="font-mono text-[#111B37]">{idx.index_name}</span>
                              <span className="text-[#657794] font-mono text-[11px]">
                                ({idx.columns.join(', ')}) {idx.is_unique ? '[UNIQUE]' : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {activeTab === 'preview' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-[11px] text-[#657794]">
                  <span>Showing sanitized sample (first 20 rows, sensitive columns masked).</span>
                  <span>Estimated rows: ~{previewRows?.total_estimate?.toLocaleString() || 0}</span>
                </div>

                {previewLoading ? (
                  <RemoteLoadingState subject={`sanitized rows for "${selectedTable}"`} />
                ) : previewError ? (
                  <RemoteErrorState
                    error={previewError}
                    subject={`Data Preview for "${selectedTable}"`}
                    onRetry={() => selectedTable && fetchTablePreview(selectedSchema, selectedTable, previewPage)}
                  />
                ) : !previewRows || !Array.isArray(previewRows.rows) || previewRows.rows.length === 0 ? (
                  <RemoteEmptyState
                    title="No Records Found"
                    description={`Table "${selectedTable}" contains 0 records in schema "${selectedSchema}".`}
                    icon={Table}
                  />
                ) : (
                  <div className="border border-[#E3EAF3] rounded-lg overflow-x-auto max-h-[400px]">
                    <table className="w-full text-left text-[12px] font-mono">
                      <thead className="bg-[#F8FAFC] border-b border-[#E3EAF3] text-[#657794] sticky top-0">
                        <tr>
                          {previewRows.columns.map((c) => (
                            <th key={c} className="py-2 px-3 whitespace-nowrap">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F1F5FA]">
                        {previewRows.rows.map((row, idx) => {
                          const cells: unknown[] = Array.isArray(row)
                            ? row
                            : (previewRows.columns || []).map((c) => (row as Record<string, unknown>)?.[c]);
                          return (
                            <tr key={idx} className="hover:bg-[#F8FAFC]">
                              {cells.map((val, cellIdx) => {
                                const colName = previewRows.columns[cellIdx] || '';
                                const isSensitive = isSensitiveColumn(colName);
                                return (
                                  <td key={cellIdx} className="py-1.5 px-3 text-[#111B37] whitespace-nowrap">
                                    {isSensitive ? (
                                      <span
                                        className="text-[#94A3B8] font-mono tracking-widest bg-[#F1F5FA] px-1.5 py-0.5 rounded text-[10px]"
                                        title="Sensitive credential column masked"
                                      >
                                        ••••••••
                                      </span>
                                    ) : val === null || val === undefined ? (
                                      <span className="text-[#94A3B8] italic">null</span>
                                    ) : typeof val === 'object' ? (
                                      JSON.stringify(val)
                                    ) : (
                                      String(val)
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
