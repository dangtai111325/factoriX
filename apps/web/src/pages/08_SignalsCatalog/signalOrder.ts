/**
 * Source order of the signal catalog (R2-SG-02): resources in hierarchy order (siblings sorted
 * naturally by name), then each Add Data batch in creation order, then the fields in the order they
 * were mapped (source field ordinal, delivered by the Center list order). Signals created before the
 * ordinal was stored (all ordinal 0) fall back to the register order for Modbus.
 */
import { ResourceNode, SignalItem } from '../../types';

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Depth-first position of every resource, siblings sorted naturally by name (then code). */
export function resourceTreeOrder(resources: ResourceNode[]): Map<string, number> {
  const children = new Map<string, ResourceNode[]>();
  const ids = new Set(resources.map((r) => r.id));
  const roots: ResourceNode[] = [];
  resources.forEach((r) => {
    if (r.parentId && ids.has(r.parentId)) {
      const list = children.get(r.parentId) || [];
      list.push(r);
      children.set(r.parentId, list);
    } else {
      roots.push(r);
    }
  });
  const byName = (a: ResourceNode, b: ResourceNode) => natural.compare(a.name || a.code, b.name || b.code) || natural.compare(a.code, b.code);
  const order = new Map<string, number>();
  const walk = (node: ResourceNode) => {
    order.set(node.id, order.size);
    (children.get(node.id) || []).sort(byName).forEach(walk);
  };
  roots.sort(byName).forEach(walk);
  return order;
}

function modbusRank(signal: SignalItem): [number, string, number] | null {
  const kind = (signal.connectionProtocol || signal.addressKind || '').toLowerCase();
  if (!kind.includes('modbus')) return null;
  const address = (signal.addressJson || {}) as Record<string, unknown>;
  const offset = Number(address.offset);
  if (!Number.isFinite(offset)) return null;
  return [Number(address.unit_id ?? 0) || 0, String(address.register_area || 'holding'), offset];
}

export function sortBySourceOrder(signals: SignalItem[], resources: ResourceNode[]): SignalItem[] {
  const treeOrder = resourceTreeOrder(resources);
  // First list position of each (resource, connection) batch keeps batches in creation order.
  const batchStart = new Map<string, number>();
  signals.forEach((s) => {
    const key = `${s.resourceId}|${s.sourceConnectionId}`;
    const index = s.listIndex ?? 0;
    if (!batchStart.has(key) || index < (batchStart.get(key) as number)) batchStart.set(key, index);
  });
  const legacyBatch = new Set<string>();
  const ordinals = new Map<string, Set<number>>();
  signals.forEach((s) => {
    const key = `${s.resourceId}|${s.sourceConnectionId}`;
    const set = ordinals.get(key) || new Set<number>();
    set.add(s.sourceOrdinal ?? 0);
    ordinals.set(key, set);
  });
  ordinals.forEach((set, key) => {
    if (set.size === 1) legacyBatch.add(key);
  });

  return [...signals].sort((a, b) => {
    const ta = treeOrder.get(a.resourceId) ?? Number.MAX_SAFE_INTEGER;
    const tb = treeOrder.get(b.resourceId) ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    const ka = `${a.resourceId}|${a.sourceConnectionId}`;
    const kb = `${b.resourceId}|${b.sourceConnectionId}`;
    if (ka !== kb) return (batchStart.get(ka) ?? 0) - (batchStart.get(kb) ?? 0);
    if (legacyBatch.has(ka)) {
      const ma = modbusRank(a);
      const mb = modbusRank(b);
      if (ma && mb) {
        if (ma[0] !== mb[0]) return ma[0] - mb[0];
        if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1;
        if (ma[2] !== mb[2]) return ma[2] - mb[2];
      }
    }
    return (a.listIndex ?? 0) - (b.listIndex ?? 0);
  });
}
