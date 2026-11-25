/**
 * Text body: the safe Markdown subset of `markdown.ts`, built as React elements (no innerHTML, raw HTML
 * stays literal). External links open in a new tab with rel="noopener noreferrer nofollow"; internal
 * `/…` paths use the router when present. In edit mode links do not navigate.
 * Options: `content`, `font_size` sm/md/lg/xl (× dashboard font scale), `align`, `text_color`
 * (null = theme text). Long content scrolls inside the body.
 */
import React, { useMemo } from 'react';
import { Link as RouterLink, useInRouterContext } from 'react-router-dom';
import type { ThemeTokens, WidgetRendererProps } from '../types';
import { parseMarkdown, type Block, type Inline } from './markdown';
import { BodyMessage, clamp, ensureWidgetStyles, hexAlpha, MONO, optColor, optEnum, optStr } from './shared';

const SIZES = { sm: 12, md: 14, lg: 17, xl: 21 } as const;

interface Ctx {
  theme: ThemeTokens;
  edit: boolean;
  inRouter: boolean;
  linkColor: string;
}

function renderInline(nodes: Inline[], ctx: Ctx, key = 'i'): React.ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.t) {
      case 'text':
        return <React.Fragment key={k}>{n.v}</React.Fragment>;
      case 'br':
        return <br key={k} />;
      case 'code':
        return (
          <code key={k} style={{ fontFamily: MONO, fontSize: '0.88em', padding: '0.1em 0.35em', borderRadius: 4, background: hexAlpha(ctx.theme.text_muted, 0.14) }}>
            {n.v}
          </code>
        );
      case 'b':
        return <strong key={k}>{renderInline(n.c, ctx, k)}</strong>;
      case 'i':
        return <em key={k}>{renderInline(n.c, ctx, k)}</em>;
      case 'a': {
        const style: React.CSSProperties = { color: ctx.linkColor, textDecoration: 'underline', textUnderlineOffset: 2, cursor: ctx.edit ? 'default' : 'pointer' };
        const children = renderInline(n.c, ctx, k);
        const block = (e: React.MouseEvent) => {
          if (ctx.edit) e.preventDefault();
        };
        if (n.external)
          return (
            <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow" onClick={block} style={style} title={ctx.edit ? 'Links are disabled while editing' : n.href}>
              {children}
            </a>
          );
        if (ctx.inRouter && !ctx.edit)
          return (
            <RouterLink key={k} to={n.href} style={style}>
              {children}
            </RouterLink>
          );
        return (
          <a key={k} href={n.href} onClick={block} style={style} title={ctx.edit ? 'Links are disabled while editing' : undefined}>
            {children}
          </a>
        );
      }
      default:
        return null;
    }
  });
}

function renderBlocks(blocks: Block[], ctx: Ctx): React.ReactNode[] {
  return blocks.map((b, i) => {
    const k = `b${i}`;
    const gap = { margin: i === 0 ? '0 0 0.45em' : '0.45em 0' };
    switch (b.t) {
      case 'h': {
        const fs = b.level === 1 ? '1.55em' : b.level === 2 ? '1.28em' : '1.1em';
        const Tag = (`h${b.level}` as unknown) as 'h1';
        return (
          <Tag key={k} style={{ ...gap, fontSize: fs, fontWeight: b.level === 3 ? 600 : 700, lineHeight: 1.25, letterSpacing: b.level === 1 ? '-0.01em' : 0 }}>
            {renderInline(b.c, ctx, k)}
          </Tag>
        );
      }
      case 'p':
        return (
          <p key={k} style={{ ...gap }}>
            {renderInline(b.c, ctx, k)}
          </p>
        );
      case 'ul':
        return (
          <ul key={k} style={{ ...gap, paddingLeft: '1.3em', listStyle: 'disc' }}>
            {b.items.map((it, j) => (
              <li key={j} style={{ margin: '0.15em 0' }}>
                {renderInline(it, ctx, `${k}.${j}`)}
              </li>
            ))}
          </ul>
        );
      case 'ol':
        return (
          <ol key={k} start={b.start} style={{ ...gap, paddingLeft: '1.5em', listStyle: 'decimal' }}>
            {b.items.map((it, j) => (
              <li key={j} style={{ margin: '0.15em 0' }}>
                {renderInline(it, ctx, `${k}.${j}`)}
              </li>
            ))}
          </ol>
        );
      default:
        return null;
    }
  });
}

export function TextWidget({ options: o, theme, size, mode }: WidgetRendererProps) {
  ensureWidgetStyles();
  const inRouter = useInRouterContext();
  const content = optStr(o, 'content', '');
  const fontSize = optEnum(o, 'font_size', ['sm', 'md', 'lg', 'xl'] as const, 'md');
  const align = optEnum(o, 'align', ['left', 'center', 'right'] as const, 'left');
  const color = optColor(o, 'text_color') ?? theme.text;
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const scale = clamp(theme.font_scale || 1, 0.8, 1.4);
  if (!content.trim()) {
    return mode === 'edit' ? <BodyMessage theme={theme} text="Empty text" hint="Write Markdown content in the inspector" /> : null;
  }
  const ctx: Ctx = { theme, edit: mode === 'edit', inRouter, linkColor: optColor(o, 'accent_color') ?? theme.accent };
  return (
    <div
      className="fx-w-scroll"
      style={{
        width: size.width,
        height: size.height,
        overflow: 'auto',
        color,
        textAlign: align,
        fontSize: SIZES[fontSize] * scale,
        lineHeight: 1.5,
        overflowWrap: 'anywhere',
        ['--fx-w-thumb' as string]: theme.border,
      }}
    >
      {renderBlocks(blocks, ctx)}
    </div>
  );
}
