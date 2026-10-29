import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  ResourceNode,
  ConnectionItem,
  SignalItem,
  LayoutMachineNode,
  OutputGroup,
  ActivityEvent,
  DiagnosticItem,
} from '../types';
import { initialResources } from '../fixtures/factoryData';
import { initialConnections } from '../fixtures/connectionsData';
import { initialSignals } from '../fixtures/signalsData';
import { initialLayoutNodes } from '../fixtures/layoutData';
import { initialOutputGroups } from '../fixtures/outputGroupsData';
import { initialActivities } from '../fixtures/activityData';
import { initialDiagnostics } from '../fixtures/diagnosticsData';

interface AppContextType {
  resources: ResourceNode[];
  connections: ConnectionItem[];
  signals: SignalItem[];
  layoutNodes: LayoutMachineNode[];
  outputGroups: OutputGroup[];
  activities: ActivityEvent[];
  diagnostics: DiagnosticItem[];
  selectedResourceId: string;
  setSelectedResourceId: (id: string) => void;
  selectedConnectionId: string;
  setSelectedConnectionId: (id: string) => void;
  selectedSignalId: string;
  setSelectedSignalId: (id: string) => void;
  isStreaming: boolean;
  setIsStreaming: (streaming: boolean) => void;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  resetToReference: () => void;
  addResource: (res: Partial<ResourceNode>) => void;
  updateLayoutNode: (id: string, updates: Partial<LayoutMachineNode>) => void;
  testConnection: (id: string) => Promise<{ success: boolean; latency: number }>;
  addSignal: (signal: Partial<SignalItem>) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [resources, setResources] = useState<ResourceNode[]>(() => {
    const saved = localStorage.getItem('fx_resources');
    return saved ? JSON.parse(saved) : initialResources;
  });

  const [connections, setConnections] = useState<ConnectionItem[]>(() => {
    const saved = localStorage.getItem('fx_connections');
    return saved ? JSON.parse(saved) : initialConnections;
  });

  const [signals, setSignals] = useState<SignalItem[]>(() => {
    const saved = localStorage.getItem('fx_signals');
    return saved ? JSON.parse(saved) : initialSignals;
  });

  const [layoutNodes, setLayoutNodes] = useState<LayoutMachineNode[]>(() => {
    const saved = localStorage.getItem('fx_layout_nodes');
    return saved ? JSON.parse(saved) : initialLayoutNodes;
  });

  const [outputGroups, setOutputGroups] = useState<OutputGroup[]>(() => {
    const saved = localStorage.getItem('fx_output_groups');
    return saved ? JSON.parse(saved) : initialOutputGroups;
  });

  const [activities, setActivities] = useState<ActivityEvent[]>(initialActivities);
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>(initialDiagnostics);

  const [selectedResourceId, setSelectedResourceId] = useState<string>('res-cnc-01');
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>('conn-opcua-01');
  const [selectedSignalId, setSelectedSignalId] = useState<string>('sig-cnc-temp-01');
  const [isStreaming, setIsStreaming] = useState<boolean>(true);
  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Persist state to localStorage
  useEffect(() => {
    localStorage.setItem('fx_resources', JSON.stringify(resources));
  }, [resources]);

  useEffect(() => {
    localStorage.setItem('fx_connections', JSON.stringify(connections));
  }, [connections]);

  useEffect(() => {
    localStorage.setItem('fx_signals', JSON.stringify(signals));
  }, [signals]);

  useEffect(() => {
    localStorage.setItem('fx_layout_nodes', JSON.stringify(layoutNodes));
  }, [layoutNodes]);

  useEffect(() => {
    localStorage.setItem('fx_output_groups', JSON.stringify(outputGroups));
  }, [outputGroups]);

  // Subtle live variation to simulate telemetry updates when streaming
  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => {
      setSignals((prev) =>
        prev.map((s) => {
          if (s.id === 'sig-cnc-temp-01' && typeof s.currentValue === 'number') {
            const jitter = (Math.random() - 0.48) * 0.1;
            const newVal = Number((s.currentValue + jitter).toFixed(1));
            return {
              ...s,
              currentValue: newVal,
              lastUpdated: new Date().toLocaleTimeString(),
              history: [...(s.history?.slice(-15) || []), newVal],
            };
          }
          if (s.id === 'sig-prs-bar-01' && typeof s.currentValue === 'number') {
            const jitter = (Math.random() - 0.5) * 0.4;
            const newVal = Number((s.currentValue + jitter).toFixed(1));
            return {
              ...s,
              currentValue: newVal,
              lastUpdated: new Date().toLocaleTimeString(),
              history: [...(s.history?.slice(-15) || []), newVal],
            };
          }
          return s;
        })
      );
    }, 2000);
    return () => clearInterval(interval);
  }, [isStreaming]);

  const resetToReference = () => {
    setResources(initialResources);
    setConnections(initialConnections);
    setSignals(initialSignals);
    setLayoutNodes(initialLayoutNodes);
    setOutputGroups(initialOutputGroups);
    setActivities(initialActivities);
    setDiagnostics(initialDiagnostics);
    setSelectedResourceId('res-cnc-01');
    setSelectedConnectionId('conn-opcua-01');
    setSelectedSignalId('sig-cnc-temp-01');
    localStorage.clear();
  };

  const addResource = (res: Partial<ResourceNode>) => {
    const newRes: ResourceNode = {
      id: `res-user-${Date.now()}`,
      name: res.name || 'New Machine',
      type: res.type || 'machine',
      code: res.code || `MC-${Math.floor(Math.random() * 900 + 100)}`,
      status: res.status || 'running',
      parentId: res.parentId || selectedResourceId,
      signalsCount: 0,
      description: res.description || '',
    };
    setResources((prev) => [...prev, newRes]);
  };

  const updateLayoutNode = (id: string, updates: Partial<LayoutMachineNode>) => {
    setLayoutNodes((prev) =>
      prev.map((node) => (node.id === id ? { ...node, ...updates } : node))
    );
  };

  const testConnection = async (id: string): Promise<{ success: boolean; latency: number }> => {
    setConnections((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: 'testing' } : c))
    );
    await new Promise((r) => setTimeout(r, 600));
    const latency = Math.floor(Math.random() * 20 + 8);
    setConnections((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              status: 'connected',
              latencyMs: latency,
              lastConnected: new Date().toISOString().replace('T', ' ').substring(0, 19),
            }
          : c
      )
    );
    return { success: true, latency };
  };

  const addSignal = (signal: Partial<SignalItem>) => {
    const newSig: SignalItem = {
      id: `sig-user-${Date.now()}`,
      name: signal.name || 'New Measured Parameter',
      tag: signal.tag || `CUSTOM.TAG.${Math.floor(Math.random() * 1000)}`,
      sourceConnectionId: signal.sourceConnectionId || connections[0].id,
      sourceConnectionName: signal.sourceConnectionName || connections[0].name,
      resourceId: signal.resourceId || selectedResourceId,
      resourcePath: signal.resourcePath || 'Factory Plant / Selected Unit',
      dataType: signal.dataType || 'analog',
      unit: signal.unit || 'units',
      currentValue: signal.currentValue ?? 0,
      quality: 'GOOD',
      lastUpdated: new Date().toLocaleTimeString(),
      sampleIntervalMs: signal.sampleIntervalMs || 250,
    };
    setSignals((prev) => [newSig, ...prev]);
  };

  return (
    <AppContext.Provider
      value={{
        resources,
        connections,
        signals,
        layoutNodes,
        outputGroups,
        activities,
        diagnostics,
        selectedResourceId,
        setSelectedResourceId,
        selectedConnectionId,
        setSelectedConnectionId,
        selectedSignalId,
        setSelectedSignalId,
        isStreaming,
        setIsStreaming,
        searchOpen,
        setSearchOpen,
        searchQuery,
        setSearchQuery,
        resetToReference,
        addResource,
        updateLayoutNode,
        testConnection,
        addSignal,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
};
