import React from 'react';
import { KpiTile } from '../historian/hsUi';

interface StorageHealthStripProps {
  databaseCount: number | null;
  stableCount: number | null;
  subtableCount: number | null;
  recordingActive: number | null;
  recordingPaused: number | null;
  recordingError: number | null;
  draftCount?: number | null;
  activeType?: 'all' | 'database' | 'stable' | 'subtable';
  onFilterType?: (type: 'database' | 'stable' | 'subtable') => void;
  onOpenDrafts?: () => void;
}

const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());

/**
 * KPI row in the Connections style (11 px UPPERCASE label, 24 px number). "Recording" is muted at 0 —
 * never a green tick when nothing is written (R1-14); errors and paused objects are named under it.
 */
export const StorageHealthStrip: React.FC<StorageHealthStripProps> = ({
  databaseCount,
  stableCount,
  subtableCount,
  recordingActive,
  recordingPaused,
  recordingError,
  draftCount,
  activeType,
  onFilterType,
  onOpenDrafts,
}) => {
  const recordingSub = [
    recordingPaused ? `${recordingPaused} paused` : '',
    recordingError ? `${recordingError} with write errors` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`grid grid-cols-2 ${draftCount != null ? 'sm:grid-cols-5' : 'sm:grid-cols-4'} gap-3`}>
      <KpiTile label="Databases" value={n(databaseCount)} active={activeType === 'database'} onClick={onFilterType ? () => onFilterType('database') : undefined} hint="Show databases in the Objects table" />
      <KpiTile label="Supertables" value={n(stableCount)} active={activeType === 'stable'} onClick={onFilterType ? () => onFilterType('stable') : undefined} hint="Show supertables in the Objects table" />
      <KpiTile label="Subtables" value={n(subtableCount)} active={activeType === 'subtable'} onClick={onFilterType ? () => onFilterType('subtable') : undefined} hint="Show subtables in the Objects table" />
      <KpiTile
        label="Recording"
        value={n(recordingActive)}
        tone={recordingError ? 'error' : recordingActive ? 'success' : 'muted'}
        sub={recordingSub || (recordingActive ? 'subtables with an active binding' : 'nothing is recorded yet')}
        hint="User subtables that are active and have at least one active binding"
      />
      {draftCount != null && (
        <KpiTile label="Drafts" value={n(draftCount)} tone={draftCount ? 'ink' : 'muted'} onClick={onOpenDrafts} hint="Unfinished wizard drafts" />
      )}
    </div>
  );
};
