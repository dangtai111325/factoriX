/**
 * Field lookup in a Data Model body. Field paths are the backend's (storage_bindings.split_field_path):
 * "/"-separated, `~1` = "/", `~0` = "~", array indexes as numbers, an optional leading "/" (contract §3).
 * A "." is an ordinary character of a key.
 *
 * `found: false` means the field is missing from the sample — it is never turned into 0 or null-as-value.
 */
export function splitFieldPath(path: string): string[] {
  let text = String(path || '').trim();
  if (text.startsWith('/')) text = text.slice(1);
  if (!text) return [];
  return text.split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function extractField(body: unknown, path: string): { found: boolean; value: unknown } {
  let node: unknown = body;
  for (const part of splitFieldPath(path)) {
    if (Array.isArray(node)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return { found: false, value: null };
      node = node[idx];
    } else if (node && typeof node === 'object') {
      if (!Object.prototype.hasOwnProperty.call(node, part)) return { found: false, value: null };
      node = (node as Record<string, unknown>)[part];
    } else {
      return { found: false, value: null };
    }
  }
  return { found: true, value: node === undefined ? null : node };
}

/** `mod:<model uuid>:<field path>` → parts. */
export function parseModelToken(token: string): { modelId: string; path: string } | null {
  const m = /^mod:([^:]+):(.+)$/.exec(token || '');
  return m ? { modelId: m[1], path: m[2] } : null;
}

export function samePath(a: string, b: string): boolean {
  return splitFieldPath(a).join('\u0001') === splitFieldPath(b).join('\u0001');
}
