import React, { useMemo, useState } from 'react';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { ConnectionItem, SignalItem } from '../../types';
import { fetchSignalsUsage } from '../../lib/impactApi';
import { ModelUsageList, useModelUsage } from '../08_SignalsCatalog/ModelUsageList';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * R3-CN-02: pausing a connection is confirmed and states its impact: how many signals stop
 * collecting and which data models stop receiving new values (they keep their last values).
 */
export const PauseConnectionDialog: React.FC<{
  connection: ConnectionItem | null;
  signals: SignalItem[];
  error: string | null;
  onConfirm: (conn: ConnectionItem) => Promise<void>;
  onCancel: () => void;
}> = ({ connection, signals, error, onConfirm, onCancel }) => {
  const [openSeq, setOpenSeq] = useState(0);
  const [lastId, setLastId] = useState<string | null>(null);
  if ((connection?.id || null) !== lastId) {
    setLastId(connection?.id || null);
    if (connection) setOpenSeq((n) => n + 1);
  }

  const connSignals = useMemo(
    () =>
      connection
        ? signals.filter((s) => (s.sourceConnectionId || s.connectionId) === connection.id && s.enabled !== false)
        : [],
    [connection, signals],
  );
  const signalCount = connection ? Math.max(connSignals.length, connection.signalsCount || 0) : 0;
  const ids = useMemo(() => connSignals.map((s) => s.id), [connSignals]);
  const idsRef = React.useRef(ids);
  idsRef.current = ids;
  const [usage, retry] = useModelUsage(connection ? `${connection.id}:${openSeq}` : null, () => fetchSignalsUsage(idsRef.current));

  const modelCount = usage.status === 'ready' ? usage.models.length : null;
  const summary =
    signalCount === 0
      ? 'No signal is collected through this connection, so nothing stops.'
      : `${plural(signalCount, 'signal stops', 'signals stop')} collecting${
          modelCount === null ? '' : modelCount === 0 ? '. No data model uses them.' : `, ${plural(modelCount, 'data model freezes', 'data models freeze')}: they keep their last values and show the signals as "Paused" until you resume.`
        }`;

  return (
    <ConfirmDialog
      isOpen={Boolean(connection)}
      title={`Pause "${connection?.name || ''}"?`}
      message={summary}
      confirmText="Pause connection"
      busyLabel="Pausing…"
      variant="warning"
      wide
      confirmDisabled={signalCount > 0 && usage.status === 'loading'}
      error={error}
      onConfirm={() => (connection ? onConfirm(connection) : undefined)}
      onCancel={onCancel}
    >
      {signalCount > 0 && (
        <ModelUsageList
          state={usage}
          onRetry={retry}
          onNavigate={onCancel}
          emptyText="No data model uses the signals of this connection."
          heading={(count) => `Data models that stop receiving new values (${count}):`}
        />
      )}
      <p className="mt-2 text-[11px] text-[#657794]">Resume the connection to collect again. Stored history is kept.</p>
    </ConfirmDialog>
  );
};
