/**
 * Image body: only an embedded `image_data` of the form `data:image/(png|jpeg|webp|gif);base64,…`
 * (no SVG, no remote URL — an image is never a data source). `fit` contain/cover/fill, `alt`.
 * Empty or invalid data shows a placeholder (with an inspector hint in edit mode).
 */
import React from 'react';
import { ImageOff, Image as ImageIcon } from 'lucide-react';
import type { WidgetRendererProps } from '../types';
import { BodyMessage, optEnum, optStr } from './shared';

const DATA_URI = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isSafeImageData(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 400_000 && DATA_URI.test(v);
}

export function ImageWidget({ options: o, theme, size, mode }: WidgetRendererProps) {
  const data = o.image_data;
  const fit = optEnum(o, 'fit', ['contain', 'cover', 'fill'] as const, 'contain');
  const alt = optStr(o, 'alt', '');
  const iconSize = Math.max(14, Math.min(32, Math.min(size.width, size.height) * 0.25));
  if (data === null || data === undefined || data === '') {
    return (
      <BodyMessage
        theme={theme}
        icon={size.height >= 60 ? <ImageIcon size={iconSize} strokeWidth={1.5} /> : undefined}
        text={size.height >= 40 ? 'No image' : ''}
        hint={mode === 'edit' && size.height >= 80 ? 'Upload a PNG, JPEG, WebP or GIF in the inspector' : null}
      />
    );
  }
  if (!isSafeImageData(data)) {
    return (
      <BodyMessage
        theme={theme}
        tone="warning"
        icon={size.height >= 60 ? <ImageOff size={iconSize} strokeWidth={1.5} /> : undefined}
        text="Unsupported image"
        hint={size.height >= 80 ? 'Only embedded PNG, JPEG, WebP or GIF images are shown' : null}
      />
    );
  }
  return <img src={data} alt={alt} draggable={false} style={{ display: 'block', width: size.width, height: size.height, objectFit: fit, userSelect: 'none' }} />;
}
