import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';

interface SignalSparklineProps {
  signalId: string;
  quality: string;
}

/**
 * At most this many sparkline history requests in flight (R4-SG-01). The table renders one
 * sparkline per signal; unthrottled, hundreds of history requests filled the browser's six
 * connections to the appliance, so a dialog's own request (e.g. "Checking which data models use
 * it…") waited 15–20 s behind them.
 */
const SPARKLINE_CONCURRENCY = 2;
let sparklinesInFlight = 0;
const sparklineQueue: Array<() => void> = [];

function runSparkline<T>(task: () => Promise<T>, isWanted: () => boolean): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const start = () => {
      if (!isWanted()) {
        resolve(null); // unmounted while queued: never sent
        next();
        return;
      }
      sparklinesInFlight += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          sparklinesInFlight -= 1;
          next();
        });
    };
    if (sparklinesInFlight < SPARKLINE_CONCURRENCY) start();
    else sparklineQueue.push(start);
  });
}

function next(): void {
  while (sparklinesInFlight < SPARKLINE_CONCURRENCY && sparklineQueue.length) {
    const start = sparklineQueue.shift();
    if (start) start();
  }
}

export const SignalSparkline: React.FC<SignalSparklineProps> = ({ signalId, quality }) => {
  const [points, setPoints] = useState<number[] | null>(null);

  useEffect(() => {
    let isCurrent = true;
    const fetchHistory = async () => {
      try {
        const res = await runSparkline(
          () => api<{ items: Array<{ value: unknown; quality?: string }> }>(`/api/v1/observations/history?signal_id=${signalId}&from=now-15m&limit=30`),
          () => isCurrent,
        );
        if (res === null) return;
        const numericValues = (res.items || [])
          .filter((item) => item.value !== null && item.value !== undefined && typeof item.value !== 'boolean')
          .map((item) => Number(item.value))
          .filter((v) => Number.isFinite(v));

        if (isCurrent) {
          setPoints(numericValues.length > 0 ? numericValues : null);
        }
      } catch {
        if (isCurrent) setPoints(null);
      }
    };

    void fetchHistory();
    return () => {
      isCurrent = false;
    };
  }, [signalId]);

  if (!points || points.length < 1) {
    return <span className="text-slate-300 text-[11px]">—</span>;
  }

  const renderPoints = points.length === 1 ? [points[0], points[0]] : points;

  const width = 80;
  const height = 18;
  const min = Math.min(...renderPoints);
  const max = Math.max(...renderPoints);
  const span = max - min || 1;

  const strokeColor =
    quality === 'GOOD'
      ? '#0DBA67'
      : quality === 'UNCERTAIN'
      ? '#F59E0B'
      : quality === 'BAD'
      ? '#EF4444'
      : '#94A3B8';

  const polyPoints = renderPoints
    .map((v, i) => {
      const x = (i / (renderPoints.length - 1)) * (width - 4) + 2;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const lastX = width - 2;
  const lastY = height - 2 - ((renderPoints[renderPoints.length - 1] - min) / span) * (height - 4);

  return (
    <svg className="w-20 h-4 overflow-visible" viewBox={`0 0 ${width} ${height}`}>
      <polyline
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={polyPoints}
      />
      <circle cx={lastX} cy={lastY} r="2" fill={strokeColor} />
    </svg>
  );
};
