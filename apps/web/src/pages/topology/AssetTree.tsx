import React, { useState } from "react";
import { Resource } from "../../api/types";
import { ChevronRightIcon, ChevronDownIcon, TopologyIcon, PlusIcon } from "../../components/ui/Icons";
import { Badge } from "../../components/ui/Badge";

export interface AssetTreeProps {
  resources: Resource[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddChild: (parentId: string) => void;
}

interface TreeNode {
  resource: Resource;
  children: TreeNode[];
}

function buildTree(resources: Resource[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  for (const r of resources) {
    map.set(r.id, { resource: r, children: [] });
  }

  for (const r of resources) {
    const node = map.get(r.id)!;
    if (r.parent_id && map.has(r.parent_id)) {
      map.get(r.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

const TreeItem: React.FC<{
  node: TreeNode;
  selectedId: string | null;
  depth: number;
  onSelect: (id: string) => void;
  onAddChild: (parentId: string) => void;
}> = ({ node, selectedId, depth, onSelect, onAddChild }) => {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const isSelected = node.resource.id === selectedId;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 8px 6px 0",
          paddingLeft: `${depth * 16 + 8}px`,
          backgroundColor: isSelected ? "var(--brand-surface)" : "transparent",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
          userSelect: "none",
          transition: "background-color var(--duration-fast)",
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.backgroundColor = "var(--bg-card-hover)";
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.backgroundColor = "transparent";
        }}
      >
        <div
          onClick={() => onSelect(node.resource.id)}
          style={{ display: "flex", alignItems: "center", gap: "6px", flex: 1, minWidth: 0 }}
        >
          {hasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                padding: "2px",
                display: "flex",
                alignItems: "center",
              }}
            >
              {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
            </button>
          ) : (
            <span style={{ width: "18px" }} />
          )}

          <TopologyIcon
            size={15}
            style={{
              color: isSelected ? "var(--brand-primary)" : "var(--text-muted)",
              flexShrink: 0,
            }}
          />

          <span
            className="tabular"
            style={{
              fontSize: "13px",
              fontWeight: isSelected ? 700 : 500,
              color: isSelected ? "var(--text-primary)" : "var(--text-secondary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {node.resource.code}
          </span>

          <span style={{ fontSize: "12px", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
            ({node.resource.name})
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {node.resource.type_key && (
            <Badge variant="neutral" style={{ fontSize: "10px", padding: "1px 6px" }}>
              {node.resource.type_key.toUpperCase()}
            </Badge>
          )}
          <button
            title="Thêm cấp con"
            onClick={(e) => {
              e.stopPropagation();
              onAddChild(node.resource.id);
            }}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: "2px 4px",
              borderRadius: "var(--radius-xs)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--brand-primary)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          >
            <PlusIcon size={13} />
          </button>
        </div>
      </div>

      {hasChildren && expanded && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {node.children.map((child) => (
            <TreeItem
              key={child.resource.id}
              node={child}
              selectedId={selectedId}
              depth={depth + 1}
              onSelect={onSelect}
              onAddChild={onAddChild}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const AssetTree: React.FC<AssetTreeProps> = ({
  resources,
  selectedId,
  onSelect,
  onAddChild,
}) => {
  const tree = buildTree(resources);

  if (resources.length === 0) {
    return (
      <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "12.5px" }}>
        Chưa có cấu trúc tài sản nào được thiết lập.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {tree.map((node) => (
        <TreeItem
          key={node.resource.id}
          node={node}
          selectedId={selectedId}
          depth={0}
          onSelect={onSelect}
          onAddChild={onAddChild}
        />
      ))}
    </div>
  );
};
