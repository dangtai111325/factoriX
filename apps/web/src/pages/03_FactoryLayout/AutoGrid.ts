/**
 * Auto-grid geometry calculation for Level-Based Layout Designer (§5.2 & §9.5).
 * Coordinates x, y, w, h are normalized ratios in [0.0, 1.0].
 */

export interface ItemGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function calculateAutoGrid(
  childIds: string[],
  width: number = 1600,
  height: number = 900,
): Record<string, ItemGeometry> {
  const n = childIds.length;
  if (n === 0) return {};

  if (n === 1) {
    return {
      [childIds[0]]: { x: 0, y: 0, w: 1, h: 1 },
    };
  }

  let cols = n;
  let rows = 1;

  if (n > 3) {
    const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
    cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * aspect))));
    rows = Math.ceil(n / cols);
  }

  const result: Record<string, ItemGeometry> = {};
  const itemW = Number((1 / cols).toFixed(4));
  const itemH = Number((1 / rows).toFixed(4));

  childIds.forEach((id, idx) => {
    const c = idx % cols;
    const r = Math.floor(idx / cols);
    const x = Number((c / cols).toFixed(4));
    const y = Number((r / rows).toFixed(4));
    result[id] = {
      x,
      y,
      w: itemW,
      h: itemH,
    };
  });

  return result;
}
