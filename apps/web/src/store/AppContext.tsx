import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import {
  ActivityEvent,
  ConnectionDisplayState,
  ConnectionItem,
  DiagnosticItem,
  EdgeItem,
  LayoutMachineNode,
  OutputGroup,
  PlantScope,
  ProtocolType,
  ResourceNode,
  SignalItem,
  TestExecutionState,
  TestStepResult,
} from '../types'
import {
  HealthMsg,
  LatestMsg,
  getPushedSignalIds,
  onPushCoverageChange,
  subscribeHealth,
  subscribeSignals,
  useStreamStatus,
} from '../lib/liveStream'
import { CommissionResult, runConnectionTest } from '../lib/commissioning'
import { normalizeQuality } from '../lib/format'
import { endpointWithScheme } from '../lib/protocols'

const EMPTY_PLANT: PlantScope = {
  id: '',
  name: 'No plant yet',
  code: '—',
  zone: 'Build the factory model first',
  status: 'maintenance',
  assetsCount: 0,
}

/** Server cap for one `/observations/latest` request. */
const LATEST_CHUNK = 200
/** Metadata (lists) refresh period while the push stream is open / closed. */
const META_REFRESH_OPEN_MS = 30000
const META_REFRESH_CLOSED_MS = 10000
/** Latest-value polling period for signals that are not pushed. */
const POLL_STREAM_DOWN_MS = 1500
const POLL_PARTIAL_MS = 2000
/** Coalescing window for applying live updates to React state. */
const LIVE_FLUSH_MS = 200

export interface AcquisitionField {
  name: string
  address: string
  dataType: string
  unit: string
}

export interface AcquisitionDraft {
  protocol: 'modbus' | 'opcua' | 'mqtt' | 'http'
  name: string
  host: string
  port: string
  /** Modbus unit id, MQTT topic filter, or HTTP path depending on protocol */
  extra: string
  intervalMs: number
  resourceId: string
  fields: AcquisitionField[]
  mqttQos?: number
  mqttClientId?: string
  mqttVersion?: string
  mqttKeepalive?: number
  mqttTls?: boolean
  mqttAnonymous?: boolean
  httpMethod?: string
}

interface PreparedConnection {
  connectionId: string
  jobId: string
  edgeId: string
}

/** Status of the shared metadata load (resources, connections, signals, edges). */
export type LoadState = 'loading' | 'ready' | 'error'

interface AppContextType {
  /**
   * 'loading' until the first successful load; 'error' when no load has succeeded yet (pages must show
   * an error with Retry, never an empty state); 'ready' once data was loaded at least once. A later
   * background failure keeps 'ready' (data stays visible) and only sets `loadError`.
   */
  loadState: LoadState
  loadError: string | null
  /** Re-run the metadata load (Retry button). */
  retryLoad: () => Promise<void>
  revertToZero: (confirm: string) => Promise<void>
  refresh: () => Promise<void>
  isDemoMode: boolean
  demoScenario: 'healthy'
  setDemoScenario: (value: import('../types').DemoScenario) => void
  availablePlants: PlantScope[]
  currentPlant: PlantScope
  setCurrentPlant: (plant: PlantScope) => void
  resources: ResourceNode[]
  connections: ConnectionItem[]
  edges: EdgeItem[]
  signals: SignalItem[]
  layoutNodes: LayoutMachineNode[]
  outputGroups: OutputGroup[]
  activities: ActivityEvent[]
  diagnostics: DiagnosticItem[]
  scopedResources: ResourceNode[]
  scopedConnections: ConnectionItem[]
  scopedSignals: SignalItem[]
  selectedResourceId: string
  setSelectedResourceId: (id: string) => void
  selectedConnectionId: string
  setSelectedConnectionId: (id: string) => void
  selectedSignalId: string
  setSelectedSignalId: (id: string) => void
  isStreaming: boolean
  setIsStreaming: (streaming: boolean) => void
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
  searchQuery: string
  setSearchQuery: (query: string) => void
  collectorLabel: string
  resetToReference: () => void
  addResource: (resource: Partial<ResourceNode>) => Promise<{ edgeCreated?: boolean; edgeId?: string; edgeName?: string }>
  moveResource: (resourceId: string, newParentId: string) => Promise<{ success: boolean; error?: string }>
  archiveResource: (resourceId: string) => Promise<{ success: boolean; error?: string }>
  updateLayoutNode: (id: string, updates: Partial<LayoutMachineNode>) => void
  /** Real connectivity test (REACH + AUTH) run by the Edge collector. */
  testConnection: (id: string) => Promise<{ success: boolean; latency: number; result: CommissionResult }>
  runDeterministicConnectionTest: (id: string, scenario?: string) => Promise<{ overallStatus: TestExecutionState; latency: number; steps: TestStepResult[] }>
  prepareAcquisition: (draft: AcquisitionDraft) => Promise<PreparedConnection>
  commissionAcquisition: (connectionId: string) => Promise<{ passed: boolean; stages: Array<{ name: string; status: string; latency?: number }>; errorCode?: string }>
  activateAcquisition: (prepared: PreparedConnection, draft: AcquisitionDraft) => Promise<void>
  deleteConnection: (connectionId: string) => Promise<void>
  issueEnrollmentToken: (edgeId: string) => Promise<{ enrollment_token: string; expires_at: string; expires_in_seconds: number; edge_id: string }>
  queueApplianceEnroll: (edgeId: string) => Promise<{ status: string }>
  addSignal: (signal: Partial<SignalItem>) => void
  bulkDeleteSignals: (signalIds: string[]) => { count: number; undo: () => void }
  bulkAssignOutputGroup: (signalIds: string[], groupId: string) => void
  saveCalculatedSignal: (signal: Partial<SignalItem>) => void
  saveOutputGroup: (group: OutputGroup) => void
}

const AppContext = createContext<AppContextType | undefined>(undefined)

function text(value: unknown): string {
  return value == null ? '' : String(value)
}

function codeFrom(name: string): string {
  const raw = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (!raw) return `R${Date.now().toString(36)}`.slice(0, 64)
  return /^[A-Za-z0-9]/.test(raw) ? raw : `R-${raw}`.slice(0, 64)
}

export function protocolOf(value: string): ProtocolType {
  const v = value.toLowerCase()
  if (v.includes('modbus')) return 'modbus'
  if (v.includes('opc')) return 'opcua'
  if (v.includes('mqtt')) return 'mqtt'
  if (v.includes('websocket') || v === 'ws' || v === 'wss') return 'websocket'
  return 'http'
}

function storedProtocol(value: AcquisitionDraft['protocol']): string {
  if (value === 'modbus') return 'modbus_tcp'
  return value
}

function signalType(value: string): SignalItem['dataType'] {
  const name = value.toLowerCase()
  if (name.includes('bool')) return 'boolean'
  if (name.includes('int')) return 'integer'
  if (name.includes('string')) return 'string'
  return 'analog'
}

function descendants(all: ResourceNode[], rootId: string): Set<string> {
  const children = new Map<string, string[]>()
  all.forEach((item) => {
    if (!item.parentId) return
    const list = children.get(item.parentId) || []
    list.push(item.id)
    children.set(item.parentId, list)
  })
  const keep = new Set<string>()
  const walk = (id: string) => {
    keep.add(id)
    ;(children.get(id) || []).forEach(walk)
  }
  walk(rootId)
  return keep
}

function scopeToPlant(all: ResourceNode[], plantId: string): ResourceNode[] {
  if (!plantId) return all
  const byId = new Map(all.map((item) => [item.id, item]))
  const keep = descendants(all, plantId)
  let cursor = byId.get(plantId)
  while (cursor?.parentId) {
    keep.add(cursor.parentId)
    cursor = byId.get(cursor.parentId)
  }
  return all.filter((item) => keep.has(item.id))
}

/** Derive the connection display state from lifecycle status and the server-computed effective health. */
export function connectionDisplayState(input: {
  lifecycleStatus?: string
  effectiveHealth?: string
  health?: string
  signalsCount?: number
}): ConnectionDisplayState {
  const lifecycle = text(input.lifecycleStatus).toUpperCase()
  if (lifecycle === 'PAUSED') return 'paused'
  const eff = text(input.effectiveHealth || input.health).toUpperCase()
  if (eff === 'PAUSED') return 'paused'
  if (eff === 'IDLE' || (input.signalsCount ?? 0) === 0) return 'idle'
  if (eff === 'HEALTHY' || eff === 'ONLINE' || eff === 'UP' || eff === 'RATE_LIMITED') return 'connected'
  if (eff === 'DEGRADED' || eff === 'OFFLINE' || eff === 'DOWN' || eff === 'AUTH_FAILED' || eff === 'ERROR') return 'degraded'
  return 'unknown'
}

function addressSummary(kind: string, address: Record<string, unknown> | undefined): string {
  if (!address) return ''
  if (kind.startsWith('modbus') || address.offset !== undefined) {
    const unit = address.unit_id !== undefined ? `unit ${text(address.unit_id)} · ` : ''
    return `${unit}${text(address.register_area || 'holding')} ${text(address.offset)} (${text(address.native_type || 'uint16')})`
  }
  if (address.node_id) return text(address.node_id)
  const parts = [address.topic, address.path, address.jsonpath].map(text).filter(Boolean)
  return parts.join(' · ')
}

function mapConnection(row: Record<string, unknown>): ConnectionItem {
  const signalsCount = Number(row.signal_count ?? 0) || 0
  const lifecycleStatus = text(row.status).toUpperCase()
  const health = text(row.health).toUpperCase()
  const effectiveHealth = text(row.effective_health || row.health).toUpperCase()
  const config = (row.config_json as Record<string, unknown>) || (row.config as Record<string, unknown>) || {}
  const protocol = protocolOf(text(row.protocol))
  return {
    id: text(row.id),
    name: text(row.name),
    protocol,
    endpoint: endpointWithScheme(protocol, text(row.endpoint_redacted)),
    status: connectionDisplayState({ lifecycleStatus, effectiveHealth, health, signalsCount }),
    lifecycleStatus,
    health,
    effectiveHealth,
    version: Number(row.version || 1),
    lastError: text(row.last_error),
    plantId: text(row.site_id),
    siteId: text(row.site_id),
    edgeId: text(row.edge_id),
    edgeName: text(row.edge_name) || undefined,
    latencyMs: 0,
    lastConnected: text(row.last_success_at),
    lastSuccessAt: text(row.last_success_at),
    signalsCount,
    messagesPerMin: Number(row.messages_per_min ?? 0) || 0,
    throughputPerSec: (Number(row.messages_per_min ?? 0) || 0) / 60,
    errorRate: 0,
    secretConfigured: Boolean(row.secret_configured),
    config,
  }
}

interface LiveState {
  value: unknown
  quality: string
  reasonCode: string
  receivedTime: string
  sourceTime: string
}

function timeOf(iso: string): number {
  if (!iso) return 0
  const ts = Date.parse(iso)
  return Number.isNaN(ts) ? 0 : ts
}

function liveFromRow(row: Record<string, unknown>): LiveState {
  const value = row.value !== undefined ? row.value : (row.value_json as { v?: unknown } | undefined)?.v
  return {
    value: value === undefined ? null : value,
    quality: normalizeQuality(row.effective_status ?? row.quality),
    reasonCode: text(row.reason_code),
    receivedTime: text(row.received_time || row.event_time),
    sourceTime: text(row.source_time),
  }
}

interface SignalMeta extends SignalItem {
  enabled: boolean
}

function mapSignal(row: Record<string, unknown>, connectionName: Map<string, string>, listIndex = 0): SignalMeta {
  const dataType = text(row.data_type)
  const addressJson = (row.address_json as Record<string, unknown>) || undefined
  const addressKind = text(row.address_kind)
  const connectionId = text(row.connection_id)
  const summary = addressSummary(addressKind, addressJson)
  return {
    id: text(row.id),
    key: text(row.key),
    name: text(row.key),
    displayName: text(row.display_name || row.key),
    tag: text(row.key),
    data_type: dataType,
    connectionId,
    sourceConnectionId: connectionId,
    sourceConnectionName: text(row.connection_name) || connectionName.get(connectionId) || '',
    connectionProtocol: text(row.connection_protocol),
    edgeName: text(row.edge_name) || undefined,
    resourceId: text(row.resource_id),
    resourcePath: text(row.resource_name || row.resource_code),
    dataType: dataType === 'boolean' || dataType === 'bool' ? 'boolean' : signalType(dataType),
    unit: text(row.unit),
    enabled: row.enabled !== false,
    version: Number(row.version || 1),
    addressKind,
    addressJson,
    sourceOrdinal: Number(row.source_ordinal ?? 0) || 0,
    listIndex,
    bindingAddress: summary || undefined,
    topic: text(addressJson?.topic || addressJson?.path || addressJson?.node_id) || undefined,
    address: addressJson?.jsonpath ? text(addressJson.jsonpath) : summary || undefined,
    expectedIntervalMs: row.expected_interval_ms != null ? Number(row.expected_interval_ms) : undefined,
    sampleIntervalMs: Number(row.expected_interval_ms || 1000),
    currentValue: '—',
    value: null,
    quality: 'NO_DATA',
    lastUpdated: '',
  }
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [allResources, setAllResources] = useState<ResourceNode[]>([])
  const [connections, setConnections] = useState<ConnectionItem[]>([])
  const [edges, setEdges] = useState<EdgeItem[]>([])
  const [signalMeta, setSignalMeta] = useState<SignalMeta[]>([])
  const [layoutNodes, setLayoutNodes] = useState<LayoutMachineNode[]>([])
  const [outputGroups, setOutputGroups] = useState<OutputGroup[]>([])
  const [activities, setActivities] = useState<ActivityEvent[]>([])
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([])
  const [plants, setPlants] = useState<PlantScope[]>([])
  const [currentPlant, setCurrentPlant] = useState<PlantScope>(EMPTY_PLANT)
  const [selectedResourceId, setSelectedResourceId] = useState('')
  const [selectedConnectionId, setSelectedConnectionId] = useState('')
  const [selectedSignalId, setSelectedSignalId] = useState('')
  const [isStreaming, setIsStreaming] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [collectorLabel, setCollectorLabel] = useState('Collector: not enrolled')
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadedOnceRef = useRef(false)
  const streamStatus = useStreamStatus()

  // Live values live outside the metadata so a metadata refresh never wipes them.
  const liveRef = useRef<Map<string, LiveState>>(new Map())
  const [liveTick, setLiveTick] = useState(0)
  // Re-evaluates client-side staleness between server reconciliations.
  const [clockTick, setClockTick] = useState(0)
  const flushTimer = useRef<number | null>(null)
  const signalIdsRef = useRef<string[]>([])

  const scheduleLiveFlush = useCallback(() => {
    if (flushTimer.current !== null) return
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null
      setLiveTick((tick) => tick + 1)
    }, LIVE_FLUSH_MS)
  }, [])

  useEffect(() => () => {
    if (flushTimer.current !== null) window.clearTimeout(flushTimer.current)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 5000)
    return () => window.clearInterval(timer)
  }, [])

  /** Merge one live state; older samples (by received_time) never overwrite newer ones. */
  const applyLive = useCallback((signalId: string, next: LiveState): boolean => {
    const current = liveRef.current.get(signalId)
    if (current) {
      const curTs = timeOf(current.receivedTime)
      const nextTs = timeOf(next.receivedTime)
      if (curTs && nextTs && nextTs < curTs) return false
      if (
        curTs === nextTs &&
        current.value === next.value &&
        current.quality === next.quality &&
        current.sourceTime === next.sourceTime &&
        current.reasonCode === next.reasonCode
      ) {
        return false
      }
    }
    liveRef.current.set(signalId, next)
    return true
  }, [])

  const fetchLatest = useCallback(async (ids: string[]) => {
    const unique = Array.from(new Set(ids.filter(Boolean)))
    if (!unique.length) return
    const chunks: string[][] = []
    for (let i = 0; i < unique.length; i += LATEST_CHUNK) chunks.push(unique.slice(i, i + LATEST_CHUNK))
    const pages = await Promise.all(
      chunks.map((chunk) =>
        api<{ items: Array<Record<string, unknown>> }>(`/api/v1/observations/latest?signal_ids=${chunk.join(',')}`).catch((error) => {
          console.warn('Latest values request failed', error)
          return { items: [] as Array<Record<string, unknown>> }
        }),
      ),
    )
    let changed = false
    for (const page of pages) {
      for (const row of page.items || []) {
        if (applyLive(text(row.signal_id), liveFromRow(row))) changed = true
      }
    }
    if (changed) scheduleLiveFlush()
  }, [applyLive, scheduleLiveFlush])

  const resources = useMemo(
    () => scopeToPlant(allResources, currentPlant.id),
    [allResources, currentPlant.id],
  )
  const resourceIds = useMemo(() => new Set(resources.map((item) => item.id)), [resources])
  const scopedConnections = useMemo(() => {
    if (!currentPlant.id) return connections
    const plant = allResources.find((item) => item.id === currentPlant.id)
    const siteId = plant?.attributes?.siteId
    if (!siteId) return connections
    return connections.filter((item) => !item.plantId || item.plantId === siteId)
  }, [allResources, connections, currentPlant.id])

  const signals = useMemo<SignalItem[]>(() => {
    void liveTick
    void clockTick
    const now = Date.now()
    return signalMeta.map((meta) => {
      const live = liveRef.current.get(meta.id)
      if (!meta.enabled) {
        return {
          ...meta,
          quality: 'DISABLED',
          value: live?.value === undefined ? null : (live.value as SignalItem['value']),
          currentValue: live?.value == null ? '—' : (live.value as SignalItem['currentValue']),
          lastUpdated: live?.receivedTime || '',
          receivedTime: live?.receivedTime || '',
          sourceTime: live?.sourceTime || '',
        }
      }
      if (!live) return meta
      const value = live.value as SignalItem['value']
      // Same rule as the Center (max(2 x interval, 12 s) since received_time), so a source that stopped
      // pushing is shown Stale before the next server reconciliation.
      const staleAfter = Math.max(2 * (meta.expectedIntervalMs || 1000), 12000)
      const receivedTs = timeOf(live.receivedTime)
      const quality = live.quality === 'GOOD' && receivedTs && now - receivedTs > staleAfter ? 'STALE' : live.quality
      return {
        ...meta,
        value: value == null ? null : value,
        currentValue: value == null ? '—' : value,
        quality,
        reasonCode: live.reasonCode || undefined,
        qualityReason: live.reasonCode || undefined,
        lastUpdated: live.receivedTime,
        receivedTime: live.receivedTime,
        sourceTime: live.sourceTime,
      }
    })
  }, [signalMeta, liveTick, clockTick])

  const scopedSignals = useMemo(
    () => signals.filter((item) => !currentPlant.id || resourceIds.has(item.resourceId)),
    [signals, currentPlant.id, resourceIds],
  )

  const loadMetadata = useCallback(async () => {
    type Page = { items: Array<Record<string, unknown>> }
    // Secondary lists must not block the core load: on failure they keep their previous content.
    const optional = (path: string) =>
      api<Page>(path).catch((error) => {
        console.warn(`Optional list ${path} could not be loaded`, error)
        return null
      })
    const [resourcePage, connectionPage, signalPage, groupPage, auditPage, edgePage] = await Promise.all([
      api<Page>('/api/v1/resources?view=all&limit=200'),
      api<Page>('/api/v1/connections'),
      api<Page>('/api/v1/signals?limit=1000'),
      optional('/api/v1/output-groups'),
      optional('/api/v1/audit-events?limit=50'),
      api<Page>('/api/v1/edges'),
    ])
    const mappedResources: ResourceNode[] = (resourcePage.items || []).map((row) => ({
      id: text(row.id),
      name: text(row.name),
      type: text(row.type_key) as ResourceNode['type'],
      code: text(row.code),
      status: 'idle',
      parentId: row.parent_id ? text(row.parent_id) : undefined,
      attributes: {
        siteId: text(row.site_id),
        version: text(row.version || 1),
      },
    }))
    const plantRows = mappedResources.filter((item) => item.type === 'plant')
    const nextPlants = plantRows.map((item) => ({
      id: item.id,
      name: item.name,
      code: item.code,
      zone: mappedResources.find((parent) => parent.id === item.parentId)?.name || 'Site',
      status: 'operational' as const,
      assetsCount: descendants(mappedResources, item.id).size,
    }))
    setPlants(nextPlants)
    setCurrentPlant((current) => nextPlants.find((item) => item.id === current.id) || nextPlants[0] || EMPTY_PLANT)
    setAllResources(mappedResources)

    const connectionRows = connectionPage.items || []
    const connectionName = new Map(connectionRows.map((row) => [text(row.id), text(row.name)]))
    setConnections(connectionRows.map(mapConnection))

    const metas = (signalPage.items || []).map((row, index) => mapSignal(row, connectionName, index))
    const ids = metas.map((item) => item.id).filter(Boolean)
    signalIdsRef.current = ids
    // Forget live values of signals that no longer exist; keep everything else untouched.
    const keep = new Set(ids)
    for (const id of Array.from(liveRef.current.keys())) {
      if (!keep.has(id)) liveRef.current.delete(id)
    }
    setSignalMeta(metas)
    // Reconcile latest values for ALL signals (chunked), merged by received_time.
    await fetchLatest(ids)

    setLayoutNodes([])
    if (groupPage) setOutputGroups(
      (groupPage.items || []).map((row) => ({
        id: text(row.id),
        name: text(row.display_name || row.key),
        topicTemplate: text(row.topic_template),
        enabled: true,
        publishIntervalMs: 1000,
        assignedSignals: [],
        lastPublished: '',
        samplePayload: '',
      })),
    )
    if (auditPage) setActivities(
      (auditPage.items || []).map((row) => ({
        id: text(row.id),
        timestamp: text(row.occurred_at),
        severity: 'info',
        source: text(row.entity_type || 'Center'),
        eventType: text(row.event_type),
        message: `${text(row.event_type)} ${text(row.entity_type)}`.trim(),
        details: (row.after_json as Record<string, unknown>) || {},
      })),
    )
    const edgeItems = edgePage.items || []
    const mappedEdges: EdgeItem[] = edgeItems.map((row) => ({
      id: text(row.id),
      name: text(row.name),
      siteId: text(row.site_id),
      site_id: text(row.site_id),
      enrollmentStatus: text(row.enrollment_status),
      health: text(row.health),
      desiredRevision: Number(row.desired_revision || 0),
      activeRevision: Number(row.active_revision || 0),
      lastHeartbeat: text(row.last_heartbeat),
      softwareVersion: text(row.software_version) || undefined,
    }))
    setEdges(mappedEdges)
    const enrolled = mappedEdges.filter((row) => row.enrollmentStatus === 'ENROLLED')
    const siteCount = mappedResources.filter((item) => item.type === 'site').length
    if (enrolled.length) {
      setCollectorLabel(`Collector: ${enrolled[0].health || 'ENROLLED'}`)
    } else if (mappedEdges.length) {
      setCollectorLabel(`Collector: not enrolled (${mappedEdges[0].name || 'Edge'})`)
    } else if (siteCount === 0 && mappedEdges.length === 0) {
      setCollectorLabel('Collector: waiting for a site')
    } else {
      setCollectorLabel('Collector: not enrolled')
    }
    setDiagnostics(
      connectionRows
        .filter((row) => text(row.effective_health || row.health).toUpperCase() === 'DEGRADED' || text(row.last_error))
        .map((row) => ({
          id: text(row.id),
          connectionId: text(row.id),
          connectionName: text(row.name),
          protocol: protocolOf(text(row.protocol)),
          status: text(row.effective_health || row.health).toUpperCase() === 'DEGRADED' ? 'degraded' : 'critical',
          uptimeSeconds: 0,
          messagesReceived: Number(row.messages_per_min ?? 0) || 0,
          messagesDropped: 0,
          lastError: text(row.last_error),
        })),
    )
  }, [fetchLatest])

  const refresh = useCallback(async () => {
    try {
      await loadMetadata()
      loadedOnceRef.current = true
      setLoadState('ready')
      setLoadError(null)
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'The server did not answer.'
      setLoadError(message)
      if (!loadedOnceRef.current) setLoadState('error')
      throw error
    }
  }, [loadMetadata])

  const retryLoad = useCallback(async () => {
    if (!loadedOnceRef.current) setLoadState('loading')
    try {
      await refresh()
    } catch (error) {
      console.warn('Retry of the metadata load failed', error)
    }
  }, [refresh])

  // Initial load.
  useEffect(() => {
    void refresh().catch((error) => console.warn('Initial refresh failed', error))
  }, [refresh])

  // Metadata refresh: 30 s while push is available, 10 s otherwise. Never wipes live values.
  useEffect(() => {
    if (!isStreaming) return
    const period = streamStatus === 'open' ? META_REFRESH_OPEN_MS : META_REFRESH_CLOSED_MS
    const timer = window.setInterval(() => {
      void refresh().catch((error) => console.warn('Metadata refresh failed', error))
    }, period)
    return () => window.clearInterval(timer)
  }, [isStreaming, refresh, streamStatus])

  // Push: subscribe to latest values of every known signal.
  const signalIdsKey = useMemo(() => signalMeta.map((item) => item.id).sort().join(','), [signalMeta])
  useEffect(() => {
    if (!isStreaming || !signalIdsKey) return
    const ids = signalIdsKey.split(',')
    const onLatest = (msg: LatestMsg) => {
      const id = text(msg.signal_id)
      const current = liveRef.current.get(id)
      const next: LiveState = {
        value: msg.value === undefined ? null : msg.value,
        quality: normalizeQuality(msg.effective_status ?? msg.quality),
        reasonCode: text(msg.reason_code),
        // Older servers do not send received_time: treat the push as "now" so it is not discarded.
        receivedTime: text(msg.received_time) || new Date().toISOString(),
        sourceTime: msg.source_time !== undefined ? text(msg.source_time) : current?.sourceTime || '',
      }
      if (applyLive(id, next)) scheduleLiveFlush()
    }
    return subscribeSignals(ids, onLatest)
  }, [applyLive, isStreaming, scheduleLiveFlush, signalIdsKey])

  // Push: connection / edge health.
  useEffect(() => {
    const onHealth = (msg: HealthMsg) => {
      const id = text(msg.id)
      if (msg.entity === 'connection') {
        setConnections((prev) =>
          prev.map((conn) => {
            if (conn.id !== id) return conn
            const health = msg.health != null ? text(msg.health).toUpperCase() : conn.health
            const effectiveHealth = msg.effective_health != null ? text(msg.effective_health).toUpperCase() : health
            const next: ConnectionItem = {
              ...conn,
              health,
              effectiveHealth,
              lastError: msg.last_error !== undefined ? text(msg.last_error) : conn.lastError,
              lastSuccessAt: msg.last_success_at !== undefined ? text(msg.last_success_at) : conn.lastSuccessAt,
              lastConnected: msg.last_success_at !== undefined ? text(msg.last_success_at) : conn.lastConnected,
            }
            next.status = connectionDisplayState(next)
            return next
          }),
        )
      } else if (msg.entity === 'edge') {
        setEdges((prev) =>
          prev.map((edge) =>
            edge.id === id
              ? {
                  ...edge,
                  health: text(msg.effective_health || msg.health) || edge.health,
                  lastHeartbeat: msg.last_success_at ? text(msg.last_success_at) : edge.lastHeartbeat,
                }
              : edge,
          ),
        )
      }
    }
    return subscribeHealth(onHealth)
  }, [])

  // Polling fallback: self-scheduled, one request wave in flight at a time.
  // Stream down -> poll every signal; stream up -> poll only ids the server does not push.
  useEffect(() => {
    if (!isStreaming) return
    let active = true
    let timer: number | null = null
    let inFlight = false
    const schedule = (delay: number) => {
      if (!active) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(tick, delay)
    }
    const tick = async () => {
      timer = null
      if (!active) return
      if (inFlight) {
        schedule(POLL_PARTIAL_MS)
        return
      }
      const ids = signalIdsRef.current
      const pushed = getPushedSignalIds()
      const pending = ids.filter((id) => !pushed.has(id))
      if (!pending.length) {
        schedule(POLL_PARTIAL_MS)
        return
      }
      inFlight = true
      try {
        await fetchLatest(pending)
      } finally {
        inFlight = false
      }
      schedule(pushed.size ? POLL_PARTIAL_MS : POLL_STREAM_DOWN_MS)
    }
    schedule(POLL_STREAM_DOWN_MS)
    const offCoverage = onPushCoverageChange(() => {
      if (!inFlight && timer === null) schedule(0)
    })
    return () => {
      active = false
      offCoverage()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [fetchLatest, isStreaming])

  const revertToZero = async (confirm: string) => {
    await api('/api/v1/admin/revert-to-zero', {
      method: 'POST',
      body: JSON.stringify({ confirm }),
    })
    setAllResources([])
    setConnections([])
    setEdges([])
    setSignalMeta([])
    liveRef.current.clear()
    setLayoutNodes([])
    setOutputGroups([])
    setActivities([])
    setDiagnostics([])
    setPlants([])
    setCurrentPlant(EMPTY_PLANT)
    window.location.assign('/register')
  }

  const addResource = async (resource: Partial<ResourceNode>) => {
    const typeKey = (resource.type || 'machine').toLowerCase()
    const name = resource.name || 'Resource'
    const code = codeFrom(resource.code || name)
    const parent = allResources.find((item) => item.id === resource.parentId)
    let siteId = parent?.attributes?.siteId || ''

    if (typeKey === 'site') {
      const site = await api<{ id: string }>('/api/v1/sites', {
        method: 'POST',
        body: JSON.stringify({ code, name, timezone: 'Asia/Ho_Chi_Minh' }),
      })
      siteId = site.id
    }
    const created = await api<{ id: string }>('/api/v1/resources', {
      method: 'POST',
      body: JSON.stringify({
        type_key: typeKey,
        code,
        name,
        site_id: typeKey === 'enterprise' ? null : siteId,
        parent_id: parent?.id || null,
        relation_code: 'CONTAINS',
        description: resource.description || '',
        properties: resource.attributes || {},
      }),
    })
    // Site creation does not auto-create fake edge (Review 4 S5.1)
    await refresh()
    setSelectedResourceId(created.id)
    if (typeKey === 'plant') {
      setCurrentPlant({
        id: created.id,
        name,
        code,
        zone: parent?.name || 'Site',
        status: 'operational',
        assetsCount: 1,
      })
    }
    return {}
  }

  const moveResource = async (resourceId: string, newParentId: string) => {
    const current = allResources.find((item) => item.id === resourceId)
    if (!current) return { success: false, error: 'Resource was not found.' }
    if (resourceId === newParentId) return { success: false, error: 'A resource cannot contain itself.' }
    try {
      await api(`/api/v1/resources/${resourceId}/move`, {
        method: 'POST',
        body: JSON.stringify({
          version: Number(current.attributes?.version || 1),
          parent_id: newParentId,
        }),
      })
      await refresh()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Move failed' }
    }
  }

  const archiveResource = async (resourceId: string) => {
    try {
      await api(`/api/v1/resources/${resourceId}/archive`, { method: 'POST' })
      await refresh()
      if (selectedResourceId === resourceId) {
        setSelectedResourceId('')
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Archive failed' }
    }
  }

  const updateLayoutNode = (_id: string, _updates: Partial<LayoutMachineNode>) => undefined

  const connectionConfig = (draft: AcquisitionDraft): Record<string, unknown> => {
    const port = Number(draft.port)
    const interval_ms = draft.intervalMs
    if (draft.protocol === 'modbus') {
      return { host: draft.host, port, unit_id: Number(draft.extra || 1), timeout_ms: 3000, retries: 1, interval_ms }
    }
    if (draft.protocol === 'opcua') {
      const endpoint = draft.host.startsWith('opc.tcp://') ? draft.host : `opc.tcp://${draft.host}:${port}`
      return { endpoint, security_mode: 'None', security_policy: 'None', anonymous: true, interval_ms }
    }
    if (draft.protocol === 'mqtt') {
      const topic = draft.extra.trim()
      return {
        host: draft.host,
        port,
        anonymous: draft.mqttAnonymous !== false,
        topics: topic ? [topic] : [],
        qos: draft.mqttQos ?? 1,
        protocol_version: draft.mqttVersion || '3.1.1',
        client_id: draft.mqttClientId || undefined,
        keepalive: draft.mqttKeepalive ?? 60,
        clean_session: true,
        tls: Boolean(draft.mqttTls),
        interval_ms,
      }
    }
    const url = draft.host.startsWith('http') ? new URL(draft.host) : null
    return {
      base_url: url ? `${url.protocol}//${url.host}` : `http://${draft.host}:${port}`,
      path: url?.pathname || draft.extra || '/',
      auth: 'none',
      timeout_ms: 5000,
      interval_ms,
    }
  }

  const ensureEdge = async (siteId: string) => {
    const edgeRows = await api<{ items: Array<Record<string, unknown>> }>('/api/v1/edges')
    const existing = (edgeRows.items || []).find((item) => text(item.site_id) === siteId)
    if (existing) return text(existing.id)
    const created = await api<{ id: string }>('/api/v1/edges', {
      method: 'POST',
      body: JSON.stringify({ site_id: siteId, name: 'Appliance edge' }),
    })
    await api(`/api/v1/edges/${created.id}/appliance`, { method: 'POST' })
    return created.id
  }

  const prepareAcquisition = async (draft: AcquisitionDraft): Promise<PreparedConnection> => {
    const resource = allResources.find((item) => item.id === draft.resourceId)
    const siteId = resource?.attributes?.siteId
    if (!resource || !siteId) throw new Error('Choose a machine that belongs to a site.')
    if (draft.protocol === 'mqtt' && !draft.extra.trim()) throw new Error('MQTT needs one topic.')
    if (!draft.host.trim()) throw new Error('The endpoint is required.')
    const edgeId = await ensureEdge(siteId)
    const created = await api<{ id: string; jobs?: Array<{ id: string }> }>('/api/v1/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: draft.name || `${draft.protocol} ${draft.host}`,
        site_id: siteId,
        edge_id: edgeId,
        protocol: storedProtocol(draft.protocol),
        config: connectionConfig(draft),
      }),
    })
    const jobId = created.jobs?.[0]?.id
    if (!jobId) throw new Error('The collector did not create an acquisition job.')
    await refresh()
    return { connectionId: created.id, jobId, edgeId }
  }

  const commissionAcquisition = async (connectionId: string) => {
    const result = await runConnectionTest(connectionId, { mode: 'FULL' })
    return {
      passed: result.passed,
      errorCode: result.errorCode,
      stages: result.stages.map((stage) => ({
        name: stage.stage,
        status: stage.status,
        latency: stage.duration_ms ?? undefined,
      })),
    }
  }

  const activateAcquisition = async (prepared: PreparedConnection, draft: AcquisitionDraft) => {
    const native = (value: string) => {
      const name = value.toLowerCase()
      if (name.includes('float')) return 'float32'
      if (name.includes('bool')) return 'bool'
      if (name.includes('int')) return 'uint16'
      return 'float32'
    }
    const canonical = (value: string) => {
      const kind = native(value)
      if (kind === 'bool') return 'bool'
      if (kind === 'uint16') return 'int64'
      return 'float64'
    }
    await api('/api/v1/signals/bulk', {
      method: 'POST',
      body: JSON.stringify({
        resource_id: draft.resourceId,
        atomic: true,
        items: draft.fields.map((field) => ({
          key: codeFrom(field.name),
          name: field.name,
          data_type: canonical(field.dataType),
          unit: field.unit,
          expected_interval_ms: draft.intervalMs,
          source_field: {
            acquisition_job_id: prepared.jobId,
            address_kind: draft.protocol === 'modbus' ? 'modbus_register' : draft.protocol,
            address:
              draft.protocol === 'modbus'
                ? { offset: Number(field.address), register_area: 'holding', native_type: native(field.dataType), word_order: 'big' }
                : draft.protocol === 'opcua'
                  ? { node_id: field.address }
                  : draft.protocol === 'mqtt'
                    ? { topic: draft.extra, jsonpath: field.address, qos: 1 }
                    : { path: connectionConfig(draft).path, jsonpath: field.address },
          },
        })),
      }),
    })
    await api('/api/v1/config-releases/publish', {
      method: 'POST',
      body: JSON.stringify({ edge_id: prepared.edgeId }),
    })
    await refresh()
  }

  const testConnection = async (id: string) => {
    const result = await runConnectionTest(id, { mode: 'CONNECTIVITY' })
    const latency = result.stages.reduce((sum, stage) => sum + (Number(stage.duration_ms) || 0), 0)
    return { success: result.passed, latency, result }
  }

  const deleteConnection = async (connectionId: string) => {
    await api(`/api/v1/connections/${connectionId}`, { method: 'DELETE' })
    await refresh()
  }

  const issueEnrollmentToken = async (edgeId: string) => {
    const issued = await api<{
      enrollment_token: string
      expires_at: string
      expires_in_seconds: number
      edge_id: string
    }>(`/api/v1/edges/${edgeId}/enrollment-token`, { method: 'POST' })
    return issued
  }

  const queueApplianceEnroll = async (edgeId: string) => {
    const result = await api<{ status: string }>(`/api/v1/edges/${edgeId}/appliance`, { method: 'POST' })
    await refresh()
    return result
  }

  const value: AppContextType = {
    loadState,
    loadError,
    retryLoad,
    revertToZero,
    refresh,
    isDemoMode: false,
    demoScenario: 'healthy',
    setDemoScenario: () => undefined,
    availablePlants: plants.length ? plants : [EMPTY_PLANT],
    currentPlant,
    setCurrentPlant,
    resources,
    connections: scopedConnections,
    edges,
    signals: scopedSignals,
    layoutNodes,
    outputGroups,
    activities,
    diagnostics,
    scopedResources: resources,
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
    collectorLabel,
    resetToReference: () => undefined,
    addResource,
    moveResource,
    archiveResource,
    updateLayoutNode,
    testConnection,
    runDeterministicConnectionTest: async (id, _scenario) => {
      const outcome = await testConnection(id)
      return { overallStatus: outcome.success ? 'PASS' : 'FAIL', latency: outcome.latency, steps: [] }
    },
    prepareAcquisition,
    commissionAcquisition,
    activateAcquisition,
    deleteConnection,
    issueEnrollmentToken,
    queueApplianceEnroll,
    addSignal: () => undefined,
    bulkDeleteSignals: () => ({
      count: 0,
      undo: () => undefined,
    }),
    bulkAssignOutputGroup: () => undefined,
    saveCalculatedSignal: () => undefined,
    saveOutputGroup: (group) => {
      void api('/api/v1/output-groups', {
        method: 'POST',
        body: JSON.stringify({
          resource_id: resources[0]?.id,
          key: codeFrom(group.name),
          display_name: group.name,
          topic_template: group.topicTemplate,
          members: [],
          projection_policy: { mode: 'rich', missing: 'null' },
        }),
      }).then(() => refresh())
    },
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextType {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp must be used inside AppProvider')
  return context
}
