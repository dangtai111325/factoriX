import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { LEVEL_LABEL, PageHead, asText, levelOf, useList, type Row } from "./shared";

export function FactoryPage() {
  const [params] = useSearchParams();
  const sites = useList("/api/v1/sites");
  const resources = useList("/api/v1/resources?view=all&limit=200");
  const presets = useList("/api/v1/hierarchy-presets");
  const [selected, setSelected] = useState(params.get("resource") || "");
  const [detail, setDetail] = useState<Row | null>(null);
  const [signals, setSignals] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [preset, setPreset] = useState("Discrete");
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [confirmMove, setConfirmMove] = useState(false);
  const [composer, setComposer] = useState<null | "enterprise" | "site" | "structure">(null);

  useEffect(() => {
    const requested = params.get("preset");
    if (requested) {
      setPreset(requested);
      setComposer("structure");
    }
  }, [params]);

  const items = resources.items || [];
  const childrenOf = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const item of items) {
      const parent = item.parent_id ? String(item.parent_id) : "";
      const list = map.get(parent) || [];
      list.push(item);
      map.set(parent, list);
    }
    return map;
  }, [items]);

  async function openResource(id: string) {
    setSelected(id);
    setConfirmMove(false);
    try {
      setDetail(await api<Row>(`/api/v1/resources/${id}`));
      const payload = await api<{ items: Row[] }>(`/api/v1/signals?resource_id=${id}`);
      setSignals(payload.items);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function createSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/v1/sites", {
        method: "POST",
        body: JSON.stringify({ code: form.get("code"), name: form.get("name"), timezone: form.get("timezone") || "Asia/Ho_Chi_Minh" }),
      });
      sites.reload();
      event.currentTarget.reset();
      setComposer(null);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function createEnterprise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const created = await api<Row>("/api/v1/resources", {
        method: "POST",
        body: JSON.stringify({ type_key: "enterprise", code: form.get("code"), name: form.get("name"), site_id: null, parent_id: null }),
      });
      resources.reload();
      event.currentTarget.reset();
      await openResource(String(created.id));
      setComposer(null);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  const chosen = (presets.items || []).find((item) => item.name === preset) || presets.items?.[0];
  const levels = Array.isArray(chosen?.levels) ? chosen.levels.map(levelOf) : [];

  async function buildStructure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const siteId = String(form.get("site_id") || "");
    let parent: string | null = null;
    try {
      for (const level of levels) {
        if (level.optional && included[level.key] === false) continue;
        const created: Row = await api<Row>("/api/v1/resources", {
          method: "POST",
          body: JSON.stringify({
            type_key: level.key,
            code: form.get(`${level.key}_code`),
            name: form.get(`${level.key}_name`),
            site_id: level.key === "enterprise" ? null : siteId,
            parent_id: parent,
          }),
        });
        parent = String(created.id);
      }
      resources.reload();
      if (parent) await openResource(parent);
      setComposer(null);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function addChild(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const created = await api<Row>("/api/v1/resources", {
        method: "POST",
        body: JSON.stringify({
          type_key: form.get("type_key"),
          code: form.get("code"),
          name: form.get("name"),
          site_id: detail?.site_id || (sites.items || [])[0]?.id || null,
          parent_id: selected || null,
        }),
      });
      resources.reload();
      await openResource(String(created.id));
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function moveParent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmMove || !detail) return;
    const form = new FormData(event.currentTarget);
    try {
      await api(`/api/v1/resources/${selected}/move`, {
        method: "POST",
        body: JSON.stringify({ version: detail.version, parent_id: form.get("parent_id") }),
      });
      resources.reload();
      await openResource(selected);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  function renderTree(parent: string) {
    const nodes = childrenOf.get(parent) || [];
    if (nodes.length === 0) return null;
    return (
      <ul className="tree-list">
        {nodes.map((item) => (
          <li key={String(item.id)}>
            <button type="button" aria-current={selected === item.id ? "true" : undefined} onClick={() => openResource(String(item.id))}>
              {LEVEL_LABEL[String(item.type_key)] || asText(item.type_key)} · {asText(item.code)}
            </button>
            {renderTree(String(item.id))}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section>
      <PageHead
        title="Factory"
        lede="Declare enterprises, sites, and the structure under them."
        action={
          <>
            <button className="btn primary small" type="button" onClick={() => setComposer("enterprise")}>New enterprise</button>
            <button className="btn ghost small" type="button" onClick={() => setComposer("site")}>Add site</button>
            <button className="btn ghost small" type="button" onClick={() => setComposer("structure")}>Build a structure</button>
          </>
        }
      />
      {sites.error || resources.error || error ? <div className="error">{sites.error || resources.error || error}</div> : null}
      {composer === "enterprise" ? (
        <form className="panel stack" onSubmit={createEnterprise}>
          <h2>New enterprise</h2>
          <label className="field"><span>Code</span><input name="code" required /></label>
          <label className="field"><span>Name</span><input name="name" required /></label>
          <div className="row">
            <button className="btn ghost" type="button" onClick={() => setComposer(null)}>Cancel</button>
            <button className="btn primary" type="submit">Create enterprise</button>
          </div>
        </form>
      ) : null}
      {composer === "site" ? (
        <form className="panel stack" onSubmit={createSite}>
          <h2>Add site</h2>
          <label className="field"><span>Code</span><input name="code" required /></label>
          <label className="field"><span>Name</span><input name="name" required /></label>
          <label className="field"><span>Time zone</span><input name="timezone" defaultValue="Asia/Ho_Chi_Minh" /></label>
          <div className="row">
            <button className="btn ghost" type="button" onClick={() => setComposer(null)}>Cancel</button>
            <button className="btn primary" type="submit">Create site</button>
          </div>
        </form>
      ) : null}
      {composer === "structure" ? (
        <form className="panel stack" onSubmit={buildStructure}>
          <h2>Build a structure</h2>
          <p className="muted">A template that starts with an enterprise creates another root enterprise.</p>
          {(sites.items || []).length === 0 ? <p>Create a site before building a structure.</p> : (
            <label className="field"><span>Site</span>
              <select name="site_id">{(sites.items || []).map((item) => <option key={String(item.id)} value={String(item.id)}>{asText(item.code)}</option>)}</select>
            </label>
          )}
          <label className="field"><span>Template</span>
            <select value={preset} onChange={(event) => setPreset(event.target.value)}>
              {(presets.items || []).map((item) => <option key={String(item.name)}>{asText(item.name)}</option>)}
            </select>
          </label>
          {levels.map((level) => (
            <div className="row" key={level.key}>
              {level.optional ? (
                <label className="row"><input type="checkbox" checked={included[level.key] !== false} onChange={(event) => setIncluded((current) => ({ ...current, [level.key]: event.target.checked }))} /> Include {level.name}</label>
              ) : <strong>{level.name}</strong>}
              <label className="field"><span>{level.name} code</span><input name={`${level.key}_code`} required={!(level.optional && included[level.key] === false)} /></label>
              <label className="field"><span>{level.name} name</span><input name={`${level.key}_name`} required={!(level.optional && included[level.key] === false)} /></label>
            </div>
          ))}
          <div className="row">
            <button className="btn ghost" type="button" onClick={() => setComposer(null)}>Cancel</button>
            <button className="btn primary" type="submit" disabled={(sites.items || []).length === 0}>Create structure</button>
          </div>
        </form>
      ) : null}
      <div className="workbench">
        <aside className="panel tree">
          <h2>Structure</h2>
          {renderTree("")}
          {items.length === 0 ? <p className="muted">No resources yet.</p> : null}
        </aside>
        <section className="panel">
          <h2>{detail ? asText(detail.name) : "Select a resource"}</h2>
          {detail ? <p className="mono">{asText(detail.code)} · {LEVEL_LABEL[String(detail.type_key)] || asText(detail.type_key)}</p> : <p className="muted">Nothing selected.</p>}
          <h3>Signals</h3>
          {signals.map((item) => <p key={String(item.id)}>{asText(item.key)} · {asText(item.display_name)}</p>)}
          {detail && signals.length === 0 ? <p className="muted">No signals yet. <Link className="text-link" to={`/collect?resource=${selected}`}>Add data</Link></p> : null}
        </section>
        <aside className="panel stack">
          <h2>Declare</h2>
          {detail ? (
            <>
              <form className="stack" onSubmit={addChild}>
                <h3>Add child</h3>
                <label className="field"><span>Type</span>
                  <select name="type_key" defaultValue="machine">
                    {Object.entries(LEVEL_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </label>
                <label className="field"><span>Code</span><input name="code" required /></label>
                <label className="field"><span>Name</span><input name="name" required /></label>
                <button className="btn primary" type="submit">Add child</button>
              </form>
              <form className="stack" onSubmit={moveParent}>
                <h3>Change parent</h3>
                <label className="field"><span>New parent</span>
                  <select name="parent_id" required>
                    {items.filter((item) => item.id !== selected).map((item) => <option key={String(item.id)} value={String(item.id)}>{asText(item.code)}</option>)}
                  </select>
                </label>
                <label className="row"><input type="checkbox" checked={confirmMove} onChange={(event) => setConfirmMove(event.target.checked)} /> Confirm this declaration</label>
                <button className="btn ghost" type="submit" disabled={!confirmMove}>Move</button>
              </form>
            </>
          ) : <p className="muted">Select a resource to add a child or change its parent.</p>}
        </aside>
      </div>
    </section>
  );
}
