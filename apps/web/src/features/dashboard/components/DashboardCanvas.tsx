/**
 * The dashboard grid (react-grid-layout Responsive: lg 12 / md 6 / sm 1 columns, vertical compaction,
 * no overlap). Shared by view mode, the Studio canvas and previews; must be rendered inside a
 * <DashboardRuntimeProvider>.
 *
 * View mode picks the breakpoint from the measured width. The Studio passes a breakpoint and renders
 * the grid at that breakpoint's logical width, scaled to fit (`transformScale` keeps dragging exact).
 * Only drag/resize stops are committed (never the mount-time compaction), so opening a dashboard never
 * marks it as changed.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Responsive, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import '../dashboard.css';
import { Copy, Database, EllipsisVertical, Maximize2, Table2, Trash2 } from 'lucide-react';
import { IconMenu } from '../../../pages/13_DataModels/ui';
import { BREAKPOINT_WIDTHS, MAX_ROWS_PER_WIDGET, STUDIO_WIDTHS, breakpointForWidth, minSize, rectsFor } from '../document';
import { mergeOptions } from '../registry';
import { themeStyle } from '../theme';
import { useRuntime, useWidgetData } from '../runtime/RuntimeProvider';
import { WIDGET_RENDERERS } from '../widgets';
import { BREAKPOINT_COLUMNS } from '../types';
import type { Breakpoint, DashboardDocument, DashboardWidget, NavTarget } from '../types';
import { WidgetFrame } from './WidgetFrame';

// The widget type being dragged from the Studio library (HTML5 drag carries no typed payload to RGL).
let draggingType: { type: string; w: number; h: number } | null = null;
export function setDraggingWidgetType(v: { type: string; w: number; h: number } | null): void {
  draggingType = v;
}

const DROPPING_ID = '__dropping-elem__';

export interface CanvasEditProps {
  breakpoint: Breakpoint;
  zoom: 'fit' | '100';
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onLayoutCommit: (bp: Breakpoint, items: Layout[]) => void;
  onDropType: (type: string, bp: Breakpoint, x: number, y: number) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onChooseData: (id: string) => void;
  showGrid: boolean;
}

export interface CanvasViewActions {
  onViewData: (widget: DashboardWidget) => void;
  onFullscreen: (widget: DashboardWidget) => void;
}

interface Props {
  document: DashboardDocument;
  mode: 'view' | 'edit';
  edit?: CanvasEditProps;
  view?: CanvasViewActions;
  onNavigate: (target: NavTarget) => void;
  /** Fill the viewport height (kiosk). */
  className?: string;
  /** Rendered when there is no visible widget. */
  empty?: React.ReactNode;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setW(Math.floor(el.clientWidth));
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export const DashboardCanvas: React.FC<Props> = ({ document: doc, mode, edit, view, onNavigate, className = '', empty }) => {
  const { defs, theme } = useRuntime();
  const [outerRef, outerWidth] = useWidth<HTMLDivElement>();
  const innerRef = useRef<HTMLDivElement>(null);
  const [innerHeight, setInnerHeight] = useState(0);

  const bp: Breakpoint = edit ? edit.breakpoint : breakpointForWidth(outerWidth);
  const logicalWidth = edit ? STUDIO_WIDTHS[bp] : outerWidth;
  const scale = edit && edit.zoom === 'fit' && outerWidth > 0 ? Math.min(1, outerWidth / logicalWidth) : 1;
  const gap = theme.gap;
  const rowHeight = Math.max(24, Math.min(96, doc.settings.row_height || 40));
  const cols = BREAKPOINT_COLUMNS[bp];

  const visible = useMemo(() => doc.widgets.filter((w) => !w.hidden[bp]), [doc.widgets, bp]);
  const layout = useMemo<Layout[]>(() => {
    const rects = rectsFor(visible, defs, bp);
    return visible.map((w) => {
      const r = rects.get(w.id)!;
      const min = minSize(defs.get(w.type), bp);
      return { i: w.id, x: r.x, y: r.y, w: r.w, h: r.h, minW: min.w, minH: min.h, maxH: MAX_ROWS_PER_WIDGET };
    });
  }, [visible, defs, bp]);
  const layouts = useMemo(() => ({ [bp]: layout }), [bp, layout]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setInnerHeight(el.offsetHeight));
    ro.observe(el);
    setInnerHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  const commit = useCallback(
    (items: Layout[], oldItem: Layout, newItem: Layout) => {
      if (!edit) return;
      if (oldItem && newItem && oldItem.x === newItem.x && oldItem.y === newItem.y && oldItem.w === newItem.w && oldItem.h === newItem.h) return;
      edit.onLayoutCommit(bp, items.filter((it) => it.i !== DROPPING_ID));
    },
    [edit, bp],
  );

  const onDrop = useCallback(
    (_layout: Layout[], item: Layout | undefined, e: Event) => {
      if (!edit || !draggingType) return;
      const type = draggingType.type;
      draggingType = null;
      let x = item?.x ?? 0;
      let y = item?.y ?? 0;
      // Recompute from the pointer: the library ignores the zoom when it converts the drop position.
      const grid = innerRef.current?.querySelector('.react-grid-layout');
      const de = e as DragEvent;
      if (grid && typeof de.clientX === 'number') {
        const rect = grid.getBoundingClientRect();
        const colW = (logicalWidth - gap * (cols + 1)) / cols;
        x = Math.max(0, Math.min(cols - 1, Math.floor(((de.clientX - rect.left) / scale - gap) / (colW + gap))));
        y = Math.max(0, Math.floor(((de.clientY - rect.top) / scale - gap) / (rowHeight + gap)));
      }
      edit.onDropType(type, bp, x, y);
    },
    [edit, bp, logicalWidth, gap, cols, scale, rowHeight],
  );

  const colWidth = (logicalWidth - gap * (cols + 1)) / cols;
  const gridBackground =
    edit?.showGrid && colWidth > 0
      ? {
          backgroundImage: `linear-gradient(to right, ${theme.dark ? 'rgba(255,255,255,0.04)' : 'rgba(17,27,55,0.035)'} ${colWidth}px, transparent ${colWidth}px)`,
          backgroundSize: `${colWidth + gap}px ${rowHeight + gap}px`,
          backgroundPosition: `${gap}px ${gap}px`,
        }
      : {};

  return (
    <div ref={outerRef} className={`dash-canvas-outer w-full ${className}`} onMouseDown={(e) => {
      if (edit && e.target === e.currentTarget) edit.onSelect(null);
    }}>
      <div style={{ height: edit ? Math.max(innerHeight * scale, 200) : undefined }}>
        <div
          ref={innerRef}
          className={`dash-canvas relative ${edit ? 'dash-editing' : ''}`}
          style={{
            ...themeStyle(theme),
            width: logicalWidth || '100%',
            minHeight: edit ? 480 : 160,
            transform: scale !== 1 ? `scale(${scale})` : undefined,
            transformOrigin: 'top left',
            borderRadius: edit ? 12 : 0,
            ...gridBackground,
          }}
          onMouseDown={(e) => {
            if (!edit) return;
            const target = e.target as HTMLElement;
            if (!target.closest('.react-grid-item')) edit.onSelect(null);
          }}
        >
          {logicalWidth > 0 && (
            <Responsive
              key={bp}
              width={logicalWidth}
              breakpoint={bp}
              breakpoints={BREAKPOINT_WIDTHS}
              cols={BREAKPOINT_COLUMNS}
              layouts={layouts}
              rowHeight={rowHeight}
              margin={[gap, gap]}
              containerPadding={[gap, gap]}
              compactType="vertical"
              allowOverlap={false}
              preventCollision={false}
              isDraggable={!!edit}
              isResizable={!!edit}
              isDroppable={!!edit}
              isBounded={false}
              resizeHandles={['se', 'e', 's']}
              draggableHandle=".dash-drag-handle"
              draggableCancel=".dash-no-drag"
              transformScale={scale}
              useCSSTransforms
              droppingItem={{ i: DROPPING_ID, w: draggingType?.w ?? 3, h: draggingType?.h ?? 3 }}
              onDropDragOver={() => (draggingType ? { w: Math.min(draggingType.w, cols), h: draggingType.h } : false)}
              onDrop={onDrop}
              onDragStop={(items, oldItem, newItem) => commit(items, oldItem, newItem)}
              onResizeStop={(items, oldItem, newItem) => commit(items, oldItem, newItem)}
              style={{ minHeight: edit ? 480 : undefined }}
            >
              {visible.map((w) => (
                <div key={w.id} className="dash-cell">
                  <WidgetCell
                    widget={w}
                    mode={mode}
                    selected={edit?.selectedId === w.id}
                    edit={edit}
                    view={view}
                    onNavigate={onNavigate}
                  />
                </div>
              ))}
            </Responsive>
          )}
          {visible.length === 0 && empty && <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-none">{empty}</div>}
        </div>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ one widget

const iconBtn = 'dash-no-drag inline-flex items-center justify-center w-6 h-6 rounded-md transition-colors hover:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400';

export const WidgetCell: React.FC<{
  widget: DashboardWidget;
  mode: 'view' | 'edit';
  selected?: boolean;
  edit?: CanvasEditProps;
  view?: CanvasViewActions;
  onNavigate: (target: NavTarget) => void;
  className?: string;
}> = React.memo(function WidgetCell({ widget, mode, selected, edit, view, onNavigate, className }) {
  const { defs, theme, timeRange } = useRuntime();
  const def = defs.get(widget.type);
  const options = useMemo(() => mergeOptions(def, widget.options), [def, widget.options]);
  const data = useWidgetData(widget);
  const range = widget.time.mode === 'custom' ? widget.time.range : timeRange;
  const renderer = WIDGET_RENDERERS[widget.type];
  const title = widget.title || def?.label || widget.type;

  let controls: React.ReactNode = null;
  if (edit) {
    controls = (
      <div className="flex items-center gap-0.5 dash-no-drag" style={{ color: theme.text_muted }}>
        {def && def.data.max_bindings > 0 && (
          <button type="button" className={iconBtn} title="Edit data" aria-label={`Edit data of ${title}`} onClick={() => edit.onChooseData(widget.id)}>
            <Database className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
        <button type="button" className={iconBtn} title="Duplicate" aria-label={`Duplicate ${title}`} onClick={() => edit.onDuplicate(widget.id)}>
          <Copy className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <button type="button" className={iconBtn} title="Delete (Del)" aria-label={`Delete ${title}`} onClick={() => edit.onDelete(widget.id)}>
          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  } else if (view) {
    const items = [
      ...(def && def.data.max_bindings > 0
        ? [{ key: 'data', label: 'View data', icon: <Table2 className="w-3.5 h-3.5" />, onSelect: () => view.onViewData(widget) }]
        : []),
      { key: 'full', label: 'View full screen', icon: <Maximize2 className="w-3.5 h-3.5" />, onSelect: () => view.onFullscreen(widget) },
    ];
    controls = (
      <div className="dash-widget-menu dash-no-drag">
        <IconMenu label={`Actions for ${title}`} icon={<EllipsisVertical className="w-4 h-4" />} items={items} />
      </div>
    );
  }

  return (
    <div
      className={`h-full w-full ${className || ''}`}
      onMouseDown={edit ? () => edit.onSelect(widget.id) : undefined}
      onFocusCapture={edit ? () => edit.onSelect(widget.id) : undefined}
      style={selected ? { outline: '2px solid #2A82E7', outlineOffset: 2, borderRadius: theme.radius } : undefined}
      aria-label={edit ? `${title} widget${selected ? ', selected' : ''}` : undefined}
      role={edit ? 'group' : undefined}
    >
      <WidgetFrame
        widget={widget}
        def={def}
        options={options}
        data={data}
        theme={theme}
        mode={mode}
        range={range}
        renderer={renderer}
        onNavigate={onNavigate}
        controls={controls}
        selected={selected}
        onChooseData={edit ? () => edit.onChooseData(widget.id) : undefined}
      />
    </div>
  );
});
