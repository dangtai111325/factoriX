import React, { useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Clock, Plus } from 'lucide-react';
import { JNode, Leaf, childPath, leavesUnder, nodePreview } from './jsonTree';

interface JsonSampleTreeProps {
  root: JNode;
  /** JSONPaths already mapped to a field. */
  selectedPaths: Set<string>;
  onPickLeaf: (path: string, key: string, node: JNode) => void;
  /** Map every given leaf that is not mapped yet. */
  onPickObject: (leaves: Array<{ path: string; key: string; node: JNode }>) => void;
  /** Unmap the given leaves (rows of other samples / topics stay). */
  onClearPaths: (paths: string[]) => void;
}

function kindLabel(node: JNode): string {
  switch (node.kind) {
    case 'number':
      return /[.eE]/.test(node.raw) ? 'number' : 'integer';
    case 'string':
      return 'text';
    case 'boolean':
      return 'bool';
    case 'null':
      return 'null';
    case 'array':
      return 'array';
    default:
      return 'object';
  }
}

const actionCls =
  'text-[10px] font-semibold px-1 rounded hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:text-slate-400 disabled:no-underline';

/**
 * Collapsible JSON tree in payload order; leaves are clickable to map them to signals.
 * Bulk: "N of M selected" with Select all / Clear all for the sample (or for the leaves the filter
 * shows), and per container node "Select all leaves under this node" / "Clear leaves under this node".
 */
export const JsonSampleTree: React.FC<JsonSampleTreeProps> = ({ root, selectedPaths, onPickLeaf, onPickObject, onClearPaths }) => {
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const allLeaves = useMemo(() => leavesUnder(root, '$', '$'), [root]);
  const q = filter.trim().toLowerCase();

  const leafMatches = (leaf: Leaf) => !q || leaf.path.toLowerCase().includes(q);
  const shownLeaves = q ? allLeaves.filter(leafMatches) : allLeaves;
  const selectedCount = allLeaves.filter((leaf) => selectedPaths.has(leaf.path)).length;
  const shownSelected = shownLeaves.filter((leaf) => selectedPaths.has(leaf.path)).length;

  const matches = (node: JNode, path: string): boolean => {
    if (!q) return true;
    if (path.toLowerCase().includes(q)) return true;
    if (node.kind === 'object') return node.entries.some(([k, v]) => matches(v, childPath(path, k)));
    if (node.kind === 'array') return node.items.some((v, i) => matches(v, childPath(path, i)));
    return false;
  };

  const render = (node: JNode, path: string, key: string, depth: number): React.ReactNode => {
    if (!matches(node, path)) return null;
    const isContainer = node.kind === 'object' || node.kind === 'array';
    if (isContainer) {
      const isCollapsed = q ? false : collapsed[path] ?? depth >= 3;
      const children: Array<[string | number, JNode]> =
        node.kind === 'object' ? node.entries : node.items.map((item, idx) => [idx, item] as [number, JNode]);
      const hasTs = node.kind === 'object' && node.entries.some(([k]) => k === 'source_timestamp');
      // With a filter, the node actions apply to the leaves the filter shows.
      const leaves = leavesUnder(node, path, key).filter(leafMatches);
      const picked = leaves.filter((leaf) => selectedPaths.has(leaf.path));
      const label = depth === 0 ? 'the whole sample' : path;
      return (
        <div key={path} role="group" aria-label={depth === 0 ? 'Sample' : key}>
          <div className="flex items-center justify-between gap-2 py-0.5 pr-1 rounded hover:bg-slate-50" style={{ paddingLeft: depth * 14 }}>
            <button
              type="button"
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((prev) => ({ ...prev, [path]: !isCollapsed }))}
              className="flex items-center gap-1 font-mono text-[11px] text-[#111B37] min-w-0"
            >
              {isCollapsed ? <ChevronRight className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />}
              <span className="font-semibold truncate">{depth === 0 ? '$' : key}</span>
              <span className="text-[10px] text-slate-400">{node.kind === 'object' ? `{${node.entries.length}}` : `[${node.items.length}]`}</span>
              {hasTs && (
                <span title="Has a sibling source_timestamp: it becomes the source time of these fields" className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-emerald-700">
                  <Clock className="w-3 h-3" /> source_timestamp
                </span>
              )}
            </button>
            {depth > 0 && leaves.length > 0 && (
              <span className="flex items-center gap-1 shrink-0">
                <span className="text-[10px] text-slate-400 tabular-nums" aria-hidden="true">
                  {picked.length}/{leaves.length}
                </span>
                <button
                  type="button"
                  disabled={picked.length === leaves.length}
                  onClick={() => onPickObject(leaves)}
                  aria-label={`Select all ${leaves.length} leaves under ${label}`}
                  title="Select all leaves under this node"
                  className={`${actionCls} text-blue-600`}
                >
                  Select all
                </button>
                <button
                  type="button"
                  disabled={picked.length === 0}
                  onClick={() => onClearPaths(picked.map((leaf) => leaf.path))}
                  aria-label={`Clear ${picked.length} selected leaves under ${label}`}
                  title="Clear leaves under this node"
                  className={`${actionCls} text-slate-600`}
                >
                  Clear
                </button>
              </span>
            )}
          </div>
          {!isCollapsed && children.map(([k, child]) => render(child, childPath(path, k), typeof k === 'number' ? `${key}_${k}` : k, depth + 1))}
        </div>
      );
    }
    const added = selectedPaths.has(path);
    return (
      <button
        type="button"
        key={path}
        onClick={() => onPickLeaf(path, key, node)}
        title={path}
        aria-pressed={added}
        aria-label={`${added ? 'Remove' : 'Add'} field ${key} (${path})`}
        className={`w-full flex items-center justify-between gap-2 py-0.5 pr-1 rounded text-left transition ${added ? 'bg-emerald-50 text-emerald-900' : 'hover:bg-blue-50'}`}
        style={{ paddingLeft: depth * 14 + 16 }}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono text-[11px] text-[#111B37] truncate">{key}</span>
          <span className="text-[10px] text-[#657794] bg-slate-100 px-1 rounded shrink-0">{kindLabel(node)}</span>
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[11px] min-w-0">
          <span className="text-slate-600 truncate max-w-[180px]">{nodePreview(node)}</span>
          {added ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <Plus className="w-3.5 h-3.5 text-blue-600 shrink-0" />}
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          aria-label="Filter fields"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${allLeaves.length} fields by name or path…`}
          className="flex-1 min-w-[160px] px-2 py-1 border border-slate-300 rounded text-[11px] font-mono"
        />
      </div>
      <div role="toolbar" aria-label="Captured fields" className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="text-[#657794]" aria-live="polite">
          <span className="font-semibold text-[#111B37]">{selectedCount}</span> of {allLeaves.length} selected
          {q && ` · ${shownLeaves.length} shown`}
        </span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            disabled={shownLeaves.length === 0 || shownSelected === shownLeaves.length}
            onClick={() => onPickObject(shownLeaves)}
            className={`${actionCls} text-[11px] text-blue-600`}
          >
            {q ? `Select all shown (${shownLeaves.length})` : 'Select all'}
          </button>
          <button
            type="button"
            disabled={shownSelected === 0}
            onClick={() => onClearPaths(shownLeaves.filter((leaf) => selectedPaths.has(leaf.path)).map((leaf) => leaf.path))}
            className={`${actionCls} text-[11px] text-slate-600`}
          >
            {q ? `Clear shown (${shownSelected})` : 'Clear all'}
          </button>
        </span>
      </div>
      <div className="max-h-80 overflow-y-auto border border-slate-200 rounded-lg p-1.5 bg-white">{render(root, '$', '$', 0)}</div>
    </div>
  );
};
