import { FormEvent, lazy, Suspense, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { LEVEL_LABEL, PageHead, asText, useList, type Row } from "./shared";

const DEFAULT_TOPIC = "fx/v1/{enterprise}/{site}/{plant}/{zone}/{line}/{resource}/{group}";
import type { Placement } from "./layout-board";

const LayoutBoard = lazy(() => import("./layout-board").then((module) => ({ default: module.LayoutBoard })));

export function LayoutPage() {
  const resources = useList("/api/v1/resources?view=all&limit=200");
  const signals = useList("/api/v1/signals");
  const groups = useList("/api/v1/output-groups");
  const layouts = useList("/api/v1/layouts");
  const [scope, setScope] = useState("");
  const [layoutId, setLayoutId] = useState("");
  const [version, setVersion] = useState(1);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [editing, setEditing] = useState("");
  const [creating, setCreating] = useState(false);
  const [topic, setTopic] = useState(DEFAULT_TOPIC);
  const [error, setError] = useState("");

  const items = resources.items || [];
  const visible = useMemo(() => items.filter((item) => String(item.parent_id || "") === scope), [items, scope]);
  const boardResources = useMemo(() => visible.map((item) => ({
    id: String(item.id),
    code: asText(item.code),
    name: asText(item.name),
    kind: LEVEL_LABEL[String(item.type_key)] || asText(item.type_key),
  })), [visible]);
  const outputs = useMemo(() => visible.flatMap((item) => {
    const id = String(item.id);
    const ownSignals = (signals.items || []).filter((signal) => String(signal.resource_id) === id);
    const ownGroups = (groups.items || []).filter((group) => String(group.resource_id) === id);
    if (ownSignals.length === 0 && ownGroups.length === 0) return [];
    const label = ownGroups[0] ? asText(ownGroups[0].display_name) : `${ownSignals.length} signals`;
    return [{ resourceId: id, label }];
  }), [visible, signals.items, groups.items]);

  function applyLayout(detail: Row) {
    const draft = (detail.draft_json || {}) as { nodes?: Placement[] };
    setLayoutId(String(detail.id));
    setVersion(Number(detail.version || 1));
    setScope(detail.scope_resource_id ? String(detail.scope_resource_id) : "");
    setPlacements(Array.isArray(draft.nodes) ? draft.nodes : []);
    setError("");
  }

  async function createLayout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const created = await api<Row>("/api/v1/layouts", {
        method: "POST",
        body: JSON.stringify({ name: form.get("name"), scope_resource_id: scope || null }),
      });
      if (placements.length > 0) {
        const saved = await api<Row>(`/api/v1/layouts/${created.id}/draft`, {
          method: "PATCH",
          body: JSON.stringify({ version: created.version || 1, draft: { nodes: placements } }),
        });
        applyLayout(saved);
      } else {
        applyLayout(created);
      }
      layouts.reload();
      setCreating(false);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  async function save(next: Placement[]) {
    setPlacements(next);
    if (!layoutId) return;
    try {
      const saved = await api<Row>(`/api/v1/layouts/${layoutId}/draft`, {
        method: "PATCH",
        body: JSON.stringify({ version, draft: { nodes: next } }),
      });
      setVersion(Number(saved.version || version + 1));
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  const scopeName = items.find((item) => String(item.id) === scope);

  return (
    <section>
      <PageHead
        title="Layout"
        lede="Arrange declared resources. Drag and resize change the picture only."
        action={
          <>
            {scope ? <button className="btn ghost small" type="button" onClick={() => setScope(String(scopeName?.parent_id || ""))}>Up one level</button> : null}
            <button className="btn primary small" type="button" onClick={() => setCreating(true)}>New layout</button>
          </>
        }
      />
      {error ? <div className="error">{error}</div> : null}
      <p className="muted">Showing {scopeName ? asText(scopeName.code) : "the top of the factory"}. Arrows are drawn from declared data.</p>
      {creating ? (
        <form className="panel row" onSubmit={createLayout}>
          <label className="field"><span>Name</span><input name="name" required /></label>
          <button className="btn ghost" type="button" onClick={() => setCreating(false)}>Cancel</button>
          <button className="btn primary" type="submit">Create</button>
        </form>
      ) : null}
      <div className="row">
        {(layouts.items || []).map((item) => (
          <button key={String(item.id)} className="btn ghost small" type="button" onClick={() => applyLayout(item)}>{asText(item.name)}</button>
        ))}
      </div>
      {visible.length === 0 ? <p className="empty">No resources at this level. <Link className="text-link" to="/factory">Declare the structure</Link>.</p> : null}
      <Suspense fallback={<p>Loading canvas…</p>}>
        <LayoutBoard
          resources={boardResources}
          outputs={outputs}
          placements={placements}
          onCommit={(next) => { save(next).catch((reason: Error) => setError(reason.message)); }}
          onOpen={(id) => setScope(id)}
          onOutput={setEditing}
        />
      </Suspense>
      {editing ? (
        <form className="panel stack" onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const members = (signals.items || []).filter((item) => String(item.resource_id) === editing);
          try {
            await api("/api/v1/output-groups", {
              method: "POST",
              body: JSON.stringify({
                resource_id: editing,
                key: form.get("key"),
                display_name: form.get("display_name"),
                topic_template: topic,
                members: members.map((item) => ({ signal_id: item.id, alias: String(item.key || "") })),
              }),
            });
            groups.reload();
            setEditing("");
          } catch (reason) {
            setError((reason as Error).message);
          }
        }}>
          <h2>Data box</h2>
          <p>This form edits the declared group. It does not draw a new arrow.</p>
          <label className="field"><span>Key</span><input name="key" required /></label>
          <label className="field"><span>Name</span><input name="display_name" required /></label>
          <label className="field"><span>Topic</span><input value={topic} onChange={(event) => setTopic(event.target.value)} /></label>
          <p className="muted">Each value uses the signal key as its name.</p>
          <button className="btn primary" type="submit" disabled={(signals.items || []).filter((item) => String(item.resource_id) === editing).length === 0}>Save group</button>
        </form>
      ) : null}
    </section>
  );
}
