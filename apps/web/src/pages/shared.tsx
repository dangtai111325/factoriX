import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";

export type Row = Record<string, unknown>;
export type List = { items: Row[] };

export const LEVEL_LABEL: Record<string, string> = {
  enterprise: "Enterprise",
  site: "Site",
  plant: "Plant",
  zone: "Zone",
  line: "Line",
  cell: "Cell",
  workshop: "Workshop",
  machine: "Machine",
  utility_system: "Utility system",
  sensor: "Sensor",
  physical_asset: "Physical asset",
  functional_position: "Functional position",
};

export function asText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export function PageHead(props: { title: string; lede?: string; action?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.lede ? <p className="lede">{props.lede}</p> : null}
      </div>
      {props.action ? <div className="page-actions">{props.action}</div> : null}
    </header>
  );
}

export function Empty(props: { children: ReactNode }) {
  return <p className="empty">{props.children}</p>;
}

export function useList(path: string) {
  const [tick, setTick] = useState(0);
  const [items, setItems] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api<List | Row>(path)
      .then((payload) => {
        if (!live) return;
        setItems(Array.isArray((payload as List).items) ? (payload as List).items : []);
        setError("");
      })
      .catch((reason: Error) => {
        if (live) setError(reason.message);
      });
    return () => {
      live = false;
    };
  }, [path, tick]);
  return { items, error, reload: () => setTick((value) => value + 1) };
}

export function levelOf(level: unknown): { key: string; name: string; optional: boolean } {
  if (level && typeof level === "object" && "type_key" in level) {
    const row = level as { type_key?: string; optional?: boolean };
    const key = String(row.type_key || "");
    return { key, name: LEVEL_LABEL[key] || key, optional: Boolean(row.optional) };
  }
  return { key: String(level ?? ""), name: String(level ?? ""), optional: false };
}

export type JsonLeaf = { path: string; preview: string; many: boolean };

export function jsonLeaves(value: unknown, path = "$"): JsonLeaf[] {
  if (Array.isArray(value)) {
    const first = value[0];
    if (first && typeof first === "object") {
      return jsonLeaves(first, `${path}[*]`).map((row) => ({ ...row, many: true }));
    }
    return [{ path: `${path}[*]`, preview: `${value.length} values`, many: true }];
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const segment = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `['${key.replace(/'/g, "\\'")}']`;
      const next = path === "$" ? `$${segment}` : `${path}${segment}`;
      return jsonLeaves(child, next);
    });
  }
  return [{ path, preview: value === null || value === undefined ? "No value" : String(value), many: path.includes("[*]") }];
}
