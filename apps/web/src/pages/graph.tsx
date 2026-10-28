import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { plainLabel } from "../format";
import { LEVEL_LABEL, PageHead, asText, useList, type Row } from "./shared";

const RELATION_LABEL: Record<string, string> = {
  CONTAINS: "Contains",
  INSTALLED_AT: "Installed at",
  FEEDS: "Feeds",
  CONNECTED_TO: "Connected to",
  MONITORED_BY: "Monitored by",
  PART_OF: "Part of",
};

const GraphBoard = lazy(() => import("./graph-board").then((module) => ({ default: module.GraphBoard })));

const RELATIONS = ["CONTAINS", "INSTALLED_AT", "FEEDS", "CONNECTED_TO", "MONITORED_BY", "PART_OF"];

export function GraphPage() {
  const resources = useList("/api/v1/resources?view=all&limit=200");
  const connections = useList("/api/v1/connections");
  const [center, setCenter] = useState("");
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(RELATIONS.map((item) => [item, true])));
  const [graph, setGraph] = useState<{ nodes: Row[]; edges: Row[] }>({ nodes: [], edges: [] });
  const [signals, setSignals] = useState<Row[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!center && resources.items && resources.items[0]) setCenter(String(resources.items[0].id));
  }, [center, resources.items]);

  useEffect(() => {
    if (!center) return;
    const types = RELATIONS.filter((item) => enabled[item]).join(",") || "NONE";
    let live = true;
    api<{ nodes: Row[]; edges: Row[] }>(`/api/v1/graph/neighbors?resource_id=${center}&depth=1&relation_types=${types}`)
      .then((payload) => { if (live) setGraph(payload); })
      .catch((reason: Error) => { if (live) setError(reason.message); });
    api<{ items: Row[] }>(`/api/v1/signals?resource_id=${center}`)
      .then((payload) => { if (live) setSignals(payload.items); })
      .catch(() => { if (live) setSignals([]); });
    return () => { live = false; };
  }, [center, enabled]);

  const resource = (resources.items || []).find((item) => String(item.id) === center);
  const siteConnections = (connections.items || []).filter((item) => !resource?.site_id || String(item.site_id) === String(resource.site_id));
  const nodes = useMemo(() => [
    ...graph.nodes.map((item) => ({ id: String(item.id), label: asText(item.code || item.name), kind: LEVEL_LABEL[String(item.type_key)] || asText(item.type_key) })),
    ...signals.map((item) => ({ id: `signal-${item.id}`, label: asText(item.key), kind: "signal" })),
  ], [graph.nodes, signals]);
  const edges = useMemo(() => [
    ...graph.edges.map((item) => ({ id: String(item.id), source: String(item.from_id), target: String(item.to_id), label: RELATION_LABEL[String(item.relation_code)] || plainLabel(item.relation_code) })),
    ...signals.map((item) => ({ id: `signal-edge-${item.id}`, source: center, target: `signal-${item.id}`, label: "Signal" })),
  ].filter((item) => item.source && item.target), [graph.edges, signals, center]);

  return (
    <section>
      <PageHead title="Relationships" lede="Neighbors come from declared relationships. This view does not draw new arrows." />
      {resources.error || error ? <div className="error">{resources.error || error}</div> : null}
      <div className="row">
        {(resources.items || []).length > 0 ? (
          <label className="field"><span>Resource</span>
            <select value={center} onChange={(event) => setCenter(event.target.value)}>
              {(resources.items || []).map((item) => <option key={String(item.id)} value={String(item.id)}>{asText(item.code)}</option>)}
            </select>
          </label>
        ) : null}
        {RELATIONS.map((item) => (
          <label key={item} className="row">
            <input type="checkbox" checked={enabled[item]} onChange={(event) => setEnabled((current) => ({ ...current, [item]: event.target.checked }))} />
            {RELATION_LABEL[item]}
          </label>
        ))}
      </div>
      <p className="muted">Depth 1. Double-click a resource to expand it. Dragging rearranges this view only.</p>
      {(resources.items || []).length === 0 ? <p>No resources yet.</p> : (
        <Suspense fallback={<p>Loading graph…</p>}>
          <GraphBoard center={center} nodes={nodes} edges={edges} onOpen={setCenter} />
        </Suspense>
      )}
      <aside className="panel">
        <h2>Connections at this site</h2>
        {siteConnections.map((item) => <p key={String(item.id)}>{asText(item.name)} · {plainLabel(item.protocol)}</p>)}
        {siteConnections.length === 0 ? <p className="muted">No connections at this site.</p> : null}
      </aside>
    </section>
  );
}
