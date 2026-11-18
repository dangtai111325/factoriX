import React from 'react';
import { Database, HardDrive } from 'lucide-react';
import { Segmented } from '../historian/hsUi';

export type StorageEngine = 'tdengine' | 'postgresql';

interface StorageEngineSwitcherProps {
  activeEngine: StorageEngine;
  onChange: (engine: StorageEngine) => void;
}

/** TDengine (managed by FactoriX) | PostgreSQL (read-only explorer) — Signals "Table | Live" switch style. */
export const StorageEngineSwitcher: React.FC<StorageEngineSwitcherProps> = ({ activeEngine, onChange }) => (
  <Segmented<StorageEngine>
    ariaLabel="Storage engine"
    value={activeEngine}
    onChange={onChange}
    options={[
      { id: 'tdengine', label: 'TDengine', icon: <HardDrive className="w-3.5 h-3.5" />, title: 'Time-series storage managed by FactoriX' },
      { id: 'postgresql', label: 'PostgreSQL (read-only)', icon: <Database className="w-3.5 h-3.5" />, title: 'Read-only explorer of the control-plane database' },
    ]}
  />
);
