import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';

interface SignalSparklineProps {
  signalId: string;
  quality: string;
}

export const SignalSparkline: React.FC<SignalSparklineProps> = ({ signalId, quality }) => {
  const [points, setPoints] = useState<number[] | null>(null);

  useEffect(() => {
    let isCurrent = true;
    const fetchHistory = async () => {
      try {
        const res = await api<{ items: Array<{ value: unknown }> }>(
          `/api/v1/observations/history?signal_id=${signalId}&from=now-15m&limit=30`
        );
        const numericValues = (res.items || [])
          .map((item) => Number(item.value))
          .filter((v) => !isNaN(v));

        if (isCurrent) {
          setPoints(numericValues.length > 1 ? numericValues : null);
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

  if (!points || points.length < 2) {
    return <span className="text-slate-300 text-[11px]">—</span>;
  }

  const width = 80;
  const height = 18;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;

  const strokeColor =
    quality === 'GOOD'
      ? '#0DBA67'
      : quality === 'UNCERTAIN'
      ? '#F59E0B'
      : quality === 'BAD'
      ? '#EF4444'
      : '#94A3B8';

  const polyPoints = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * (width - 4) + 2;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const lastX = width - 2;
  const lastY = height - 2 - ((points[points.length - 1] - min) / span) * (height - 4);

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
