import { FormEvent, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { formatSignal, operatorMessage, plainLabel } from "../format";
import { LEVEL_LABEL, PageHead, asText, jsonLeaves, useList, type JsonLeaf, type Row } from "./shared";

const STEPS = ["Context", "Source", "Discover", "Map", "Test", "Publish"];
const PROTOCOLS = [
  { key: "modbus_tcp", label: "Modbus TCP" },
  { key: "opcua", label: "OPC UA" },
  { key: "mqtt", label: "MQTT" },
  { key: "http", label: "HTTP" },
];
const DEFAULT_TOPIC = "fx/v1/{enterprise}/{site}/{plant}/{zone}/{line}/{resource}/{group}";

type Draft = {
  key: string;
  name: string;
  unit: string;
  dataType: string;
  addressKind: string;
  address: Record<string, unknown>;
};

function counts(type: string): number {
  if (type === "float64") return 4;
  if (type === "float32" || type === "int32" || type === "uint32") return 2;
  return 1;
}

function dataTypeOf(native: string): string {
  if (native === "bool") return "bool";
  if (native === "string") return "string";
  if (native.startsWith("int") || native.startsWith("uint")) return "int64";
  return "float64";
}

function signalKey(value: string, fallback: string): string {
  const leaf = value.split(".").pop() || fallback;
  const key = leaf.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "").slice(0, 64);
  return key || fallback;
}

function testSummary(job: Row, finished: boolean): string {
  const status = String(job.status || "");
  if (status === "PENDING" || status === "RUNNING") {
    return finished
      ? "No result yet. The edge is not running, or it has not reported."
      : "Waiting for the edge. No result yet.";
  }
  if (status === "PASSED") return "The test passed.";
  const stages = Array.isArray(job.stages_json) ? (job.stages_json as Row[]) : [];
  const failed = stages.find((item) => String(item.status || item.state || "") === "FAILED");
  const stage = failed ? String(failed.name || failed.stage || "") : "";
  const sentence = operatorMessage(job.error_code ? String(job.error_code) : undefined);
  return stage ? `${sentence} Failed at ${stage}.` : sentence;
}

export function CollectPage() {
  const [params] = useSearchParams();
  const resources = useList("/api/v1/resources?view=all&limit=200");
  const edges = useList("/api/v1/edges");
  const connections = useList("/api/v1/connections");
  const [step, setStep] = useState(0);
  const [resourceId, setResourceId] = useState(params.get("resource") || "");
  const [edgeId, setEdgeId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [jobId, setJobId] = useState("");
  const [protocol, setProtocol] = useState("modbus_tcp");
  const [rows, setRows] = useState<Draft[]>([]);
  const [paste, setPaste] = useState("");
  const [sample, setSample] = useState('{"factory":{"machine":{"name":"line-1","temperature":84.95}}}');
  const [topic, setTopic] = useState("factory/line-1/telemetry");
  const [path, setPath] = useState("/status");
  const [httpAuth, setHttpAuth] = useState("none");
  const [leaves, setLeaves] = useState<JsonLeaf[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [units, setUnits] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [signalIds, setSignalIds] = useState<string[]>([]);
  const [aliases, setAliases] = useState<string[]>([]);
  const [test, setTest] = useState<Row | null>(null);
  const [testDone, setTestDone] = useState(false);
  const [release, setRelease] = useState<Row | null>(null);
  const [groupTopic, setGroupTopic] = useState(DEFAULT_TOPIC);
  const [groupPreview, setGroupPreview] = useState<{ topic: string; rows: { name: string; value: string; quality: string }[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const resource = (resources.items || []).find((item) => String(item.id) === resourceId);
  const siteId = resource?.site_id ? String(resource.site_id) : "";
  const siteEdges = (edges.items || []).filter((item) => !siteId || String(item.site_id) === siteId);
  const siteConnections = (connections.items || []).filter((item) => !siteId || String(item.site_id) === siteId);
  const grouped = useMemo(() => {
    const codes = new Map((resources.items || []).map((item) => [String(item.id), asText(item.code)]));
    const groups = new Map<string, Row[]>();
    for (const item of resources.items || []) {
      const key = String(item.type_key || "resource");
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    return { codes, groups };
  }, [resources.items]);

  const parsedLeaves = useMemo(() => {
    try {
      return jsonLeaves(JSON.parse(sample));
    } catch {
      return [];
    }
  }, [sample]);

  function back() {
    setError("");
    setStep((current) => Math.max(0, current - 1));
  }

  async function chooseConnection(id: string) {
    setConnectionId(id);
    if (!id) return;
    const detail = await api<Row>(`/api/v1/connections/${id}`);
    const jobs = Array.isArray(detail.jobs) ? (detail.jobs as Row[]) : [];
    setJobId(jobs[0] ? String(jobs[0].id) : "");
    setProtocol(String(detail.protocol || protocol));
    setEdgeId(String(detail.edge_id || edgeId));
  }

  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connectionId) {
      setStep(2);
      return;
    }
    const form = new FormData(event.currentTarget);
    const config: Record<string, unknown> = {};
    let secret = "";
    if (protocol === "modbus_tcp") {
      config.host = form.get("host");
      config.port = Number(form.get("port") || 502);
      config.unit_id = Number(form.get("unit_id") || 1);
      config.timeout_ms = 2000;
      config.retries = 1;
    } else if (protocol === "opcua") {
      config.endpoint = form.get("endpoint");
      config.security_mode = "None";
      config.allow_insecure = true;
      config.anonymous = true;
    } else if (protocol === "mqtt") {
      const username = String(form.get("username") || "").trim();
      secret = String(form.get("secret") || "");
      if (secret && !username) {
        setError("Enter a username with the password.");
        return;
      }
      config.host = form.get("host");
      config.port = Number(form.get("port") || 1883);
      config.topics = [String(form.get("topics") || topic)];
      config.anonymous = !username;
      config.qos = 0;
      if (username) config.username = username;
    } else {
      secret = String(form.get("secret") || "");
      config.base_url = form.get("base_url");
      config.path = form.get("path") || path;
      config.auth = httpAuth;
      config.header_name = String(form.get("header_name") || "X-API-Key");
      if (httpAuth !== "none" && !secret) {
        setError("Enter the API key.");
        return;
      }
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.get("name"),
        site_id: siteId,
        edge_id: form.get("edge_id"),
        protocol,
        config,
      };
      if (secret) body.secret_input = secret;
      const created = await api<Row>("/api/v1/connections", { method: "POST", body: JSON.stringify(body) });
      const jobs = Array.isArray(created.jobs) ? (created.jobs as Row[]) : [];
      setConnectionId(String(created.id));
      setJobId(jobs[0] ? String(jobs[0].id) : "");
      setEdgeId(String(form.get("edge_id") || ""));
      if (protocol === "mqtt") setTopic(String(form.get("topics") || topic));
      if (protocol === "http") setPath(String(form.get("path") || path));
      connections.reload();
      setError("");
      setStep(2);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function prepareMap() {
    if (protocol === "modbus_tcp" || protocol === "opcua") {
      if (rows.length === 0) {
        setError("Add at least one address.");
        return;
      }
      setError("");
      setStep(3);
      return;
    }
    if (parsedLeaves.length === 0) {
      setError("The sample is not valid JSON.");
      return;
    }
    setLeaves(parsedLeaves);
    const nextPicked: Record<string, boolean> = {};
    const nextNames: Record<string, string> = {};
    parsedLeaves.forEach((leaf) => {
      if (!leaf.many) nextPicked[leaf.path] = true;
      nextNames[leaf.path] = names[leaf.path] || signalKey(leaf.path, "value");
    });
    setPicked(nextPicked);
    setNames((current) => ({ ...nextNames, ...current }));
    setError("");
    setStep(3);
  }

  function applyPaste() {
    const added: Draft[] = [];
    for (const line of paste.split(/\r?\n/)) {
      const parts = line.split(",").map((item) => item.trim());
      if (!parts[0] || !parts[1]) continue;
      if (protocol === "modbus_tcp") {
        const native = parts[2] || "uint16";
        added.push({
          key: signalKey(parts[0], `reg_${rows.length + added.length}`),
          name: parts[0],
          unit: parts[3] || "",
          dataType: dataTypeOf(native),
          addressKind: "modbus_register",
          address: { offset: Number(parts[1]), register_area: "holding", native_type: native, register_count: counts(native), word_order: "big" },
        });
      } else {
        added.push({
          key: signalKey(parts[0], `node_${rows.length + added.length}`),
          name: parts[0],
          unit: parts[3] || "",
          dataType: "float64",
          addressKind: "opcua_node",
          address: { node_id: parts[1] },
        });
      }
    }
    if (added.length === 0) {
      setError("Paste one address per line: name, offset, type, unit.");
      return;
    }
    setRows((current) => [...current, ...added]);
    setPaste("");
    setError("");
  }

  function addModbus() {
    setRows((current) => [...current, {
      key: `reg_${current.length}`,
      name: `Register ${current.length}`,
      unit: "",
      dataType: dataTypeOf("uint16"),
      addressKind: "modbus_register",
      address: { offset: current.length, register_area: "holding", native_type: "uint16", register_count: 1, word_order: "big" },
    }]);
  }

  function addNode() {
    setRows((current) => [...current, {
      key: `node_${current.length}`,
      name: `Node ${current.length}`,
      unit: "",
      dataType: "float64",
      addressKind: "opcua_node",
      address: { node_id: "ns=2;s=Machine.Value" },
    }]);
  }

  function patchRow(index: number, patch: Partial<Draft>) {
    setRows((current) => current.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  }

  async function previewLeaf(leaf: JsonLeaf) {
    try {
      const result = await api<Row>("/api/v1/mappings/preview", {
        method: "POST",
        body: JSON.stringify({ expression: leaf.path, document: JSON.parse(sample) }),
      });
      setPreviews((current) => ({ ...current, [leaf.path]: result.present ? asText(result.value) : "Not in the sample" }));
    } catch (reason) {
      setPreviews((current) => ({ ...current, [leaf.path]: (reason as Error).message }));
    }
  }

  async function saveSignals() {
    const selected = protocol === "modbus_tcp" || protocol === "opcua"
      ? rows
      : leaves.filter((leaf) => picked[leaf.path] && !leaf.many).map((leaf) => {
          const label = (names[leaf.path] || "").trim() || signalKey(leaf.path, "value");
          return {
          key: signalKey(label, "value"),
          name: label,
          unit: units[leaf.path] || "",
          dataType: "float64",
          addressKind: "json_path",
          address: protocol === "mqtt" ? { topic, jsonpath: leaf.path } : { path, jsonpath: leaf.path },
        };
        });
    if (!jobId || selected.length === 0) {
      setError("Choose at least one single value.");
      return;
    }
    setBusy(true);
    try {
      const created = await api<{ created: string[] }>("/api/v1/signals/bulk", {
        method: "POST",
        body: JSON.stringify({
          resource_id: resourceId,
          atomic: true,
          items: selected.map((row) => ({
            key: row.key,
            name: row.name,
            data_type: dataTypeOf(row.dataType),
            unit: row.unit || null,
            source_field: { acquisition_job_id: jobId, address_kind: row.addressKind, address: row.address },
          })),
        }),
      });
      setSignalIds(created.created);
      setAliases(selected.map((row) => row.key));
      setError("");
      setStep(4);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setBusy(true);
    setTestDone(false);
    try {
      const job = await api<Row>(`/api/v1/connections/${connectionId}/commission`, { method: "POST", body: "{}" });
      setTest(job);
      let latest = job;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        latest = await api<Row>(`/api/v1/commissioning/${job.id}`);
        setTest(latest);
        if (latest.status !== "PENDING" && latest.status !== "RUNNING") break;
      }
      setTestDone(latest.status === "PENDING" || latest.status === "RUNNING");
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true);
    try {
      setRelease(await api<Row>("/api/v1/config-releases/publish", { method: "POST", body: JSON.stringify({ edge_id: edgeId }) }));
      setError("");
      setStep(5);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const group = await api<Row>("/api/v1/output-groups", {
        method: "POST",
        body: JSON.stringify({
          resource_id: resourceId,
          key: form.get("key"),
          display_name: form.get("display_name"),
          topic_template: groupTopic,
          members: signalIds.map((id, index) => ({ signal_id: id, alias: aliases[index] || `signal_${index + 1}` })),
        }),
      });
      const preview = await api<Row>(`/api/v1/output-groups/${group.id}/preview`);
      const values = preview.values && typeof preview.values === "object" ? preview.values as Record<string, unknown> : {};
      setGroupPreview({
        topic: String(preview.topic || groupTopic),
        rows: Object.entries(values).map(([name, raw]) => {
          if (raw && typeof raw === "object" && "value" in (raw as Row)) {
            const row = raw as Row;
            return { name, value: formatSignal(row.value), quality: plainLabel(row.quality) };
          }
          return { name, value: formatSignal(raw), quality: "—" };
        }),
      });
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  return (
    <section>
      <PageHead title="Add data" lede="Connect a source, map its values, and publish them to an edge." />
      <ol className="steps">
        {STEPS.map((label, index) => (
          <li key={label} data-state={index < step ? "done" : index === step ? "current" : "todo"} aria-current={index === step ? "step" : undefined}>{label}</li>
        ))}
      </ol>
      {error ? <div className="error">{error}</div> : null}
      {step === 0 ? (
        <form className="panel stack" onSubmit={(event) => { event.preventDefault(); setStep(1); }}>
          <h2>Where does this data belong?</h2>
          {(resources.items || []).length === 0 ? <p>No resources yet. <Link className="text-link" to="/factory">Build the factory first</Link>.</p> : null}
          <label className="field"><span>Resource</span>
            <select required value={resourceId} onChange={(event) => setResourceId(event.target.value)}>
              <option value="">Select</option>
              {[...grouped.groups.entries()].map(([type, items]) => (
                <optgroup key={type} label={LEVEL_LABEL[type] || type}>
                  {items.map((item) => {
                    const parent = item.parent_id ? grouped.codes.get(String(item.parent_id)) : "";
                    return <option key={String(item.id)} value={String(item.id)}>{asText(item.code)}{parent ? ` · under ${parent}` : ""}</option>;
                  })}
                </optgroup>
              ))}
            </select>
          </label>
          <button className="btn primary" type="submit" disabled={!resourceId}>Continue</button>
        </form>
      ) : null}
      {step === 1 ? (
        <form className="panel stack" onSubmit={createConnection}>
          <h2>Source</h2>
          {(edges.items || []).length === 0 ? <p>No edge node yet. <Link className="text-link" to="/edges">Create an edge node</Link>. A test can read a machine only while that edge is running.</p> : null}
          <label className="field"><span>Existing connection</span>
            <select value={connectionId} onChange={(event) => chooseConnection(event.target.value).catch((reason: Error) => setError(reason.message))}>
              <option value="">Create a new connection</option>
              {siteConnections.map((item) => <option key={String(item.id)} value={String(item.id)}>{asText(item.name)} · {asText(item.protocol)}</option>)}
            </select>
          </label>
          {!connectionId ? (
            <>
              <div className="row">
                {PROTOCOLS.map((item) => (
                  <button key={item.key} className={protocol === item.key ? "btn primary" : "btn ghost"} type="button" onClick={() => setProtocol(item.key)}>{item.label}</button>
                ))}
              </div>
              <label className="field"><span>Name</span><input name="name" required /></label>
              <label className="field"><span>Edge node</span>
                <select name="edge_id" required value={edgeId} onChange={(event) => setEdgeId(event.target.value)}>
                  <option value="">Select</option>
                  {siteEdges.map((item) => <option key={String(item.id)} value={String(item.id)}>{asText(item.name)}</option>)}
                </select>
              </label>
              {protocol === "modbus_tcp" ? (
                <div className="address-row">
                  <label className="field"><span>Host</span><input name="host" required /></label>
                  <label className="field"><span>Port</span><input name="port" type="number" defaultValue={502} /></label>
                  <label className="field"><span>Unit</span><input name="unit_id" type="number" defaultValue={1} /></label>
                </div>
              ) : null}
              {protocol === "opcua" ? <label className="field"><span>Endpoint</span><input name="endpoint" placeholder="opc.tcp://host:4840" required /></label> : null}
              {protocol === "mqtt" ? (
                <div className="address-row">
                  <label className="field"><span>Host</span><input name="host" required /></label>
                  <label className="field"><span>Port</span><input name="port" type="number" defaultValue={1883} /></label>
                  <label className="field"><span>Topic</span><input name="topics" defaultValue={topic} required /></label>
                  <label className="field"><span>Username</span><input name="username" autoComplete="off" /></label>
                  <label className="field"><span>Password</span><input name="secret" type="password" autoComplete="new-password" /></label>
                </div>
              ) : null}
              {protocol === "http" ? (
                <div className="address-row">
                  <label className="field"><span>Base URL</span><input name="base_url" placeholder="https://host" required /></label>
                  <label className="field"><span>Path</span><input name="path" defaultValue={path} required /></label>
                  <label className="field"><span>Authentication</span>
                    <select value={httpAuth} onChange={(event) => setHttpAuth(event.target.value)}>
                      <option value="none">None</option>
                      <option value="api_key">API key</option>
                    </select>
                  </label>
                  {httpAuth === "api_key" ? (
                    <>
                      <label className="field"><span>Header</span><input name="header_name" defaultValue="X-API-Key" /></label>
                      <label className="field"><span>API key</span><input name="secret" type="password" autoComplete="new-password" /></label>
                    </>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : <p className="muted">The saved secret is not shown again.</p>}
          <div className="row">
            <button className="btn ghost" type="button" onClick={back}>Back</button>
            <button className="btn primary" type="submit" disabled={busy}>Continue</button>
          </div>
        </form>
      ) : null}
      {step === 2 ? (
        <section className="panel stack">
          <h2>Discover</h2>
          {protocol === "modbus_tcp" || protocol === "opcua" ? (
            <>
              <label className="field"><span>Paste addresses</span>
                <textarea value={paste} onChange={(event) => setPaste(event.target.value)} rows={4} placeholder={"name, offset, type, unit"} />
              </label>
              <div className="row">
                <button className="btn ghost" type="button" onClick={applyPaste}>Add pasted rows</button>
                <button className="btn ghost" type="button" onClick={protocol === "modbus_tcp" ? addModbus : addNode}>{protocol === "modbus_tcp" ? "Add address" : "Add node"}</button>
              </div>
              {rows.map((row, index) => (
                <div className="address-row" key={`${row.key}-${index}`}>
                  <label className="field"><span>Name</span><input value={row.name} onChange={(event) => patchRow(index, { name: event.target.value, key: signalKey(event.target.value, row.key) })} /></label>
                  <label className="field"><span>Unit</span><input value={row.unit} onChange={(event) => patchRow(index, { unit: event.target.value })} /></label>
                  {protocol === "modbus_tcp" ? (
                    <>
                      <label className="field"><span>Offset</span><input type="number" value={Number(row.address.offset || 0)} onChange={(event) => patchRow(index, { address: { ...row.address, offset: Number(event.target.value) } })} /></label>
                      <label className="field"><span>Area</span>
                        <select value={String(row.address.register_area)} onChange={(event) => patchRow(index, { address: { ...row.address, register_area: event.target.value } })}>
                          <option value="holding">Holding</option><option value="input">Input</option><option value="coil">Coil</option><option value="discrete">Discrete</option>
                        </select>
                      </label>
                      <label className="field"><span>Type</span>
                        <select value={String(row.address.native_type)} onChange={(event) => patchRow(index, { dataType: dataTypeOf(event.target.value), address: { ...row.address, native_type: event.target.value, register_count: counts(event.target.value) } })}>
                          {["bool", "uint16", "int16", "uint32", "int32", "float32", "float64"].map((item) => <option key={item}>{item}</option>)}
                        </select>
                      </label>
                    </>
                  ) : (
                    <label className="field"><span>NodeId</span><input value={String(row.address.node_id || "")} onChange={(event) => patchRow(index, { address: { node_id: event.target.value } })} /></label>
                  )}
                </div>
              ))}
            </>
          ) : (
            <>
              <label className="field"><span>JSON sample</span><textarea value={sample} onChange={(event) => setSample(event.target.value)} rows={8} /></label>
              {protocol === "mqtt" ? <label className="field"><span>Topic</span><input value={topic} onChange={(event) => setTopic(event.target.value)} /></label> : null}
              {protocol === "http" ? <label className="field"><span>Path</span><input value={path} onChange={(event) => setPath(event.target.value)} /></label> : null}
              {parsedLeaves.map((leaf) => (
                <div className="address-row" key={leaf.path}>
                  <span className="mono">{leaf.path}</span>
                  <span className="muted">{leaf.many ? "Multiple values" : previews[leaf.path] || leaf.preview}</span>
                  {leaf.many ? null : <button className="btn ghost" type="button" onClick={() => previewLeaf(leaf)}>Preview</button>}
                </div>
              ))}
            </>
          )}
          <div className="row">
            <button className="btn ghost" type="button" onClick={back}>Back</button>
            <button className="btn primary" type="button" onClick={prepareMap}>Continue</button>
          </div>
        </section>
      ) : null}
      {step === 3 ? (
        <section className="panel stack">
          <h2>Map</h2>
          {protocol === "mqtt" || protocol === "http" ? leaves.map((leaf) => (
            <div className="address-row" key={leaf.path}>
              <label className="row">
                <input type="checkbox" checked={Boolean(picked[leaf.path]) && !leaf.many} disabled={leaf.many} onChange={(event) => setPicked((current) => ({ ...current, [leaf.path]: event.target.checked }))} />
                <span className="mono">{leaf.path}</span>
              </label>
              <label className="field"><span>Name</span><input value={names[leaf.path] || ""} onChange={(event) => setNames((current) => ({ ...current, [leaf.path]: event.target.value }))} disabled={leaf.many} /></label>
              <label className="field"><span>Unit</span><input value={units[leaf.path] || ""} onChange={(event) => setUnits((current) => ({ ...current, [leaf.path]: event.target.value }))} disabled={leaf.many} /></label>
              <span className="muted">{leaf.many ? "Multiple values" : previews[leaf.path] || leaf.preview}</span>
            </div>
          )) : rows.map((row, index) => (
            <div className="address-row" key={`${row.key}-${index}`}>
              <label className="field"><span>Name</span><input value={row.name} onChange={(event) => patchRow(index, { name: event.target.value, key: signalKey(event.target.value, row.key) })} /></label>
              <label className="field"><span>Unit</span><input value={row.unit} onChange={(event) => patchRow(index, { unit: event.target.value })} /></label>
              <label className="field"><span>Type</span>
                {protocol === "modbus_tcp" ? (
                  <select value={String(row.address.native_type)} onChange={(event) => patchRow(index, { dataType: dataTypeOf(event.target.value), address: { ...row.address, native_type: event.target.value, register_count: counts(event.target.value) } })}>
                    {["bool", "uint16", "int16", "uint32", "int32", "float32", "float64"].map((item) => <option key={item}>{item}</option>)}
                  </select>
                ) : <input value={row.dataType} onChange={(event) => patchRow(index, { dataType: event.target.value })} />}
              </label>
            </div>
          ))}
          <p className="muted">A calculated signal is created in <Link className="text-link" to="/formulas">Calculations</Link>. Renaming a signal keeps the formula attached to its id.</p>
          <div className="row">
            <button className="btn ghost" type="button" onClick={back}>Back</button>
            <button className="btn primary" type="button" disabled={busy} onClick={saveSignals}>Save signals</button>
          </div>
        </section>
      ) : null}
      {step === 4 ? (
        <section className="panel stack">
          <h2>Test</h2>
          <p>The test runs on the enrolled edge. It does not write production records.</p>
          <div className="row">
            <button className="btn ghost" type="button" onClick={back}>Back</button>
            <button className="btn primary" type="button" disabled={busy} onClick={runTest}>Run test</button>
          </div>
          {test ? <p>{testSummary(test, testDone)}</p> : <p className="muted">No result yet.</p>}
          <button className="btn ghost" type="button" disabled={busy || !edgeId} onClick={publish}>Release to this edge</button>
        </section>
      ) : null}
      {step === 5 ? (
        <section className="panel stack">
          <h2>Publish</h2>
          <p>Requested revision {asText(release?.revision)}. Running revision {asText(release?.active_revision)}.</p>
          {release && release.active_revision !== release.revision ? <p>The edge has not applied this release yet.</p> : null}
          <form className="stack" onSubmit={createGroup}>
            <h3>Output group</h3>
            <label className="field"><span>Key</span><input name="key" required /></label>
            <label className="field"><span>Name</span><input name="display_name" required /></label>
            <label className="field"><span>Topic</span><input value={groupTopic} onChange={(event) => setGroupTopic(event.target.value)} /></label>
            <p className="muted">Each value uses the signal key as its name.</p>
            <div className="row">
              <button className="btn ghost" type="button" onClick={back}>Back</button>
              <button className="btn primary" type="submit" disabled={signalIds.length === 0}>Create group</button>
            </div>
          </form>
          {groupPreview ? (
            <div>
              <p className="mono">{groupPreview.topic}</p>
              {groupPreview.rows.length === 0 ? <p className="muted">No values have been read yet.</p> : (
                <table>
                  <thead><tr><th>Name</th><th>Value</th><th>Quality</th></tr></thead>
                  <tbody>
                    {groupPreview.rows.map((row) => <tr key={row.name}><td className="mono">{row.name}</td><td>{row.value}</td><td>{row.quality}</td></tr>)}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}
          <p className="muted">The topic is a view. History stays on the signal. <Link className="text-link" to={`/history?signal=${signalIds[0] || ""}`}>Open history</Link>.</p>
        </section>
      ) : null}
    </section>
  );
}
