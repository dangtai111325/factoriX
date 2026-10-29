import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  ResourceNode,
  ConnectionItem,
  SignalItem,
  LayoutMachineNode,
  OutputGroup,
  ActivityEvent,
  DiagnosticItem,
  PlantScope,
  DemoScenario,
  TestExecutionState,
  TestStepResult,
} from '../types';
import { initialResources } from '../fixtures/factoryData';
import { initialConnections } from '../fixtures/connectionsData';
import { initialSignals } from '../fixtures/signalsData';
import { initialLayoutNodes } from '../fixtures/layoutData';
import { initialOutputGroups } from '../fixtures/outputGroupsData';
import { initialActivities } from '../fixtures/activityData';
import { initialDiagnostics } from '../fixtures/diagnosticsData';

export const AVAILABLE_PLANTS: PlantScope[] = [
  {
    id: 'plant-01',
    name: 'Plant 01 · CNC Machining',
    code: 'PLANT-01',
    zone: 'Riverside Main Facility',
    status: 'operational',
    assetsCount: 18,
  },
  {
    id: 'plant-02',
    name: 'Plant 02 · Robotic Welding',
    code: 'PLANT-02',
    zone: 'East Wing Automation Hall',
    status: 'operational',
    assetsCount: 24,
  },
  {
    id: 'plant-03',
    name: 'Plant 03 · Paint & Coating',
    code: 'PLANT-03',
    zone: 'North Chemical Processing',
    status: 'warning',
    assetsCount: 12,
  },
  {
    id: 'plant-04',
    name: 'Plant 04 · Final Assembly',
    code: 'PLANT-04',
    zone: 'South Logistics Hub',
    status: 'maintenance',
    assetsCount: 32,
  },
];

interface AppContextType {
  // Demo Mode & Scenarios (Review FX-01)
  isDemoMode: boolean;
  demoScenario: DemoScenario;
  setDemoScenario: (s: DemoScenario) => void;

  // Plant & Scope Context (Review FX-02, FX-25)
  availablePlants: PlantScope[];
  currentPlant: PlantScope;
  setCurrentPlant: (p: PlantScope) => void;

  // Primary Entities
  resources: ResourceNode[];
  connections: ConnectionItem[];
  signals: SignalItem[];
  layoutNodes: LayoutMachineNode[];
  outputGroups: OutputGroup[];
  activities: ActivityEvent[];
  diagnostics: DiagnosticItem[];

  // Filtered views by active plant
  scopedResources: ResourceNode[];
  scopedConnections: ConnectionItem[];
  scopedSignals: SignalItem[];

  // Entity Selection & Navigation State (Review FX-13)
  selectedResourceId: string;
  setSelectedResourceId: (id: string) => void;
  selectedConnectionId: string;
  setSelectedConnectionId: (id: string) => void;
  selectedSignalId: string;
  setSelectedSignalId: (id: string) => void;

  // Visual stream pause vs acquisition state (Review FX-02, FX-17)
  isStreaming: boolean;
  setIsStreaming: (streaming: boolean) => void;

  // Global search
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;

  // Real Demo State Mutations (Review FX-03, FX-04, FX-05, FX-07, FX-11)
  resetToReference: () => void;
  addResource: (res: Partial<ResourceNode>) => void;
  moveResource: (resourceId: string, newParentId: string) => { success: boolean; error?: string };
  updateLayoutNode: (id: string, updates: Partial<LayoutMachineNode>) => void;
  testConnection: (id: string) => Promise<{ success: boolean; latency: number }>;
  runDeterministicConnectionTest: (
    id: string,
    customScenario?: DemoScenario
  ) => Promise<{ overallStatus: TestExecutionState; latency: number; steps: TestStepResult[] }>;
  addSignal: (signal: Partial<SignalItem>) => void;
  bulkDeleteSignals: (signalIds: string[]) => { count: number; undo: () => void };
  bulkAssignOutputGroup: (signalIds: string[], groupId: string) => void;
  saveCalculatedSignal: (signal: Partial<SignalItem>) => void;
  saveOutputGroup: (group: OutputGroup) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

// Safe JSON parse helper to prevent crashes from corrupted storage (FX-12)
function safeParse<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn(`Failed to parse ${key} from localStorage, using fallback`, err);
    return fallback;
  }
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Demo Mode & Scenario
  const [isDemoMode] = useState<boolean>(true);
  const [demoScenario, setDemoScenario] = useState<DemoScenario>('healthy');

  // Plant Scope
  const [currentPlant, setCurrentPlant] = useState<PlantScope>(() => {
    const saved = localStorage.getItem('fx_active_plant_id');
    const found = AVAILABLE_PLANTS.find((p) => p.id === saved);
    return found || AVAILABLE_PLANTS[0];
  });

  const [resources, setResources] = useState<ResourceNode[]>(() =>
    safeParse('fx_resources', initialResources)
  );
  const [connections, setConnections] = useState<ConnectionItem[]>(() =>
    safeParse('fx_connections', initialConnections)
  );
  const [signals, setSignals] = useState<SignalItem[]>(() =>
    safeParse('fx_signals', initialSignals)
  );
  const [layoutNodes, setLayoutNodes] = useState<LayoutMachineNode[]>(() =>
    safeParse('fx_layout_nodes', initialLayoutNodes)
  );
  const [outputGroups, setOutputGroups] = useState<OutputGroup[]>(() =>
    safeParse('fx_output_groups', initialOutputGroups)
  );

  const [activities, setActivities] = useState<ActivityEvent[]>(initialActivities);
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>(initialDiagnostics);

  const [selectedResourceId, setSelectedResourceId] = useState<string>('res-cnc-01');
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>('conn-opcua-01');
  const [selectedSignalId, setSelectedSignalId] = useState<string>('sig-cnc-temp-01');
  const [isStreaming, setIsStreaming] = useState<boolean>(true);
  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Auto-sync with URL query params on initial mount (FX-13 deep-linking)
  useEffect(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const urlPlant = urlParams.get('plantId');
      const urlResource = urlParams.get('resourceId');
      const urlConnection = urlParams.get('connectionId');
      const urlSignal = urlParams.get('signalId');

      if (urlPlant) {
        const found = AVAILABLE_PLANTS.find((p) => p.id === urlPlant);
        if (found) setCurrentPlant(found);
      }
      if (urlResource) setSelectedResourceId(urlResource);
      if (urlConnection) setSelectedConnectionId(urlConnection);
      if (urlSignal) setSelectedSignalId(urlSignal);
    } catch (e) {
      // Ignore URL search parsing error
    }
  }, []);

  // Persist state to localStorage (Strict fx_* namespace only - FX-12)
  useEffect(() => {
    localStorage.setItem('fx_active_plant_id', currentPlant.id);
  }, [currentPlant]);

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

  // Derived plant scoped entities (FX-02)
  const scopedResources = resources.filter(
    (r) =>
      r.type === 'enterprise' ||
      r.type === 'site' ||
      !r.plantId ||
      r.plantId === currentPlant.id ||
      r.id === `res-${currentPlant.id}`
  );

  const scopedConnections = connections.filter(
    (c) => !c.plantId || c.plantId === currentPlant.id
  );

  const scopedSignals = signals.filter(
    (s) => !s.plantId || s.plantId === currentPlant.id
  );

  // Live telemetry stream simulator (Deterministic variations when streaming is active)
  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => {
      setSignals((prev) =>
        prev.map((s) => {
          if (s.dataType === 'analog' && typeof s.currentValue === 'number') {
            const jitter = (Math.sin(Date.now() / 3000) * 0.15) + (Math.random() - 0.5) * 0.05;
            const newVal = Number((s.currentValue + jitter).toFixed(2));
            return {
              ...s,
              currentValue: newVal,
              lastUpdated: new Date().toLocaleTimeString(),
              history: [...(s.history?.slice(-19) || []), newVal],
            };
          }
          return s;
        })
      );
    }, 1500);
    return () => clearInterval(interval);
  }, [isStreaming]);

  // Safe reference reset (Only removes fx_* keys - FX-12)
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
    setCurrentPlant(AVAILABLE_PLANTS[0]);

    // Only clear fx_ keys
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('fx_')) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  };

  const addResource = (res: Partial<ResourceNode>) => {
    const newRes: ResourceNode = {
      id: `res-user-${Date.now()}`,
      name: res.name || 'New Machine',
      type: res.type || 'machine',
      code: res.code || `MC-${Math.floor(Math.random() * 900 + 100)}`,
      status: res.status || 'running',
      parentId: res.parentId || selectedResourceId,
      plantId: currentPlant.id,
      signalsCount: 0,
      description: res.description || '',
    };
    setResources((prev) => [...prev, newRes]);
    setActivities((prev) => [
      {
        id: `act-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        severity: 'info',
        source: 'Factory Structure',
        eventType: 'Resource Created',
        message: `Created resource "${newRes.name}" (${newRes.code})`,
      },
      ...prev,
    ]);
  };

  // Move resource with cycle prevention & impact validation (Review FX-03)
  const moveResource = (
    resourceId: string,
    newParentId: string
  ): { success: boolean; error?: string } => {
    if (resourceId === newParentId) {
      return { success: false, error: 'Cannot move resource into itself.' };
    }

    // Check if newParentId is a descendant of resourceId (cycle check)
    const isDescendant = (parentCandidateId: string, targetId: string): boolean => {
      let current = resources.find((r) => r.id === parentCandidateId);
      while (current && current.parentId) {
        if (current.parentId === targetId) return true;
        current = resources.find((r) => r.id === current?.parentId);
      }
      return false;
    };

    if (isDescendant(newParentId, resourceId)) {
      return {
        success: false,
        error: 'Invalid hierarchy: cannot move a parent node inside its own descendant.',
      };
    }

    const movedNode = resources.find((r) => r.id === resourceId);
    const newParentNode = resources.find((r) => r.id === newParentId);

    setResources((prev) =>
      prev.map((r) => (r.id === resourceId ? { ...r, parentId: newParentId } : r))
    );

    // Update child counts
    setActivities((prev) => [
      {
        id: `act-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        severity: 'success',
        source: 'Factory Structure',
        eventType: 'Resource Relocated',
        message: `Moved "${movedNode?.name}" under "${newParentNode?.name}"`,
      },
      ...prev,
    ]);

    return { success: true };
  };

  const updateLayoutNode = (id: string, updates: Partial<LayoutMachineNode>) => {
    setLayoutNodes((prev) =>
      prev.map((node) => (node.id === id ? { ...node, ...updates } : node))
    );
  };

  // Basic connection test for backward compatibility
  const testConnection = async (id: string): Promise<{ success: boolean; latency: number }> => {
    const res = await runDeterministicConnectionTest(id, demoScenario);
    return { success: res.overallStatus === 'PASS', latency: res.latency };
  };

  // Deterministic multi-stage connection test (Review FX-06, FX-14)
  const runDeterministicConnectionTest = async (
    id: string,
    customScenario?: DemoScenario
  ): Promise<{ overallStatus: TestExecutionState; latency: number; steps: TestStepResult[] }> => {
    const activeScenario = customScenario || demoScenario;
    const targetConn = connections.find((c) => c.id === id) || connections[0];

    // Set connection testing state
    setConnections((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: 'testing' } : c))
    );

    await new Promise((r) => setTimeout(r, 450));

    const now = new Date().toLocaleTimeString();
    const steps: TestStepResult[] = [];

    // Stage 1: TCP / Physical Socket Handshake
    if (activeScenario === 'offline') {
      steps.push({
        stage: 'TCP_HANDSHAKE',
        status: 'FAIL',
        details: `Connection refused by remote host ${targetConn.endpoint} (ECONNREFUSED)`,
        timestamp: now,
        errorCode: 'NET_ECONNREFUSED_111',
      });
      return { overallStatus: 'FAIL', latency: 0, steps };
    }

    steps.push({
      stage: 'TCP_HANDSHAKE',
      status: 'PASS',
      latencyMs: targetConn.latencyMs || 12,
      details: `TCP socket established to ${targetConn.endpoint}`,
      timestamp: now,
    });

    // Stage 2: Protocol Security & Session Handshake
    if (activeScenario === 'auth_fail_mqtt' && targetConn.protocol === 'mqtt') {
      steps.push({
        stage: 'PROTOCOL_CONNECT',
        status: 'AUTH_ERROR',
        details: 'MQTT CONNACK return code 0x05: Connection Refused, not authorized.',
        timestamp: now,
        errorCode: 'MQTT_CONNACK_05_UNAUTHORIZED',
      });
      return { overallStatus: 'AUTH_ERROR', latency: 15, steps };
    }

    steps.push({
      stage: 'PROTOCOL_CONNECT',
      status: 'PASS',
      latencyMs: 18,
      details: `${targetConn.protocol.toUpperCase()} protocol session handshake validated`,
      timestamp: now,
    });

    // Stage 3: Node Discovery or Register Polling
    if (activeScenario === 'timeout_opcua' && targetConn.protocol === 'opcua') {
      steps.push({
        stage: 'NODE_BROWSE',
        status: 'TIMEOUT',
        details: 'OPC-UA BrowseService timed out after 5000ms while traversing Root/Objects.',
        timestamp: now,
        errorCode: 'OPCUA_BAD_TIMEOUT_800A0000',
      });
      return { overallStatus: 'TIMEOUT', latency: 5000, steps };
    }

    if (activeScenario === 'degraded_modbus' && targetConn.protocol === 'modbus') {
      steps.push({
        stage: 'REGISTER_READ',
        status: 'FAIL',
        details: 'Modbus Exception Code 0x02: Illegal Data Address for holding register 40120.',
        timestamp: now,
        errorCode: 'MODBUS_EXCEPTION_02_ILLEGAL_ADDR',
      });
      return { overallStatus: 'FAIL', latency: 140, steps };
    }

    steps.push({
      stage: targetConn.protocol === 'opcua' ? 'NODE_BROWSE' : 'REGISTER_READ',
      status: 'PASS',
      latencyMs: 14,
      details:
        targetConn.protocol === 'opcua'
          ? 'Browse returned 38 industrial nodes under Root/Objects'
          : 'Holding registers 40001-40010 read successfully',
      timestamp: now,
    });

    // Stage 4: Live Telemetry Sample Read
    steps.push({
      stage: 'SUBSCRIBE',
      status: 'PASS',
      latencyMs: 8,
      details: 'Active observation packet decoded with Good (0x00) quality',
      timestamp: now,
    });

    // Update connection status
    setConnections((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              status: 'connected',
              lastConnected: new Date().toISOString().replace('T', ' ').substring(0, 19),
              lastTestResult: {
                overallStatus: 'PASS',
                timestamp: now,
                steps,
              },
            }
          : c
      )
    );

    return { overallStatus: 'PASS', latency: 18, steps };
  };

  const addSignal = (signal: Partial<SignalItem>) => {
    const newSig: SignalItem = {
      id: signal.id || `sig-user-${Date.now()}`,
      name: signal.name || 'New Measured Parameter',
      tag: signal.tag || `CUSTOM.TAG.${Math.floor(Math.random() * 1000)}`,
      sourceConnectionId: signal.sourceConnectionId || connections[0].id,
      sourceConnectionName: signal.sourceConnectionName || connections[0].name,
      resourceId: signal.resourceId || selectedResourceId,
      resourcePath: signal.resourcePath || `${currentPlant.name} / Line 01`,
      plantId: currentPlant.id,
      dataType: signal.dataType || 'analog',
      unit: signal.unit || 'units',
      currentValue: signal.currentValue ?? 0,
      quality: 'GOOD',
      lastUpdated: new Date().toLocaleTimeString(),
      sampleIntervalMs: signal.sampleIntervalMs || 250,
      bindingType: signal.bindingType || 'opcua_node',
      bindingAddress: signal.bindingAddress || 'ns=2;s=Measurement',
      history: [Number(signal.currentValue) || 45],
    };
    setSignals((prev) => [newSig, ...prev]);
  };

  // Bulk Delete Signals with real mutation & undo support (Review FX-07)
  const bulkDeleteSignals = (signalIds: string[]) => {
    const deletedSignals = signals.filter((s) => signalIds.includes(s.id));
    setSignals((prev) => prev.filter((s) => !signalIds.includes(s.id)));

    setActivities((prev) => [
      {
        id: `act-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        severity: 'warning',
        source: 'Signals Catalog',
        eventType: 'Bulk Signals Deleted',
        message: `Deleted ${signalIds.length} signals (${deletedSignals.map((s) => s.tag).slice(0, 3).join(', ')})`,
      },
      ...prev,
    ]);

    return {
      count: signalIds.length,
      undo: () => {
        setSignals((prev) => [...deletedSignals, ...prev]);
      },
    };
  };

  // Bulk Assign Output Group (Review FX-07, FX-11)
  const bulkAssignOutputGroup = (signalIds: string[], groupId: string) => {
    setOutputGroups((prev) =>
      prev.map((g) => {
        if (g.id === groupId) {
          const unique = Array.from(new Set([...g.assignedSignals, ...signalIds]));
          return { ...g, assignedSignals: unique };
        }
        return g;
      })
    );

    const group = outputGroups.find((g) => g.id === groupId);
    setActivities((prev) => [
      {
        id: `act-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        severity: 'info',
        source: 'Signals Catalog',
        eventType: 'Output Group Assigned',
        message: `Assigned ${signalIds.length} signals to Output Group "${group?.name || groupId}"`,
      },
      ...prev,
    ]);
  };

  // Save Calculated Signal (Review FX-05)
  const saveCalculatedSignal = (sig: Partial<SignalItem>) => {
    const id = sig.id || `sig-calc-${Date.now()}`;
    const newCalc: SignalItem = {
      id,
      name: sig.name || 'Calculated Metric',
      tag: sig.tag || `CALC_${Math.floor(Math.random() * 900 + 100)}`,
      sourceConnectionId: 'conn-calc-engine',
      sourceConnectionName: 'Internal Calculation Engine',
      resourceId: sig.resourceId || selectedResourceId,
      resourcePath: sig.resourcePath || `${currentPlant.name} / Line 01`,
      plantId: currentPlant.id,
      dataType: 'calculated',
      unit: sig.unit || 'units',
      currentValue: sig.currentValue ?? 0,
      quality: 'GOOD',
      lastUpdated: new Date().toLocaleTimeString(),
      sampleIntervalMs: sig.sampleIntervalMs || 500,
      formula: sig.formula,
      dependencies: sig.dependencies || [],
      history: [Number(sig.currentValue) || 50],
    };

    setSignals((prev) => {
      const exists = prev.some((s) => s.id === id);
      if (exists) {
        return prev.map((s) => (s.id === id ? { ...s, ...newCalc } : s));
      }
      return [newCalc, ...prev];
    });

    setActivities((prev) => [
      {
        id: `act-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        severity: 'success',
        source: 'Calculated Signals',
        eventType: 'Formula Created',
        message: `Saved calculated signal "${newCalc.name}" (${newCalc.formula})`,
      },
      ...prev,
    ]);
  };

  // Save Output Group (Review FX-11)
  const saveOutputGroup = (group: OutputGroup) => {
    setOutputGroups((prev) => {
      const exists = prev.some((g) => g.id === group.id);
      if (exists) {
        return prev.map((g) => (g.id === group.id ? group : g));
      }
      return [group, ...prev];
    });
  };

  return (
    <AppContext.Provider
      value={{
        isDemoMode,
        demoScenario,
        setDemoScenario,
        availablePlants: AVAILABLE_PLANTS,
        currentPlant,
        setCurrentPlant,
        resources,
        connections,
        signals,
        layoutNodes,
        outputGroups,
        activities,
        diagnostics,
        scopedResources,
        scopedConnections,
        scopedSignals,
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
        moveResource,
        updateLayoutNode,
        testConnection,
        runDeterministicConnectionTest,
        addSignal,
        bulkDeleteSignals,
        bulkAssignOutputGroup,
        saveCalculatedSignal,
        saveOutputGroup,
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
