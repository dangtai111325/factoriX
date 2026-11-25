/**
 * Widget chrome: title row (drag handle in edit mode), description tooltip, background / border /
 * padding / accent from the common options, a small data-state badge, full-body states (first load,
 * unbound, resolve errors, missing renderer) and a per-widget error boundary. The renderer receives the
 * ResizeObserver-measured body size and draws only the body.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CircleAlert, Database, Info, RotateCcw } from 'lucide-react';
import { STATE_LABEL, stateColor } from '../format';
import { isHexColor, readableOn } from '../theme';
import { resolveTimeRange } from '../timeRange';
import { serverNowMs } from '../../../lib/liveStream';
import type { DashboardWidget, DataState, NavTarget, ThemeTokens, TimeRange, WidgetData, WidgetRendererProps, WidgetTypeDef } from '../types';

// ------------------------------------------------------------------ error boundary

interface BoundaryProps {
  resetKey: string;
  children: React.ReactNode;
  theme: ThemeTokens;
}

class WidgetErrorBoundary extends React.Component<BoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn('Dashboard widget failed to render', error);
  }

  componentDidUpdate(prev: BoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const t = this.props.theme;
    return (
      <div role="alert" className="h-full w-full flex flex-col items-center justify-center gap-2 text-center px-3" style={{ color: t.text_muted }}>
        <AlertTriangle className="w-5 h-5" style={{ color: t.bad }} aria-hidden="true" />
        <p className="text-[12px] font-semibold" style={{ color: t.text }}>
          This widget could not be drawn
        </p>
        <p className="text-[11px] max-w-[260px] break-words">{this.state.error.message || 'Unexpected rendering error.'}</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="dash-no-drag inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md border"
          style={{ borderColor: t.border, color: t.text }}
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" /> Try again
        </button>
      </div>
    );
  }
}

// ------------------------------------------------------------------ helpers

const SEVERITY: DataState[] = ['bad', 'stale', 'delayed', 'no_data', 'uncertain', 'unknown'];

/** Worst data state over the series (good states are not badged). */
export function worstState(data: WidgetData): { state: DataState; count: number; details: string[] } | null {
  let worst: DataState | null = null;
  let count = 0;
  const details: string[] = [];
  for (const s of data.series) {
    const st = s.latest?.state;
    if (!st || st === 'good') continue;
    details.push(`${s.label}: ${STATE_LABEL[st]}`);
    if (worst === null || SEVERITY.indexOf(st) < SEVERITY.indexOf(worst)) {
      worst = st;
      count = 1;
    } else if (st === worst) count++;
  }
  return worst ? { state: worst, count, details } : null;
}

function useElementSize<T extends HTMLElement>(): [React.RefObject<T>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

const PADDING: Record<string, number> = { compact: 6, normal: 12, roomy: 18 };

const Renderer = React.memo(function Renderer({ Comp, props }: { Comp: React.ComponentType<WidgetRendererProps>; props: WidgetRendererProps }) {
  return <Comp {...props} />;
}, (a, b) => {
  if (a.Comp !== b.Comp) return false;
  const p = a.props;
  const q = b.props;
  return (
    p.widget === q.widget &&
    p.def === q.def &&
    p.options === q.options &&
    p.data === q.data &&
    p.theme === q.theme &&
    p.size === q.size &&
    p.mode === q.mode &&
    p.timeRange.start === q.timeRange.start &&
    p.timeRange.end === q.timeRange.end &&
    p.onNavigate === q.onNavigate
  );
});

// ------------------------------------------------------------------ frame

export interface WidgetFrameProps {
  widget: DashboardWidget;
  def: WidgetTypeDef | undefined;
  options: Record<string, unknown>;
  data: WidgetData;
  theme: ThemeTokens;
  mode: 'view' | 'edit';
  range: TimeRange;
  renderer: React.ComponentType<WidgetRendererProps> | undefined;
  onNavigate: (target: NavTarget) => void;
  /** Header controls (edit toolbar or view menu), rendered at the right of the title row. */
  controls?: React.ReactNode;
  /** Edit mode: "Choose data" in the unbound state. */
  onChooseData?: () => void;
  selected?: boolean;
  /** Fill the parent (full-screen widget dialog) instead of the grid cell. */
  className?: string;
}

export const WidgetFrame: React.FC<WidgetFrameProps> = ({
  widget,
  def,
  options,
  data,
  theme,
  mode,
  range,
  renderer,
  onNavigate,
  controls,
  onChooseData,
  selected,
  className = '',
}) => {
  const [bodyRef, size] = useElementSize<HTMLDivElement>();
  // A one-row widget (link, divider, text at the default 40 px rows) has no room for a title row: the
  // header would take the whole height and the body would get 0 px (nothing rendered). Such a widget is
  // "tiny": compact padding, no in-flow header; in the Studio its title and controls float over it on
  // hover/selection, in view mode the title stays available as the frame's accessible name.
  const [frameRef, frameSize] = useElementSize<HTMLDivElement>();
  const tiny = frameSize.height > 0 && frameSize.height < 76;
  const showTitle = options.show_title !== false && Boolean(widget.title);
  const description = typeof options.description === 'string' ? options.description : '';
  const background =
    options.background === 'transparent' ? 'transparent' : options.background === 'custom' && isHexColor(options.background_color) ? options.background_color : theme.surface;
  const textColor = options.background === 'custom' && isHexColor(options.background_color) ? readableOn(options.background_color) : theme.text;
  const accent = isHexColor(options.accent_color) ? options.accent_color : null;
  const pad = Math.min(PADDING[String(options.padding)] ?? 12, tiny ? 6 : Infinity);
  const widgetTheme = useMemo<ThemeTokens>(
    () => (accent || textColor !== theme.text ? { ...theme, ...(accent ? { accent } : {}), ...(textColor !== theme.text ? { text: textColor } : {}) } : theme),
    [theme, accent, textColor],
  );
  const showQuality = options.show_quality !== false;
  const badge = showQuality && data.status === 'ready' ? worstState(data) : null;
  // Relative windows follow the clock; data changes re-render, so live charts move with their data.
  const timeRange = useMemo(() => resolveTimeRange(range, Math.floor(serverNowMs() / 1000) * 1000), [range, data]);
  const rendererProps = useMemo<WidgetRendererProps>(
    () => ({ widget, def: def!, options, data, theme: widgetTheme, size, mode, timeRange, onNavigate }),
    [widget, def, options, data, widgetTheme, size, mode, timeRange, onNavigate],
  );

  const hasAnyData = data.series.some((s) => s.latest || (s.history && s.history.points.length));
  let body: React.ReactNode;
  if (!def) {
    body = <BodyNotice theme={theme} icon={<CircleAlert className="w-5 h-5" />} title="Unknown widget type" text={`“${widget.type}” is not in this server's widget library.`} />;
  } else if (data.status === 'unbound') {
    body =
      mode === 'edit' ? (
        <BodyNotice
          theme={theme}
          icon={<Database className="w-5 h-5" />}
          title="Choose data in the inspector"
          text={def.data.roles?.length ? `Bind ${def.data.roles.map((r) => r.label).join(', ')}.` : 'Pick a signal or a Data Model field for this widget.'}
          action={
            onChooseData ? (
              <button
                type="button"
                onClick={onChooseData}
                className="dash-no-drag mt-1 text-[11px] font-semibold px-2.5 py-1 rounded-md text-white"
                style={{ background: '#2A82E7' }}
              >
                Choose data
              </button>
            ) : null
          }
        />
      ) : (
        <BodyNotice theme={theme} icon={<Database className="w-5 h-5" />} title="No data source" text="This widget is not connected to data." />
      );
  } else if (data.status === 'loading' && !hasAnyData) {
    body = <BodySkeleton theme={theme} />;
  } else if (data.status === 'error') {
    const errors = data.series.filter((s) => s.error);
    body = (
      <div role="alert" className="h-full w-full overflow-auto flex flex-col items-center justify-center gap-1.5 text-center px-2">
        <AlertTriangle className="w-5 h-5 shrink-0" style={{ color: theme.bad }} aria-hidden="true" />
        <p className="text-[12px] font-semibold" style={{ color: widgetTheme.text }}>
          {data.error || 'The data could not be loaded.'}
        </p>
        {errors.length > 1 && (
          <ul className="text-[11px] text-left space-y-0.5 max-w-full" style={{ color: theme.text_muted }}>
            {errors.slice(0, 6).map((s) => (
              <li key={s.binding.id} className="truncate" title={`${s.label}: ${s.error!.message}`}>
                <span className="font-semibold">{s.label}</span>: {s.error!.message}
              </li>
            ))}
            {errors.length > 6 && <li>+{errors.length - 6} more</li>}
          </ul>
        )}
      </div>
    );
  } else if (!renderer) {
    body = <BodyNotice theme={theme} icon={<CircleAlert className="w-5 h-5" />} title="Renderer unavailable" text={`The “${def.label}” renderer is not part of this build.`} />;
  } else {
    body =
      size.width > 0 && size.height > 0 ? (
        <WidgetErrorBoundary resetKey={`${widget.type}:${widget.version}`} theme={theme}>
          <Renderer Comp={renderer} props={rendererProps} />
        </WidgetErrorBoundary>
      ) : null;
  }

  const headerWanted = showTitle || mode === 'edit' || Boolean(badge) || data.warnings.length > 0;
  // In view mode the header row exists for the title / state badge / notes; the actions menu alone floats
  // in the corner (so "Show title" off really gives the space back to the body).
  const showHeader = !tiny && headerWanted;
  const floatingHeader = tiny && mode === 'edit';
  const floatingMenu = !showHeader && !floatingHeader && Boolean(controls);
  const align = options.title_align === 'center' ? 'center' : 'left';

  return (
    <div
      ref={frameRef}
      className={`dash-widget relative h-full w-full flex flex-col overflow-hidden ${tiny ? 'dash-tiny' : ''} ${className}`}
      data-selected={selected ? 'true' : undefined}
      aria-label={mode === 'view' && widget.title ? widget.title : undefined}
      style={{
        background,
        color: textColor,
        borderRadius: theme.radius,
        border: options.border === false ? '1px solid transparent' : `1px solid ${theme.border}`,
        boxShadow:
          [accent ? `inset 0 3px 0 ${accent}` : '', options.background === 'transparent' || options.border === false || theme.dark ? '' : '0 1px 2px rgba(16,24,40,0.04)']
            .filter(Boolean)
            .join(', ') || undefined,
      }}
    >
      {floatingMenu && <div className="absolute top-1 right-1 z-[3]">{controls}</div>}
      {(showHeader || floatingHeader) && (
        <div
          className={`flex items-center gap-1.5 shrink-0 min-h-[28px] ${mode === 'edit' ? 'dash-drag-handle cursor-move' : ''} ${floatingHeader ? 'dash-tiny-head absolute inset-x-0 top-0 z-[3]' : ''}`}
          style={{ padding: floatingHeader ? `2px ${pad}px` : `${Math.max(4, pad - 4)}px ${pad}px 0 ${pad}px`, ...(floatingHeader ? { background } : {}) }}
        >
          <div className={`min-w-0 flex-1 flex items-center gap-1 ${align === 'center' ? 'justify-center' : ''}`}>
            {showTitle ? (
              <h3 className="truncate font-semibold leading-tight" style={{ fontSize: '1em' }} title={widget.title}>
                {widget.title}
              </h3>
            ) : mode === 'edit' ? (
              <span className="truncate text-[11px] italic" style={{ color: theme.text_muted }}>
                {def?.label || widget.type}
              </span>
            ) : null}
            {description && (
              <span className="dash-no-drag inline-flex shrink-0" title={description} aria-label={description} tabIndex={0}>
                <Info className="w-3.5 h-3.5" style={{ color: theme.text_muted }} aria-hidden="true" />
              </span>
            )}
          </div>
          {badge && (
            <span
              className="dash-no-drag shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[10px] font-semibold border"
              style={{ borderColor: stateColor(badge.state, theme), color: stateColor(badge.state, theme) }}
              title={badge.details.join('\n')}
              role="status"
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: stateColor(badge.state, theme) }} aria-hidden="true" />
              {data.series.length > 1 && badge.count > 1 ? `${badge.count} ${STATE_LABEL[badge.state].toLowerCase()}` : STATE_LABEL[badge.state]}
            </span>
          )}
          {data.warnings.length > 0 && data.status !== 'error' && (
            <span className="dash-no-drag shrink-0 inline-flex" title={data.warnings.join('\n')} aria-label={`${data.warnings.length} note${data.warnings.length === 1 ? '' : 's'}: ${data.warnings.join('; ')}`} tabIndex={0}>
              <AlertTriangle className="w-3.5 h-3.5" style={{ color: theme.warning }} aria-hidden="true" />
            </span>
          )}
          {controls}
        </div>
      )}
      <div className="flex-1 min-h-0 min-w-0 relative">
        <div ref={bodyRef} className="absolute overflow-hidden" style={{ inset: showHeader ? `${Math.round(pad / 2)}px ${pad}px ${pad}px ${pad}px` : pad }}>
          {body}
        </div>
      </div>
    </div>
  );
};

const BodyNotice: React.FC<{ theme: ThemeTokens; icon: React.ReactNode; title: string; text?: string; action?: React.ReactNode }> = ({ theme, icon, title, text, action }) => (
  <div className="h-full w-full flex flex-col items-center justify-center gap-1 text-center px-2 overflow-hidden">
    <span style={{ color: theme.text_muted }} aria-hidden="true">
      {icon}
    </span>
    <p className="text-[12px] font-semibold" style={{ color: theme.text }}>
      {title}
    </p>
    {text && (
      <p className="text-[11px] max-w-[280px]" style={{ color: theme.text_muted }}>
        {text}
      </p>
    )}
    {action}
  </div>
);

const BodySkeleton: React.FC<{ theme: ThemeTokens }> = ({ theme }) => (
  <div className="h-full w-full flex flex-col gap-2 justify-center" role="status" aria-label="Loading widget data">
    <div className="h-3 rounded animate-pulse w-1/2" style={{ background: theme.surface_alt }} />
    <div className="flex-1 max-h-24 rounded animate-pulse" style={{ background: theme.surface_alt }} />
    <div className="h-3 rounded animate-pulse w-1/3" style={{ background: theme.surface_alt }} />
  </div>
);
