// Ordered-JSON helpers: the engine emits exact ordered JSON text; never re-serialise it through
// JSON.parse/stringify (integer-like keys would move and number literals could change).
import { JNode, parseOrderedJson } from '../06_AddDataWizard/jsonTree';

/** Re-indent JSON text without parsing it into JS objects (key order and literals preserved). */
export function formatJsonText(text: string, pretty: boolean, indent = 2): string {
  let out = '';
  let depth = 0;
  let inString = false;
  const pad = (d: number) => (pretty ? `\n${' '.repeat(d * indent)}` : '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
    if (ch === '{' || ch === '[') {
      // Keep empty containers on one line.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      const close = ch === '{' ? '}' : ']';
      if (text[j] === close) {
        out += ch + close;
        i = j;
        continue;
      }
      depth += 1;
      out += ch + pad(depth);
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1);
      out += pad(depth) + ch;
      continue;
    }
    if (ch === ',') {
      out += pretty ? `,${pad(depth)}` : ',';
      continue;
    }
    if (ch === ':') {
      out += pretty ? ': ' : ':';
      continue;
    }
    out += ch;
  }
  return out;
}

export function tryParse(text: string | null | undefined): JNode | null {
  if (!text) return null;
  try {
    return parseOrderedJson(text);
  } catch {
    return null;
  }
}

export function nodeAt(root: JNode | null, segments: Array<string | number>): JNode | undefined {
  let cur: JNode | undefined = root ?? undefined;
  for (const seg of segments) {
    if (!cur) return undefined;
    if (cur.kind === 'object' && typeof seg === 'string') cur = cur.entries.find(([k]) => k === seg)?.[1];
    else if (cur.kind === 'array' && typeof seg === 'number') cur = cur.items[seg];
    else return undefined;
  }
  return cur;
}

/** Compact display of a JSON node (numbers keep their literal). */
export function nodeText(node: JNode | undefined): string {
  if (!node) return '';
  switch (node.kind) {
    case 'null':
      return 'null';
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'number':
      return node.raw;
    case 'string':
      return JSON.stringify(node.value);
    case 'array':
      return `[${node.items.length}]`;
    case 'object':
      return `{${node.entries.length}}`;
  }
}

export type JsonTokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'space';

/** Tokens of (formatted) JSON text for highlighting. */
export function jsonTokens(text: string): Array<{ kind: JsonTokenKind; text: string }> {
  const out: Array<{ kind: JsonTokenKind; text: string }> = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const s = text.slice(i, j + 1);
      let k = j + 1;
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k += 1;
      out.push({ kind: text[k] === ':' ? 'key' : 'string', text: s });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (num) {
      out.push({ kind: 'number', text: num[0] });
      i += num[0].length;
      continue;
    }
    const lit = /^(true|false|null)/.exec(text.slice(i, i + 5));
    if (lit) {
      out.push({ kind: 'literal', text: lit[0] });
      i += lit[0].length;
      continue;
    }
    const ws = /^\s+/.exec(text.slice(i));
    if (ws) {
      out.push({ kind: 'space', text: ws[0] });
      i += ws[0].length;
      continue;
    }
    out.push({ kind: 'punct', text: ch });
    i += 1;
  }
  return out;
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileName(name: string): string {
  return (name || 'data-model').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'data-model';
}
