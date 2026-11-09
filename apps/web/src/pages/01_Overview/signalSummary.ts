/**
 * Signal quality summaries shared by Overview, Hierarchy and the Knowledge Graph.
 *
 * - Paused (connection paused) and disabled signals are counted apart: they are not problems and
 *   are excluded from "x of y good" (R3-CN-02).
 * - NO_CONNECTION (browser cannot reach the appliance) makes the whole summary "unknown" (R3-OV-01).
 * - `useValuesReady` keeps pages from printing "0 of N good" before the first latest values arrived
 *   (R3-KG-01).
 */
import { useEffect, useRef, useState } from 'react';
import { normalizeQuality } from '../../lib/format';
import type { LoadState } from '../../store/AppContext';

export interface QualitySummary {
  total: number;
  good: number;
  uncertain: number;
  bad: number;
  stale: number;
  nodata: number;
  paused: number;
  disabled: number;
  noConnection: number;
  /** Signals expected to collect: total minus paused and disabled. */
  active: number;
}

export function summarizeQualities(signals: Array<{ quality?: unknown }>): QualitySummary {
  const s: QualitySummary = {
    total: signals.length,
    good: 0,
    uncertain: 0,
    bad: 0,
    stale: 0,
    nodata: 0,
    paused: 0,
    disabled: 0,
    noConnection: 0,
    active: 0,
  };
  for (const signal of signals) {
    const q = normalizeQuality(signal.quality);
    if (q === 'GOOD') s.good++;
    else if (q === 'UNCERTAIN') s.uncertain++;
    else if (q === 'BAD') s.bad++;
    else if (q === 'STALE') s.stale++;
    else if (q === 'PAUSED') s.paused++;
    else if (q === 'DISABLED') s.disabled++;
    else if (q === 'NO_CONNECTION') s.noConnection++;
    else s.nodata++;
  }
  s.active = s.total - s.paused - s.disabled;
  return s;
}

/** Settle time after the metadata load before an all-empty value set is believed. */
const SETTLE_MS = 1500;

/**
 * True once latest values can be trusted for counts: the shared load is ready and either a value
 * arrived, there are no signals, or the settle time passed (a real "no data yet" is then shown).
 * Once true it stays true, so a later refresh never flips counts back to "Loading…".
 */
export function useValuesReady(loadState: LoadState, signals: Array<{ lastUpdated?: string; receivedTime?: string }>): boolean {
  const readyRef = useRef(false);
  const [settled, setSettled] = useState(false);
  const anyValue = signals.some((s) => Boolean(s.lastUpdated || s.receivedTime));

  useEffect(() => {
    if (loadState !== 'ready' || settled) return;
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [loadState, settled]);

  if (!readyRef.current && loadState === 'ready' && (anyValue || signals.length === 0 || settled)) readyRef.current = true;
  return readyRef.current;
}

export type SummaryTone = 'good' | 'warning' | 'neutral' | 'loading' | 'unknown';

/** One-line text for a signal set, e.g. "52 of 56 signals good · 4 paused". */
export function qualityLine(summary: QualitySummary, ready: boolean): { text: string; tone: SummaryTone } {
  if (summary.total === 0) return { text: 'No signals bound yet', tone: 'neutral' };
  if (!ready) return { text: 'Loading signal values…', tone: 'loading' };
  if (summary.noConnection > 0) return { text: 'Signal status unknown (no connection to appliance)', tone: 'unknown' };
  const extras = [
    summary.paused ? `${summary.paused} paused` : '',
    summary.disabled ? `${summary.disabled} disabled` : '',
  ].filter(Boolean);
  const suffix = extras.length ? ` · ${extras.join(' · ')}` : '';
  if (summary.active === 0) {
    return { text: `${summary.total} ${summary.total === 1 ? 'signal' : 'signals'}${suffix}`, tone: 'neutral' };
  }
  const text = `${summary.good} of ${summary.active} ${summary.active === 1 ? 'signal' : 'signals'} good${suffix}`;
  return { text, tone: summary.good === summary.active ? 'good' : 'warning' };
}
