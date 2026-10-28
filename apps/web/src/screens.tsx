import { flexRender, getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type AuthStatus, type Me } from "./api";
import { isIdentifier, renameIdentifier, tokenizeFormula } from "./formula";
import { formatSignal, formatTime, operatorMessage, plainLabel } from "./format";
import { Empty, PageHead, asText, levelOf, useList, type List, type Row } from "./pages/shared";
import { applyTheme, currentTheme, type ThemeName } from "./theme";
import * as echarts from "echarts";

function FormulaEditor(props: { value: string; alias: string; onChange: (value: string) => void }) {
  const tokens = tokenizeFormula(props.value);
  return (
    <div className="formula-editor">
      <pre aria-hidden="true">
        {tokens.map((token, index) => {
          const known = token.kind === "name" && token.text === props.alias;
          const unknown = token.kind === "name" && token.text !== props.alias;
          const className = known ? "fx-name" : unknown ? "fx-unknown" : token.kind === "call" ? "fx-call" : token.kind === "number" ? "fx-number" : token.kind === "string" ? "fx-string" : "";
          return <span key={`${index}-${token.text}`} className={className}>{token.text}</span>;
        })}
      </pre>
      <textarea aria-label="Expression" spellCheck={false} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </div>
  );
}

function previewRows(values: unknown): { name: string; value: string; unit: string; quality: string }[] {
  if (!values || typeof values !== "object") return [];
  return Object.entries(values as Record<string, unknown>).map(([name, raw]) => {
    if (raw && typeof raw === "object" && "value" in (raw as Row)) {
      const row = raw as Row;
      return { name, value: formatSignal(row.value), unit: row.unit ? String(row.unit) : "—", quality: plainLabel(row.quality) };
    }
    return { name, value: formatSignal(raw), unit: "—", quality: "—" };
  });
}

export function OverviewPage() {
  const { items: edges, error } = useList("/api/v1/edges");
  const [data, setData] = useState<Row | null>(null);
  const [storage, setStorage] = useState<Row | null>(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    api<Row>("/api/v1/overview").then(setData).catch((reason: Error) => setLoadError(reason.message));
    api<Row>("/api/v1/storage/overview").then(setStorage).catch((reason: Error) => setLoadError(reason.message));
  }, []);
  const empty = data && Number(data.resources) === 0;
  return (
    <section>
      <PageHead title="Overview" lede="See what has been declared and what is running." />
      {loadError || error ? <div className="error">{loadError || error}</div> : null}
      {!data ? <p className="muted">Loading…</p> : null}
      {empty ? (
        <ol className="step-list">
          <li><Link to="/factory">Create a site</Link></li>
          <li><Link to="/factory">Build the structure</Link></li>
          <li><Link to="/edges">Create an edge node</Link></li>
          <li><Link to="/collect">Add signals</Link></li>
        </ol>
      ) : null}
      {data && !empty ? (
        <>
          <div className="cards">
            <article className="card"><span>Resources</span><strong>{asText(data.resources)}</strong></article>
            <article className="card"><span>Machines</span><strong>{asText(data.machines)}</strong></article>
            <article className="card"><span>Active connections</span><strong>{asText(data.active_connections)}</strong></article>
            <article className="card"><span>Healthy edges</span><strong>{asText(data.healthy_edges)}</strong></article>
            <article className="card"><span>Records per minute</span><strong>{asText(data.ingest_per_minute)}</strong></article>
          </div>
          <div className="split">
            <section className="panel">
              <h2>Edge nodes</h2>
              {edges && edges.length === 0 ? <Empty>No edge nodes yet.</Empty> : null}
              {edges && edges.length > 0 ? (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Name</th><th>Status</th><th>Running</th><th>Requested</th><th>Queue</th></tr></thead>
                    <tbody>
                      {edges.map((edge) => (
                        <tr key={String(edge.id)}>
                          <td>{asText(edge.name)}</td>
                          <td>{plainLabel(edge.health)}</td>
                          <td>{asText(edge.active_revision)}</td>
                          <td>{asText(edge.desired_revision)}</td>
                          <td>{asText(edge.outbox_pending)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>
            <section className="panel">
              <h2>Storage</h2>
              <p>Records: {asText(storage?.observations)}</p>
              <p>Oldest: {formatTime(storage?.oldest)}</p>
              <p>Newest: {formatTime(storage?.newest)}</p>
              <p>Held aside: {asText(storage?.quarantine)}</p>
              <p className="muted">Updated {formatTime(data.generated_at)}</p>
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function ConnectionsPage() {
  const list = useList("/api/v1/connections");
  const rows = list.items || [];
  return (
    <section>
      <PageHead
        title="Connections"
        lede="Sources an edge node is allowed to read."
        action={<Link className="btn primary small" to="/collect">Add connection</Link>}
      />
      {list.error ? <div className="error">{list.error}</div> : null}
      {list.items && rows.length === 0 ? <Empty>No connections yet. <Link className="text-link" to="/collect">Add connection</Link>.</Empty> : null}
      {rows.length > 0 ? (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Protocol</th><th>Address</th><th>Status</th><th>State</th><th>Last error</th></tr></thead>
            <tbody>
              {rows.map((item) => (
                <tr key={String(item.id)}>
                  <td>{asText(item.name)}</td>
                  <td>{plainLabel(item.protocol)}</td>
                  <td className="mono">{asText(item.endpoint_redacted)}</td>
                  <td>{plainLabel(item.health)}</td>
                  <td>{plainLabel(item.status)}</td>
                  <td>{item.last_error ? operatorMessage(String(item.last_error)) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function SignalsPage() {
  const list = useList("/api/v1/signals");
  const [latest, setLatest] = useState<Record<string, Row>>({});
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState("");
  const ids = useMemo(() => (list.items || []).map((item) => String(item.id)).slice(0, 200), [list.items]);
  useEffect(() => {
    if (ids.length === 0) return;
    api<List>(`/api/v1/observations/latest?signal_ids=${ids.join(",")}`).then((payload) => {
      const map: Record<string, Row> = {};
      payload.items.forEach((item) => { map[String(item.signal_id)] = item; });
      setLatest(map);
    }).catch(() => setLatest({}));
  }, [ids]);
  const columns = useMemo<ColumnDef<Row>[]>(() => [
    { accessorKey: "key", header: "Key", cell: (info) => <span className="mono">{asText(info.getValue())}</span> },
    { accessorKey: "display_name", header: "Name", cell: (info) => asText(info.getValue()) },
    { accessorKey: "resource_code", header: "Resource", cell: (info) => asText(info.getValue()) },
    { id: "value", header: "Value", accessorFn: (row) => latest[String(row.id)]?.value, cell: (info) => formatSignal(info.getValue()) },
    { id: "unit", header: "Unit", accessorFn: (row) => latest[String(row.id)]?.unit || row.unit, cell: (info) => asText(info.getValue()) },
    { id: "quality", header: "Quality", accessorFn: (row) => latest[String(row.id)]?.quality, cell: (info) => plainLabel(info.getValue()) },
    { id: "event_time", header: "Source time", accessorFn: (row) => latest[String(row.id)]?.event_time, cell: (info) => formatTime(info.getValue()) },
  ], [latest]);
  const table = useReactTable({
    data: list.items || [],
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  const rows = list.items || [];
  return (
    <section>
      <PageHead title="Signals" lede="Named values collected from a resource." />
      {list.error ? <div className="error">{list.error}</div> : null}
      {list.items && rows.length === 0 ? <Empty>No signals yet. <Link className="text-link" to="/collect">Add data</Link>.</Empty> : null}
      {rows.length > 0 ? (
        <div className="panel stack">
          <label className="field"><span>Filter</span><input value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
          <div className="table-wrap">
            <table>
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => (
                      <th key={header.id}><button type="button" className="sort-btn" onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}</button></th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id}>
                    {row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function FormulaPage() {
  const signals = useList("/api/v1/signals");
  const formulas = useList("/api/v1/formulas");
  const resources = useList("/api/v1/resources?view=all&limit=200");
  const [open, setOpen] = useState(false);
  const [expression, setExpression] = useState("");
  const [alias, setAlias] = useState("");
  const [boundName, setBoundName] = useState("");
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const signalRows = signals.items || [];

  function changeAlias(next: string) {
    if (isIdentifier(boundName) && isIdentifier(next) && next !== boundName) {
      setExpression((current) => renameIdentifier(current, boundName, next));
      setBoundName(next);
    }
    setAlias(next);
  }

  async function runPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = isIdentifier(alias) ? alias : boundName;
    try {
      const result = await api<Row>("/api/v1/formulas/evaluate-preview", {
        method: "POST",
        body: JSON.stringify({ expression, values: { [name]: Number(form.get("sample") || 0) }, aliases: {} }),
      });
      setPreview(formatSignal(result.value));
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function publishNew(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = isIdentifier(alias) ? alias : boundName;
    const signalId = String(form.get("signal_id") || "");
    try {
      const created = await api<Row>("/api/v1/formulas", {
        method: "POST",
        body: JSON.stringify({
          resource_id: form.get("resource_id"),
          key: form.get("key"),
          display_name: form.get("display_name"),
          expression,
          aliases: { [name]: signalId },
          unit: form.get("unit") || null,
        }),
      });
      await api(`/api/v1/formulas/${created.id}/publish`, { method: "POST" });
      formulas.reload();
      setOpen(false);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  const shownAlias = isIdentifier(alias) ? alias : boundName;
  return (
    <section>
      <PageHead
        title="Calculations"
        lede="Derive a new signal from one that already exists."
        action={signalRows.length > 0 ? <button className="btn primary small" type="button" onClick={() => setOpen(true)}>New calculation</button> : null}
      />
      {error ? <div className="error">{error}</div> : null}
      {signals.items && signalRows.length === 0 ? <Empty>Add a signal before writing a calculation. <Link className="text-link" to="/collect">Add data</Link>.</Empty> : null}
      {open ? (
        <div className="split">
          <form className="panel stack" onSubmit={runPreview}>
            <h2>Preview</h2>
            <label className="field"><span>Expression</span>
              <FormulaEditor value={expression} alias={shownAlias} onChange={setExpression} />
            </label>
            <label className="field"><span>{shownAlias || "Sample"} value</span><input name="sample" inputMode="decimal" /></label>
            <button className="btn primary" type="submit">Run sample</button>
            <p>Result: {preview || "—"}</p>
          </form>
          <form className="panel stack" onSubmit={publishNew}>
            <h2>Publish</h2>
            <label className="field"><span>Resource</span>
              <select name="resource_id" required>{(resources.items || []).map((item) => <option key={String(item.id)} value={String(item.id)}>{asText(item.code)} · {asText(item.name)}</option>)}</select>
            </label>
            <label className="field"><span>Key</span><input name="key" required /></label>
            <label className="field"><span>Name</span><input name="display_name" required /></label>
            <label className="field"><span>Input signal</span>
              <select name="signal_id" required>{signalRows.map((item) => <option key={String(item.id)} value={String(item.id)}>{asText(item.key)}</option>)}</select>
            </label>
            <label className="field"><span>Name in expression</span>
              <input value={alias} onChange={(event) => changeAlias(event.target.value)} />
            </label>
            <label className="field"><span>Output unit</span><input name="unit" /></label>
            <div className="row">
              <button className="btn ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn primary" type="submit">Save and publish</button>
            </div>
          </form>
        </div>
      ) : null}
      {(formulas.items || []).length > 0 ? (
        <section className="panel">
          <h2>Saved</h2>
          {(formulas.items || []).map((item) => <p key={String(item.id)} className="mono">{asText(item.key)} · {plainLabel(item.status)} · {asText(item.expression_source)}</p>)}
        </section>
      ) : null}
    </section>
  );
}

export function OutputPage() {
  const groups = useList("/api/v1/output-groups");
  const [preview, setPreview] = useState<Row | null>(null);
  const rows = groups.items || [];
  const values = previewRows(preview?.values);
  return (
    <section>
      <PageHead title="Output groups" lede="A published view of signals on one resource." />
      {groups.error ? <div className="error">{groups.error}</div> : null}
      {groups.items && rows.length === 0 ? <Empty>No output groups yet. They are created at the end of <Link className="text-link" to="/collect">Add data</Link>.</Empty> : null}
      {rows.length > 0 ? (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Resource</th><th>Key</th><th>Topic</th><th>Members</th><th>State</th><th></th></tr></thead>
            <tbody>
              {rows.map((item) => (
                <tr key={String(item.id)}>
                  <td>{asText(item.resource_code)}</td>
                  <td className="mono">{asText(item.key)}</td>
                  <td className="mono">{asText(item.topic_template)}</td>
                  <td>{asText(item.member_count)}</td>
                  <td>{plainLabel(item.status)}</td>
                  <td><button className="btn ghost small" type="button" onClick={() => api<Row>(`/api/v1/output-groups/${item.id}/preview`).then(setPreview)}>Preview</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {preview ? (
        <section className="panel">
          <h2>Latest values</h2>
          <p className="mono">{asText(preview.topic)}</p>
          {values.length === 0 ? <Empty>No values have been read yet.</Empty> : (
            <table>
              <thead><tr><th>Name</th><th>Value</th><th>Unit</th><th>Quality</th></tr></thead>
              <tbody>
                {values.map((row) => (
                  <tr key={row.name}><td className="mono">{row.name}</td><td>{row.value}</td><td>{row.unit}</td><td>{row.quality}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </section>
  );
}

export function CommissionPage() {
  const list = useList("/api/v1/commissioning");
  const rows = list.items || [];
  return (
    <section>
      <PageHead
        title="Tests"
        lede="Read tests run against a connection."
        action={<button className="btn ghost small" type="button" onClick={list.reload}>Refresh</button>}
      />
      {list.error ? <div className="error">{list.error}</div> : null}
      {list.items && rows.length === 0 ? <Empty>No tests yet. Run one from <Link className="text-link" to="/collect">Add data</Link>.</Empty> : null}
      {rows.length > 0 ? (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Connection</th><th>Protocol</th><th>Status</th><th>Result</th></tr></thead>
            <tbody>
              {rows.map((item) => (
                <tr key={String(item.id)}>
                  <td>{asText(item.connection_name)}</td>
                  <td>{plainLabel(item.protocol)}</td>
                  <td>{plainLabel(item.status)}</td>
                  <td>{item.error_code ? operatorMessage(String(item.error_code)) : "Passed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function EdgePage() {
  const edges = useList("/api/v1/edges");
  const sites = useList("/api/v1/sites");
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [appliance, setAppliance] = useState(false);
  const [queued, setQueued] = useState(false);
  const rows = edges.items || [];

  useEffect(() => {
    api<AuthStatus>("/api/v1/auth/status").then((status) => setAppliance(Boolean(status.appliance))).catch(() => setAppliance(false));
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/v1/edges", { method: "POST", body: JSON.stringify({ name: form.get("name"), site_id: form.get("site_id") }) });
      edges.reload();
      setCreating(false);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function enroll(id: string) {
    const created = await api<Row>(`/api/v1/edges/${id}/enrollment-token`, { method: "POST" });
    setToken(String(created.enrollment_token));
    setQueued(false);
  }

  async function useAppliance(id: string) {
    try {
      await api(`/api/v1/edges/${id}/appliance`, { method: "POST" });
      setToken("");
      setQueued(true);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function publish(id: string) {
    try {
      await api("/api/v1/config-releases/publish", { method: "POST", body: JSON.stringify({ edge_id: id }) });
      edges.reload();
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  return (
    <section>
      <PageHead
        title="Edge nodes"
        lede="The appliance that reads sources and sends records here."
        action={<button className="btn primary small" type="button" onClick={() => setCreating(true)}>Create edge</button>}
      />
      {error ? <div className="error">{error}</div> : null}
      {creating ? (
        <form className="panel stack" onSubmit={create}>
          <h2>Create edge</h2>
          <label className="field"><span>Name</span><input name="name" required /></label>
          <label className="field"><span>Site</span>
            <select name="site_id" required>{(sites.items || []).map((item) => <option key={String(item.id)} value={String(item.id)}>{asText(item.code)}</option>)}</select>
          </label>
          <div className="row">
            <button className="btn ghost" type="button" onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn primary" type="submit" disabled={(sites.items || []).length === 0}>Create edge</button>
          </div>
          {(sites.items || []).length === 0 ? <p className="muted">Create a site on <Link className="text-link" to="/factory">Factory</Link> first.</p> : null}
        </form>
      ) : null}
      {token ? <div className="panel"><h2>Enrollment code</h2><p className="mono">{token}</p><p className="muted">Copy this code now. It is shown once. A test can read a machine only while this edge is running.</p></div> : null}
      {queued ? <div className="panel"><h2>Appliance edge</h2><p>The edge in this appliance will enroll itself. A test can read a machine only after that edge is running and the source is reachable.</p></div> : null}
      {edges.items && rows.length === 0 ? <Empty>No edge nodes yet.</Empty> : null}
      {rows.length > 0 ? (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Status</th><th>Requested</th><th>Running</th><th></th></tr></thead>
            <tbody>
              {rows.map((item) => (
                <tr key={String(item.id)}>
                  <td>{asText(item.name)}</td>
                  <td>{plainLabel(item.health)}</td>
                  <td>{asText(item.desired_revision)}</td>
                  <td>{asText(item.active_revision)}</td>
                  <td className="row">
                    {appliance ? <button className="btn ghost small" type="button" onClick={() => useAppliance(String(item.id))}>Enroll this appliance</button> : <button className="btn ghost small" type="button" onClick={() => enroll(String(item.id))}>Enrollment code</button>}
                    <button className="btn ghost small" type="button" onClick={() => publish(String(item.id))}>Publish</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function DeployPage() {
  const releases = useList("/api/v1/config-releases");
  const rows = releases.items || [];
  return (
    <section>
      <PageHead title="Releases" lede="Configuration sent to an edge node." />
      {releases.error ? <div className="error">{releases.error}</div> : null}
      {releases.items && rows.length === 0 ? <Empty>No releases yet. Publish one from <Link className="text-link" to="/edges">Edge nodes</Link>.</Empty> : null}
      {rows.length > 0 ? (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Edge</th><th>Release</th><th>Status</th><th>Published</th></tr></thead>
            <tbody>
              {rows.map((item) => (
                <tr key={String(item.id)}>
                  <td>{asText(item.edge_name)}</td>
                  <td>{asText(item.revision)}</td>
                  <td>{plainLabel(item.status)}</td>
                  <td>{formatTime(item.published_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function StoragePage() {
  const [data, setData] = useState<Row | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<Row>("/api/v1/storage/overview").then(setData).catch((reason: Error) => setError(reason.message)); }, []);
  const empty = data && Number(data.observations) === 0;
  return (
    <section>
      <PageHead title="Storage" lede="How many records are kept, and how far back they go." />
      {error ? <div className="error">{error}</div> : null}
      {!data ? <p className="muted">Loading…</p> : null}
      {empty ? <Empty>No records yet. <Link className="text-link" to="/edges">Check the edge node</Link>.</Empty> : null}
      {data && !empty ? (
        <>
          <div className="cards">
            <article className="card"><span>Records</span><strong>{asText(data.observations)}</strong></article>
            <article className="card"><span>Held aside</span><strong>{asText(data.quarantine)}</strong></article>
            <article className="card"><span>Duplicate keys</span><strong>{asText(data.dedup_keys)}</strong></article>
            <article className="card"><span>Records per minute</span><strong>{asText(data.ingest_per_minute)}</strong></article>
          </div>
          <p className="muted">Oldest {formatTime(data.oldest)} · Newest {formatTime(data.newest)}</p>
        </>
      ) : null}
    </section>
  );
}

export function HistoryPage() {
  const signals = useList("/api/v1/signals");
  const [params] = useSearchParams();
  const [signalId, setSignalId] = useState(params.get("signal") || "");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!signalId && signals.items && signals.items[0]) setSignalId(String(signals.items[0].id));
  }, [signalId, signals.items]);
  useEffect(() => {
    if (!signalId) {
      setRows([]);
      return;
    }
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    api<List>(`/api/v1/observations/history?signal_id=${signalId}&start=${start.toISOString()}&end=${end.toISOString()}`)
      .then((payload) => setRows(payload.items))
      .catch((reason: Error) => setError(reason.message));
  }, [signalId]);
  const points = useMemo(() => rows.filter((item) => typeof item.value === "number"), [rows]);
  useEffect(() => {
    const node = document.getElementById("history-chart");
    if (!node || points.length === 0) return;
    const style = getComputedStyle(document.documentElement);
    const ink = style.getPropertyValue("--fx-text-secondary").trim() || "#52616d";
    const line = style.getPropertyValue("--fx-border").trim() || "#dde4e8";
    const red = style.getPropertyValue("--avenue-red").trim() || "#e11f25";
    const chart = echarts.init(node);
    chart.setOption({
      backgroundColor: "transparent",
      color: [red],
      textStyle: { fontFamily: "IBM Plex Sans", color: ink },
      tooltip: { trigger: "axis" },
      grid: { left: 48, right: 16, top: 16, bottom: 32 },
      xAxis: { type: "time", axisLine: { lineStyle: { color: line } }, axisLabel: { color: ink } },
      yAxis: { type: "value", scale: true, splitLine: { lineStyle: { color: line } }, axisLabel: { color: ink } },
      series: [{ type: "line", showSymbol: points.length < 40, data: points.map((item) => [item.event_time, item.value]) }],
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.dispose(); };
  }, [points]);
  const none = signals.items && signals.items.length === 0;
  return (
    <section>
      <PageHead title="History" lede="Values recorded for one signal." />
      {none ? <Empty>No signals yet. <Link className="text-link" to="/collect">Add data</Link>.</Empty> : null}
      {!none && (signals.items || []).length > 0 ? (
        <label className="field"><span>Signal</span>
          <select value={signalId} onChange={(event) => setSignalId(event.target.value)}>
            {(signals.items || []).map((item) => <option key={String(item.id)} value={String(item.id)}>{asText(item.resource_code)} / {asText(item.key)}</option>)}
          </select>
        </label>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      {points.length > 0 ? <div id="history-chart" className="chart panel" /> : null}
      {signalId && rows.length === 0 ? <Empty>No records yet. <Link className="text-link" to="/edges">Check the edge node</Link>.</Empty> : null}
      {rows.length > 0 ? (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Value</th><th>Quality</th><th>Origin</th></tr></thead>
            <tbody>
              {rows.slice(0, 50).map((item) => (
                <tr key={String(item.id || item.event_uid)}>
                  <td>{formatTime(item.event_time)}</td>
                  <td>{formatSignal(item.value)}</td>
                  <td>{plainLabel(item.quality)}</td>
                  <td>{plainLabel(item.origin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function DashboardPage() {
  return (
    <section>
      <PageHead title="Dashboards" lede="Dashboards are planned for a later release." />
      <Empty>This release stops at declared data, connections, and history.</Empty>
    </section>
  );
}

export function AuditPage() {
  const list = useList("/api/v1/audit-events");
  const rows = list.items || [];
  return (
    <section>
      <PageHead title="Activity" lede="Changes made on this site." />
      {list.error ? <div className="error">{list.error}</div> : null}
      {list.items && rows.length === 0 ? <Empty>No activity yet.</Empty> : null}
      {rows.length > 0 ? (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Event</th><th>Item</th></tr></thead>
            <tbody>
              {rows.map((item) => (
                <tr key={String(item.id)}>
                  <td>{formatTime(item.occurred_at)}</td>
                  <td>{plainLabel(item.event_type)}</td>
                  <td>{plainLabel(item.entity_type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [theme, setTheme] = useState<ThemeName>(currentTheme);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { api<Me>("/api/v1/auth/me").then(setMe).catch((reason: Error) => setError(reason.message)); }, []);
  function choose(next: ThemeName) {
    applyTheme(next);
    setTheme(next);
  }
  async function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/v1/auth/password", { method: "POST", body: JSON.stringify({ current_password: form.get("current"), new_password: form.get("next") }) });
      setMessage("Password updated.");
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  return (
    <section>
      <PageHead title="Settings" lede="The account signed in on this appliance." />
      {me ? (
        <div className="panel">
          <p>Sign-in name: {me.login}</p>
          <p>Email: {me.email || "—"}</p>
        </div>
      ) : null}
      <div className="panel">
        <h2>Appearance</h2>
        <div className="row">
          <button className={`btn ghost small${theme === "light" ? " choice-on" : ""}`} type="button" role="radio" aria-checked={theme === "light"} onClick={() => choose("light")}>Light</button>
          <button className={`btn ghost small${theme === "dark" ? " choice-on" : ""}`} type="button" role="radio" aria-checked={theme === "dark"} onClick={() => choose("dark")}>Dark</button>
        </div>
      </div>
      <form className="panel stack" onSubmit={change}>
        <h2>Change password</h2>
        <label className="field"><span>Current password</span><input name="current" type="password" required /></label>
        <label className="field"><span>New password</span><input name="next" type="password" required /></label>
        {error ? <div className="error">{error}</div> : null}
        {message ? <p>{message}</p> : null}
        <button className="btn primary" type="submit">Update</button>
      </form>
    </section>
  );
}

export function PlannedPage() {
  const { slug } = useParams();
  const titles: Record<string, string> = { rules: "Rules & Alarms", analytics: "Analytics", reports: "Reports" };
  const title = titles[slug || ""] || "Planned";
  return (
    <section>
      <PageHead title={title} lede="This part is planned for a later release." />
      <Empty>This release stops at declared data, connections, and history.</Empty>
    </section>
  );
}

export function HierarchyPage() {
  const list = useList("/api/v1/hierarchy-presets");
  return (
    <section>
      <PageHead title="Hierarchy" lede="Templates for a factory structure. Use one on Factory." />
      <div className="cards">
        {(list.items || []).map((item) => {
          const levels = Array.isArray(item.levels) ? item.levels : [];
          const name = String(item.name || "");
          return (
            <article className="card" key={name}>
              <strong style={{ fontSize: 18 }}>{asText(item.name)}</strong>
              <ol className="levels">
                {levels.map((level, index) => {
                  const row = levelOf(level);
                  return (
                    <li key={`${row.name}-${index}`}>
                      <span>{row.name}</span>
                      {row.optional ? <span className="muted">Optional</span> : null}
                    </li>
                  );
                })}
              </ol>
              <Link className="btn ghost small" to={`/factory?preset=${encodeURIComponent(name)}`}>Use on Factory</Link>
            </article>
          );
        })}
      </div>
    </section>
  );
}
