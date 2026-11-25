import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Key, Link2, RefreshCw, Table } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Tabs } from '../../components/common/Tabs';
import { Banner, EmptyState, ErrorBanner, LoadingBlock, SearchInput, selectCls } from '../historian/hsUi';
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
              row_count_estimate: t.row_count_estimate ?? t.estimated_rows ?? null,
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

  const est = (n: number | null | undefined) => (n == null || n < 0 ? 'unknown' : `~${n.toLocaleString()}`);
  const tabs = [
    { id: 'erd', label: 'Relationships' },
    ...(selectedTable ? [{ id: 'columns', label: 'Columns & keys' }, { id: 'preview', label: 'Data preview' }] : []),
  ];

  return (
    <div className="space-y-4">
      {/* Read-only banner: states exactly what is enforced (P1-14) */}
      <Banner tone="info">
        <span className="font-semibold">Read-only explorer.</span> Only generated SELECT statements on catalog-validated tables run here (5 s timeout, rows
        of your tenant only). Credential, session and audit tables are hidden and secret values are masked. It uses the application database role, not a
        separate read-only role.
      </Banner>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left: schema + tables */}
        <aside className="lg:col-span-3 bg-white border border-[#CBD5E1] rounded-xl p-3 space-y-3 min-w-0">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="pg-schema" className="text-[11px] font-bold text-[#64748B] uppercase tracking-wider">
                Schema
              </label>
              <button type="button" onClick={fetchSchemas} className="p-1 rounded text-slate-500 hover:bg-slate-100" title="Reload schemas" aria-label="Reload schemas">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            {schemasError ? (
              <ErrorBanner error={schemasError} subject="schemas" onRetry={fetchSchemas} />
            ) : (
              <select id="pg-schema" value={selectedSchema} onChange={(e) => setSelectedSchema(e.target.value)} className={`${selectCls} w-full`}>
                {schemas.map((s) => (
                  <option key={s.schema_name} value={s.schema_name}>
                    {s.schema_name} ({s.table_count} tables)
                  </option>
                ))}
              </select>
            )}
          </div>

          <SearchInput value={searchTable} onChange={setSearchTable} placeholder="Search tables" ariaLabel="Search tables" />

          <div className="space-y-0.5 max-h-[300px] lg:max-h-[520px] overflow-y-auto" role="listbox" aria-label="Tables">
            {tablesLoading ? (
              <LoadingBlock label="Loading tables…" className="py-8" />
            ) : tablesError ? (
              <ErrorBanner error={tablesError} subject="tables" onRetry={() => fetchTables(selectedSchema)} />
            ) : filteredTables.length === 0 ? (
              <p className="py-6 text-center text-[#657794] text-[12px]">{tables.length === 0 ? 'No tables in this schema.' : 'No table matches.'}</p>
            ) : (
              filteredTables.map((t) => (
                <button
                  key={t.table_name}
                  type="button"
                  role="option"
                  aria-selected={selectedTable === t.table_name}
                  onClick={() => {
                    setSelectedTable(t.table_name);
                    setPreviewPage(1);
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left text-[12px] transition-colors ${
                    selectedTable === t.table_name ? 'bg-[#FFF1F2] text-[#111B37] font-semibold' : 'text-[#334568] hover:bg-[#F8FAFC]'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Table className="w-3.5 h-3.5 shrink-0 text-[#64748B]" />
                    <span className="truncate font-mono">{t.table_name}</span>
                  </span>
                  <span className="text-[10px] text-[#94A3B8] font-mono shrink-0" title="Estimated rows">
                    {est(t.row_count_estimate)}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Right: relationships / columns / preview */}
        <section className="lg:col-span-9 bg-white border border-[#CBD5E1] rounded-xl min-w-0">
          <div className="px-4 pt-3 space-y-3">
            <div className="font-mono text-[13px] font-bold text-[#111B37] break-all">
              {selectedSchema}.{selectedTable || '*'}
            </div>
            <Tabs tabs={tabs} activeTab={activeTab} onChange={(id) => setActiveTab(id as 'erd' | 'columns' | 'preview')} />
          </div>

          <div className="p-4">
            {activeTab === 'erd' && (
              <div className="space-y-3">
                <div className="text-[12px] text-[#657794] flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Foreign keys from <code className="font-mono text-[#111B37]">pg_constraint</code>. Click a table to inspect it.
                  </span>
                  <span>{erdData?.relationships.length || 0} relationships</span>
                </div>
                {erdLoading ? (
                  <LoadingBlock label="Loading relationships…" />
                ) : erdError ? (
                  <ErrorBanner error={erdError} subject="relationships" onRetry={() => fetchErd(selectedSchema)} />
                ) : !erdData || erdData.tables.length === 0 ? (
                  <EmptyState dashed title="No relationships">No tables or foreign keys in schema “{selectedSchema}”.</EmptyState>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                    {erdData.tables.map((t) => {
                      const tableName = t.table_name || (t as any).name || '';
                      const outgoing = erdData.relationships.filter((r) => r.source_table === tableName);
                      const isSelected = tableName === selectedTable;
                      return (
                        <button
                          type="button"
                          key={tableName}
                          onClick={() => {
                            setSelectedTable(tableName);
                            setActiveTab('columns');
                          }}
                          className={`text-left p-3 bg-white border rounded-xl transition-all hover:border-[#94A3B8] min-w-0 ${
                            isSelected ? 'border-[#111B37] ring-2 ring-[#111B37]/10' : 'border-[#E3EAF3]'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <Table className="w-4 h-4 text-[#64748B] shrink-0" />
                            <span className="font-mono text-[12px] font-bold text-[#111B37] truncate">{tableName}</span>
                          </div>
                          {outgoing.length > 0 && (
                            <div className="text-[11px] text-[#657794] space-y-0.5 border-t border-[#F1F5FA] mt-2 pt-2">
                              {outgoing.map((rel) => (
                                <div key={rel.constraint_name} className="flex items-center gap-1.5 truncate">
                                  <Link2 className="w-3 h-3 text-[#2A82E7] shrink-0" />
                                  <span className="truncate font-mono">
                                    {rel.source_column} → {rel.target_table}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'columns' && (
              <div className="space-y-4">
                {detailLoading ? (
                  <LoadingBlock label="Loading columns…" />
                ) : detailError ? (
                  <ErrorBanner error={detailError} subject={`the schema of ${selectedTable}`} onRetry={() => selectedTable && fetchTableDetail(selectedSchema, selectedTable)} />
                ) : !tableDetail ? (
                  <EmptyState dashed title="No table selected">Select a table on the left.</EmptyState>
                ) : (
                  <>
                    <div className="border border-[#E3EAF3] rounded-lg overflow-x-auto">
                      <table className="fx-table">
                        <thead>
                          <tr>
                            <th>Column</th>
                            <th>Type</th>
                            <th>Nullable</th>
                            <th>Key</th>
                            <th>Reference</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tableDetail.columns.map((col) => (
                            <tr key={col.column_name}>
                              <td className="font-mono font-semibold text-[#111B37] whitespace-nowrap">{col.column_name}</td>
                              <td className="font-mono whitespace-nowrap">{col.data_type}</td>
                              <td>{col.is_nullable ? 'Yes' : 'No'}</td>
                              <td className="whitespace-nowrap">
                                {col.is_primary_key && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#F1F5FA] text-[#334568] font-bold text-[10px]">
                                    <Key className="w-2.5 h-2.5" /> PK
                                  </span>
                                )}
                                {col.is_foreign_key && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#EEF5FF] text-[#2A82E7] font-bold text-[10px] ml-1">
                                    <Link2 className="w-2.5 h-2.5" /> FK
                                  </span>
                                )}
                              </td>
                              <td className="font-mono text-[11px] text-[#657794]">{col.foreign_table ? `${col.foreign_table}.${col.foreign_column}` : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {tableDetail.indexes && tableDetail.indexes.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-[12px] font-bold text-[#111B37]">Indexes</h4>
                        <div className="border border-[#E3EAF3] rounded-lg overflow-x-auto">
                          <table className="fx-table">
                            <thead>
                              <tr>
                                <th>Index</th>
                                <th>Columns</th>
                                <th>Unique</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tableDetail.indexes.map((idx) => (
                                <tr key={idx.index_name}>
                                  <td className="font-mono text-[#111B37]">{idx.index_name}</td>
                                  <td className="font-mono">{idx.columns.join(', ')}</td>
                                  <td>{idx.is_unique ? 'Yes' : 'No'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {activeTab === 'preview' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#657794]">
                  <span>Sanitized sample, 20 rows per page, sensitive columns masked.</span>
                  <span>Estimated rows: {est(previewRows?.total_estimate)}</span>
                </div>
                {previewLoading ? (
                  <LoadingBlock label={`Loading rows of ${selectedTable}…`} />
                ) : previewError ? (
                  <ErrorBanner error={previewError} subject={`rows of ${selectedTable}`} onRetry={() => selectedTable && fetchTablePreview(selectedSchema, selectedTable, previewPage)} />
                ) : !previewRows || !Array.isArray(previewRows.rows) || previewRows.rows.length === 0 ? (
                  <EmptyState dashed title="No rows">{previewPage > 1 ? 'No more rows.' : `Table “${selectedTable}” has no rows you can see.`}</EmptyState>
                ) : (
                  <div className="border border-[#E3EAF3] rounded-lg overflow-auto max-h-[440px]">
                    <table className="fx-table font-mono">
                      <thead className="sticky top-0 z-[1]">
                        <tr>
                          {previewRows.columns.map((c) => (
                            <th key={c} className="whitespace-nowrap normal-case">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewRows.rows.map((row, idx) => {
                          const cells: unknown[] = Array.isArray(row) ? row : (previewRows.columns || []).map((c) => (row as Record<string, unknown>)?.[c]);
                          return (
                            <tr key={idx}>
                              {cells.map((val, cellIdx) => {
                                const colName = previewRows.columns[cellIdx] || '';
                                return (
                                  <td key={cellIdx} className="text-[12px] text-[#111B37] whitespace-nowrap max-w-[320px] truncate">
                                    {isSensitiveColumn(colName) ? (
                                      <span className="text-[#94A3B8] tracking-widest bg-[#F1F5FA] px-1.5 py-0.5 rounded text-[10px]" title="Sensitive column masked">
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
                {selectedTable && (previewPage > 1 || (previewRows?.rows?.length || 0) >= 20) && (
                  <div className="flex items-center justify-end gap-1.5 text-[12px] text-[#657794]">
                    <Button size="sm" variant="outline" disabled={previewPage <= 1 || previewLoading} onClick={() => setPreviewPage((p) => Math.max(1, p - 1))} aria-label="Previous rows">
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </Button>
                    <span className="tabular-nums px-1">Page {previewPage}</span>
                    <Button size="sm" variant="outline" disabled={previewLoading || (previewRows?.rows?.length || 0) < 20} onClick={() => setPreviewPage((p) => p + 1)} aria-label="Next rows">
                      <ChevronRight className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
