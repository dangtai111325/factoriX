/**
 * Safe Markdown subset → small AST (pure). Rendered as React elements by TextWidget; raw HTML is never
 * interpreted (it stays literal text) and nothing goes through innerHTML.
 *
 * Blocks: headings `#`, `##`, `###`; unordered (`-`, `*`, `+`) and ordered (`1.`/`1)`) lists; paragraphs
 * (blank-line separated; single newlines are kept as line breaks).
 * Inline: `code`, **bold** / __bold__, *italic* / _italic_, [text](url), backslash escapes.
 * Links: only `http://` / `https://` (external) or internal paths starting with a single `/`; anything else
 * (javascript:, data:, //host, relative …) is rendered as plain text.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'code'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 'a'; href: string; external: boolean; c: Inline[] };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] };

export function safeHref(url: string): { href: string; external: boolean } | null {
  const u = url.trim();
  if (/^https?:\/\/[^\s<>"'`\\]+$/i.test(u)) return { href: u, external: true };
  if (/^\/(?![/\\])[^\s<>"'`\\]*$/.test(u)) return { href: u, external: false };
  return null;
}

const MAX_DEPTH = 4;

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && /[\\`*_[\]()#+\-.!]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_DEPTH && (src.startsWith('**', i) || src.startsWith('__', i))) {
      const mark = src.slice(i, i + 2);
      const end = src.indexOf(mark, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'b', c: parseInline(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (depth < MAX_DEPTH && (ch === '*' || ch === '_') && src[i + 1] && src[i + 1] !== ' ' && src[i + 1] !== ch) {
      // `_` only at a word boundary (snake_case stays literal)
      if (ch === '*' || i === 0 || !/\w/.test(src[i - 1])) {
        let end = i + 1;
        while ((end = src.indexOf(ch, end)) !== -1) {
          if (src[end - 1] !== ' ' && src[end - 1] !== '\\' && (ch === '*' || !/\w/.test(src[end + 1] ?? ''))) break;
          end++;
        }
        if (end > i + 1) {
          flush();
          out.push({ t: 'i', c: parseInline(src.slice(i + 1, end), depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === '[' && depth < MAX_DEPTH) {
      const close = src.indexOf('](', i + 1);
      if (close > i) {
        let end = -1;
        for (let k = close + 2, depthP = 0; k < src.length; k++) {
          if (src[k] === '(') depthP++;
          else if (src[k] === ')') {
            if (depthP === 0) {
              end = k;
              break;
            }
            depthP--;
          }
        }
        if (end > close + 2) {
          const text = src.slice(i + 1, close);
          const link = safeHref(src.slice(close + 2, end));
          flush();
          const c = parseInline(text, depth + 1);
          if (link) out.push({ t: 'a', href: link.href, external: link.external, c });
          else out.push(...c);
          i = end + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; start: number; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
    para = [];
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((x) => parseInline(x));
      blocks.push(list.t === 'ul' ? { t: 'ul', items } : { t: 'ol', start: list.start, items });
    }
    list = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ t: 'h', level: h[1].length as 1 | 2 | 3, c: parseInline(h[2].replace(/\s+#+\s*$/, '')) });
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*(\d{1,6})[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      const cur = list as { t: 'ul' | 'ol'; start: number; items: string[] } | null;
      if (!cur || cur.t !== kind) {
        flushList();
        list = { t: kind, start: ol ? parseInt(ol[1], 10) : 1, items: [] };
      }
      (list as unknown as { items: string[] }).items.push(ul ? ul[1] : (ol as RegExpExecArray)[2]);
      continue;
    }
    const cur = list as { items: string[] } | null;
    if (cur && /^\s{2,}\S/.test(raw)) {
      cur.items[cur.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}
