import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ApiError, api } from '../api/client'
import {
  ActivityEvent,
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

const EMPTY_PLANT: PlantScope = {
  id: '',
  name: 'No plant yet',
  code: '—',
  zone: 'Build the factory model first',
  status: 'maintenance',
  assetsCount: 0,
}

export interface AcquisitionField {
  name: string
  address: string
  dataType: string
  unit: string
  /** Per-field MQTT topic filter (CR-Q01). Falls back to draft.extra when empty. */
  topic?: string
  qos?: number
  /** Modbus register area: holding | input | coil | discrete */
  registerArea?: string
  wordOrder?: 'big' | 'little'
  scale?: number
  offset?: number
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
  mqttTlsVerify?: boolean
  mqttTlsCa?: string
  mqttTlsClientCert?: string
  mqttAnonymous?: boolean
  mqttUsername?: string
  mqttPassword?: string
  /** JSONPath for event time; default $.source_timestamp (CR-Q04). */
  timestampJsonpath?: string
  modbusTimeoutMs?: number
  modbusRetries?: number
  opcSecurityMode?: string
  opcSecurityPolicy?: string
  opcUsername?: string
  opcPassword?: string
  opcTrustAll?: boolean
  httpMethod?: string
  httpAuth?: string
  httpHeaders?: string
  httpTimeoutMs?: number
  httpUsername?: string
  httpPassword?: string
}

interface PreparedConnection {
  connectionId: string
  jobId: string
  edgeId: string
}

interface AppContextType {
  revertToZero: (confirm: string, password: string) => Promise<void>
  refresh: () => Promise<void>
  isDemoMode: boolean
  demoScenario: 'healthy'
  setDemoScenario: (value: import('../types').DemoScenario) => void
  availablePlants: PlantScope[]
  currentPlant: PlantScope
  setCurrentPlant: (plant: PlantScope) => void
  resources: ResourceNode[]
  allResources: ResourceNode[]
  siteNameById: Record<string, string>
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
  layoutDragging: boolean
  setLayoutDragging: (dragging: boolean) => void
  publishLayout: () => Promise<void>
  resetToReference: () => void
  addResource: (
    resource: Partial<ResourceNode> & { force?: boolean },
  ) => Promise<{ edgeCreated?: boolean; edgeId?: string; edgeName?: string }>
  updateResource: (
    resourceId: string,
    patch: { name?: string; code?: string; description?: string; properties?: Record<string, string> },
  ) => Promise<{ success: boolean; error?: string }>
  moveResource: (resourceId: string, newParentId: string) => Promise<{ success: boolean; error?: string }>
  archiveResource: (resourceId: string) => Promise<{ success: boolean; error?: string }>
  restoreResource: (resourceId: string) => Promise<{ success: boolean; error?: string }>
  importResources: (rows: Array<Record<string, string>>, opts?: { dryRun?: boolean; siteId?: string }) => Promise<{
    success: boolean
    created?: number
    error?: string
  }>
  showArchivedResources: boolean
  setShowArchivedResources: (value: boolean) => void
  updateLayoutNode: (id: string, updates: Partial<LayoutMachineNode>) => void
  testConnection: (id: string) => Promise<{ success: boolean; latency: number }>
  runDeterministicConnectionTest: (id: string, scenario?: string) => Promise<{ overallStatus: TestExecutionState; latency: number; steps: TestStepResult[] }>
  prepareAcquisition: (draft: AcquisitionDraft) => Promise<PreparedConnection>
  commissionAcquisition: (connectionId: string) => Promise<{
    passed: boolean
    stages: Array<{ name: string; status: string; latency?: number; detail?: string; sample?: unknown }>
    errorCode?: string
    diagnostic?: string
  }>
  activateAcquisition: (prepared: PreparedConnection, draft: AcquisitionDraft) => Promise<void>
  deleteConnection: (connectionId: string) => Promise<void>
  pauseConnection: (connectionId: string) => Promise<void>
  resumeConnection: (connectionId: string) => Promise<void>
  updateConnection: (
    connectionId: string,
    patch: { name?: string; config?: Record<string, unknown> },
  ) => Promise<void>
  duplicateConnection: (connectionId: string) => Promise<string>
  issueEnrollmentToken: (edgeId: string) => Promise<{ enrollment_token: string; expires_at: string; expires_in_seconds: number; edge_id: string }>
  queueApplianceEnroll: (edgeId: string) => Promise<{ status: string }>
  addSignal: (signal: Partial<SignalItem>) => void
  updateSignal: (
    signalId: string,
    patch: {
      display_name?: string
      unit?: string
      description?: string
      expected_interval_ms?: number
      status?: string
      data_type?: string
    },
  ) => Promise<{ success: boolean; error?: string }>
  bulkDeleteSignals: (signalIds: string[]) => Promise<{ count: number }>
  bulkAssignOutputGroup: (signalIds: string[], groupId: string) => Promise<void>
  saveCalculatedSignal: (signal: Partial<SignalItem>) => void
  saveOutputGroup: (group: OutputGroup) => Promise<string>
  createResourceType: (input: {
    key: string
    name: string
    category?: string
    parent_type_keys?: string[]
    child_type_keys?: string[]
  }) => Promise<void>
}

const AppContext = createContext<AppContextType | undefined>(undefined)

function text(value: unknown): string {
  return value == null ? '' : String(value)
}

function codeFrom(name: string): string {
  const raw = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (!raw) return `R${Date.now().toString(36)}`.slice(0, 64)
  return /^[A-Za-z0-9]/.test(raw) ? raw : `R-${raw}`.slice(0, 64)
}

function protocolOf(value: string): ProtocolType {
  if (value.includes('modbus')) return 'modbus'
  if (value.includes('opc')) return 'opcua'
  if (value.includes('mqtt')) return 'mqtt'
  return 'http'
}

function storedProtocol(value: AcquisitionDraft['protocol']): string {
  if (value === 'modbus') return 'modbus_tcp'
  return value
}

function signalType(value: string): SignalItem['dataType'] {
  const name = value.toLowerCase()
  if (name.includes('bool')) return 'boolean'
  if (name === 'text' || name.includes('string')) return 'text'
  if (name.includes('int')) return 'integer'
  if (name === 'number' || name.includes('float') || name.includes('double')) return 'number'
  if (name.includes('calc')) return 'calculated'
  return 'number'
}

function connectionPresentation(row: Record<string, unknown>): ConnectionItem['status'] {
  const lifecycle = text(row.status).toUpperCase()
  if (lifecycle === 'DRAFT') return 'draft'
  if (lifecycle === 'PAUSED') return 'paused'
  const health = text(row.health).toUpperCase()
  if (health === 'HEALTHY') return 'connected'
  if (health === 'DEGRADED' || health === 'PAUSED') return 'warning'
  if (lifecycle === 'ACTIVE' && (health === 'UNKNOWN' || !health)) return 'warning'
  return 'disconnected'
}

function describeAuditEvent(row: Record<string, unknown>): string {
  const eventType = text(row.event_type)
  const after = (row.after_json as Record<string, unknown>) || {}
  const before = (row.before_json as Record<string, unknown>) || {}
  const code = text(after.code || before.code)
  const name = text(after.name || after.display_name || before.name || before.display_name)
  switch (eventType) {
    case 'RESOURCE_CREATE':
      return code ? `Created resource ${code}` : 'Created a resource'
    case 'RESOURCE_UPDATE':
      return name || code ? `Updated resource ${name || code}` : 'Updated a resource'
    case 'RESOURCE_ARCHIVE':
      return 'Archived a resource'
    case 'RESOURCE_RESTORE':
      return 'Restored a resource'
    case 'RESOURCE_MOVE':
      return 'Moved a resource in the hierarchy'
    case 'CONNECTION_CREATE':
      return name ? `Created connection ${name}` : 'Created a connection'
    case 'CONNECTION_UPDATE':
      return name ? `Updated connection ${name}` : 'Updated a connection'
    case 'CONNECTION_PAUSE':
      return 'Paused a connection'
    case 'CONNECTION_RESUME':
      return 'Resumed a connection'
    case 'CONNECTION_ARCHIVE':
      return 'Archived a connection'
    case 'SIGNAL_BULK': {
      const created = text(after.created) || 'new'
      const where = code || name
      return where ? `${created} signals created on ${where}` : `Added ${created} signals`
    }
    case 'SIGNAL_UPDATE':
    case 'SIGNAL_RENAME':
      return name ? `Updated signal ${name}` : 'Updated a signal'
    case 'OUTPUT_GROUP_DRAFT':
    case 'OUTPUT_GROUP_UPDATE':
      return 'Saved an output group'
    case 'AUTH_LOGIN':
    case 'AUTH_LOGOUT':
      return ''
    default:
      if (eventType.startsWith('AUTH_')) return ''
      return eventType.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
  }
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

function describeAudit(
  eventType: string,
  entityType: string,
  after?: Record<string, unknown>,
): string {
  const name = after?.name ? String(after.name) : after?.login ? String(after.login) : ''
  const label = name || entityType || 'item'
  if (/REVERT/i.test(eventType)) return 'Installation reverted to zero'
  if (/AUTH_LOGIN/i.test(eventType)) return `${label} signed in`
  if (/AUTH_LOGOUT/i.test(eventType)) return `${label} signed out`
  if (/SITE_CREATE/i.test(eventType)) return `Site “${label}” was created`
  if (/RESOURCE_CREATE|CREATE/i.test(eventType) && /resource/i.test(entityType)) {
    return `Resource “${label}” was created`
  }
  if (/LAYOUT_DRAFT/i.test(eventType)) return 'Layout draft was saved'
  if (/LAYOUT_PUBLISH/i.test(eventType)) return 'Layout revision was published'
  if (/CONFIG_PUBLISH/i.test(eventType)) return 'Configuration was published to an edge'
  if (/EDGE/i.test(eventType)) return `Edge update: ${eventType.replace(/_/g, ' ').toLowerCase()}`
  if (/CONNECTION/i.test(eventType)) return `Connection “${label}”: ${eventType.replace(/_/g, ' ').toLowerCase()}`
  if (/SIGNAL/i.test(eventType)) return `Signals updated (${eventType.replace(/_/g, ' ').toLowerCase()})`
  if (/PASSWORD|RESET/i.test(eventType)) return 'Password was changed'
  return `${eventType.replace(/_/g, ' ')} on ${entityType}`.trim()
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [allResources, setAllResources] = useState<ResourceNode[]>([])
  const [connections, setConnections] = useState<ConnectionItem[]>([])
  const [edges, setEdges] = useState<EdgeItem[]>([])
  const [signals, setSignals] = useState<SignalItem[]>([])
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
  const [layoutMeta, setLayoutMeta] = useState<{ id: string; version: number } | null>(null)
  const [siteNameById, setSiteNameById] = useState<Record<string, string>>({})
  const [layoutDragging, setLayoutDragging] = useState(false)
  const [showArchivedResources, setShowArchivedResources] = useState(false)
  const layoutDraggingRef = React.useRef(false)

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
  const scopedSignals = signals.filter((item) => !currentPlant.id || resourceIds.has(item.resourceId))

  const refresh = useCallback(async () => {
    const archivedQuery = showArchivedResources ? '&include_archived=true' : ''
    const [resourcePage, connectionPage, signalPage, layoutPage, groupPage, auditPage, edgePage, sitePage] = await Promise.all([
      api<{ items: Array<Record<string, unknown>> }>(`/api/v1/resources?view=all&limit=200${archivedQuery}`),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/connections'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/signals?limit=500'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/layouts'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/output-groups'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/audit-events?limit=200'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/edges'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/sites').catch(() => ({ items: [] })),
    ])
    const mappedResources: ResourceNode[] = (resourcePage.items || []).map((row) => {
      const archived = Boolean(row.archived_at) || text(row.status) === 'ARCHIVED'
      const props = (row.properties_json as Record<string, unknown>) || {}
      const attrs: Record<string, string> = {
        siteId: text(row.site_id),
        version: text(row.version || 1),
      }
      for (const [key, value] of Object.entries(props)) {
        if (key === 'siteId' || key === 'version') continue
        attrs[key] = text(value)
      }
      return {
        id: text(row.id),
        name: text(row.name),
        type: text(row.type_key) as ResourceNode['type'],
        code: text(row.code),
        status: archived ? 'archived' : 'idle',
        parentId: row.parent_id ? text(row.parent_id) : undefined,
        description: text(row.description) || undefined,
        archivedAt: row.archived_at ? text(row.archived_at) : undefined,
        attributes: attrs,
      }
    })
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

    const latestIds = (signalPage.items || []).map((row) => text(row.id)).filter(Boolean)
    let latest = new Map<string, Record<string, unknown>>()
    if (latestIds.length) {
      const page = await api<{ items: Array<Record<string, unknown>> }>(
        `/api/v1/observations/latest?signal_ids=${latestIds.slice(0, 200).join(',')}`,
      )
      latest = new Map((page.items || []).map((row) => [text(row.signal_id), row]))
    }
    const edgeNameById = new Map((edgePage.items || []).map((row) => [text(row.id), text(row.name)]))
    const connectionMeta = new Map(
      (connectionPage.items || []).map((row) => [
        text(row.id),
        {
          name: text(row.name),
          edgeId: text(row.edge_id),
          lastError: text(row.last_error),
        },
      ]),
    )
    setConnections(
      (connectionPage.items || []).map((row) => {
        const lifecycle = (text(row.status).toUpperCase() || 'DRAFT') as ConnectionItem['lifecycle']
        const signalCount =
          row.signal_count == null || row.signal_count === ''
            ? null
            : Number(row.signal_count)
        const latency =
          row.latency_ms == null || row.latency_ms === '' ? null : Number(row.latency_ms)
        const throughput =
          row.throughput_per_sec == null || row.throughput_per_sec === ''
            ? null
            : Number(row.throughput_per_sec)
        return {
          id: text(row.id),
          name: text(row.name),
          protocol: protocolOf(text(row.protocol)),
          endpoint: text(row.endpoint_redacted),
          status: connectionPresentation(row),
          lifecycle,
          health: text(row.health) || 'UNKNOWN',
          plantId: text(row.site_id),
          siteId: text(row.site_id),
          edgeId: text(row.edge_id) || undefined,
          lastError: text(row.last_error) || undefined,
          version: Number(row.version || 1),
          secretConfigured: Boolean(row.secret_configured),
          latencyMs: Number.isFinite(latency as number) ? latency : null,
          lastConnected: text(row.last_success_at),
          signalsCount: Number.isFinite(signalCount as number) ? signalCount : null,
          throughputPerSec: Number.isFinite(throughput as number) ? throughput : null,
          errorRate: 0,
          config: (row.config as Record<string, unknown>) || {},
        }
      }),
    )
    setSignals(
      (signalPage.items || []).map((row) => {
        const state = latest.get(text(row.id))
        const value = (state?.value_json as { v?: unknown } | undefined)?.v
        const dataType = text(row.data_type)
        const connectionId = text(row.connection_id)
        const meta = connectionMeta.get(connectionId)
        const storedQuality = text(state?.quality || 'UNKNOWN')
        const freshness = text(state?.freshness)
        const quality = (
          freshness === 'STALE' && storedQuality !== 'BAD' ? 'STALE' : storedQuality || 'UNKNOWN'
        ) as SignalItem['quality']
        const explicitReason = text(state?.reason || state?.diagnostic)
        let qualityReason = explicitReason || undefined
        if (!qualityReason && quality === 'BAD') {
          qualityReason =
            meta?.lastError ||
            (value == null
              ? 'No value in the latest observation'
              : 'Quality BAD — no diagnostic was recorded')
        } else if (!qualityReason && quality === 'STALE') {
          qualityReason = 'Last sample is older than the expected interval'
        }
        const goodJson = state?.last_good_value_json as { v?: unknown } | null | undefined
        const goodValue = goodJson && typeof goodJson === 'object' && 'v' in goodJson ? goodJson.v : undefined
        const intervalRaw = row.expected_interval_ms
        return {
          id: text(row.id),
          name: text(row.display_name || row.key),
          tag: text(row.key),
          sourceConnectionId: connectionId,
          sourceConnectionName: meta?.name || text(row.connection_name) || '—',
          resourceId: text(row.resource_id),
          resourcePath: text(row.resource_name || row.resource_code),
          dataType: signalType(dataType),
          unit: text(row.unit),
          currentValue: value == null ? '—' : (value as string | number | boolean),
          quality,
          qualityReason,
          lastUpdated: text(state?.source_time || state?.event_time),
          sourceTime: text(state?.source_time) || undefined,
          receivedTime: text(state?.received_time || state?.event_time) || undefined,
          sampleIntervalMs:
            intervalRaw == null || intervalRaw === '' ? 0 : Number(intervalRaw),
          version: Number(row.version || 1),
          status: (text(row.status).toUpperCase() || 'ACTIVE') as SignalItem['status'],
          description: text(row.description) || undefined,
          edgeName: meta?.edgeId ? edgeNameById.get(meta.edgeId) || undefined : undefined,
          lastGoodValue: goodValue == null || goodValue === '' ? undefined : String(goodValue),
          lastGoodTime: text(state?.last_good_event_time) || undefined,
          bindingType: text(row.binding_type) as SignalItem['bindingType'],
          bindingAddress: text(row.binding_address || row.jsonpath),
          topic: text(row.topic) || undefined,
          jsonpath: text(row.jsonpath) || undefined,
        }
      }),
    )
    const layout = (layoutPage.items || [])[0]
    const saved = ((layout?.draft_json as { nodes?: Array<Record<string, unknown>> } | undefined)?.nodes || [])
    const savedByResource = new Map(saved.map((node) => [text(node.resourceId), node]))
    const placeableById = new Map(
      mappedResources
        .filter((item) => item.type === 'machine' || item.type === 'line')
        .map((item) => [item.id, item]),
    )
    setLayoutMeta(layout ? { id: text(layout.id), version: Number(layout.version || 1) } : null)
    // CR-L01: only draft-placed nodes on the canvas; palette lists the rest. Skip remap while dragging.
    if (!layoutDraggingRef.current) {
      const fromDraft = saved
        .map((node, index) => {
          const resourceId = text(node.resourceId)
          const item = placeableById.get(resourceId)
          if (!item) return null
          return {
            id: resourceId,
            resourceId,
            name: item.name,
            code: item.code,
            x: Number(node.x ?? 40 + (index % 4) * 220),
            y: Number(node.y ?? 40 + Math.floor(index / 4) * 150),
            width: Number(node.width ?? 180),
            height: Number(node.height ?? 100),
            status: item.status,
          }
        })
        .filter(Boolean) as LayoutMachineNode[]
      setLayoutNodes(fromDraft)
    }
    setOutputGroups(
      (groupPage.items || []).map((row) => {
        const members = Array.isArray(row.members)
          ? (row.members as Array<{ signal_id?: string; alias?: string }>)
          : []
        const policy = (row.projection_policy_json || {}) as { mode?: string }
        return {
          id: text(row.id),
          name: text(row.display_name || row.key),
          key: text(row.key),
          topicTemplate:
            text(row.topic_template) || '{enterprise}/{site}/{area}/{line}/{machine}/{group}',
          enabled: text(row.status) !== 'ARCHIVED',
          publishIntervalMs: 1000,
          assignedSignals: members.map((m) => text(m.signal_id)).filter(Boolean),
          resourceId: text(row.resource_id),
          version: Number(row.version || 1),
          payloadFormat: policy.mode === 'compact' ? 'flat' : 'uns',
          lastPublished: '',
          samplePayload: '',
          members: members.map((m) => ({
            signal_id: text(m.signal_id),
            alias: text(m.alias),
          })),
        }
      }),
    )
    setActivities(
      (auditPage.items || [])
        .filter((row) => {
          const eventType = text(row.event_type)
          return !/^AUTH_/i.test(eventType)
        })
        .map((row) => {
          const eventType = text(row.event_type)
          const entityType = text(row.entity_type || 'Center')
          const actorName = text(row.actor_name || row.actor_login || '')
          let severity: ActivityEvent['severity'] = 'info'
          if (/FAIL|ERROR|DELETE|REVOKE|REVERT|LOCK|ARCHIVE/i.test(eventType)) severity = 'error'
          else if (/WARN|DEGRAD|OFFLINE|TIMEOUT|PAUSE/i.test(eventType)) severity = 'warning'
          else if (/CREATE|PUBLISH|PASS|ENROLL|SUCCESS|RESTORE|UPDATE/i.test(eventType)) {
            severity = 'success'
          }
          const sentence =
            describeAuditEvent(row) ||
            describeAudit(eventType, entityType, row.after_json as Record<string, unknown> | undefined)
          return {
            id: text(row.id),
            timestamp: text(row.occurred_at),
            severity,
            source: actorName || entityType,
            eventType,
            message: sentence,
            entityId: text(row.entity_id) || undefined,
            entityType,
            actorName: actorName || undefined,
            details: {
              ...(typeof row.after_json === 'object' && row.after_json
                ? (row.after_json as Record<string, unknown>)
                : {}),
              actor: actorName || undefined,
              event_type: eventType,
            },
          }
        })
        .filter((item) => Boolean(item.message)),
    )
    const siteMap: Record<string, string> = {}
    for (const row of sitePage.items || []) {
      siteMap[text(row.id)] = text(row.name) || text(row.code) || text(row.id)
    }
    for (const item of mappedResources.filter((r) => r.type === 'site')) {
      const sid = item.attributes?.siteId || item.id
      if (sid && !siteMap[sid]) siteMap[sid] = item.name
      siteMap[item.id] = item.name
    }
    setSiteNameById(siteMap)
    const edgeItems = edgePage.items || []
    const mappedEdges: EdgeItem[] = edgeItems.map((row) => ({
      id: text(row.id),
      name: text(row.name),
      siteId: text(row.site_id),
      enrollmentStatus: text(row.enrollment_status),
      health: text(row.health),
      desiredRevision: Number(row.desired_revision || 0),
      activeRevision: Number(row.active_revision || 0),
      lastHeartbeat: text(row.last_heartbeat),
      softwareVersion: text(row.software_version) || undefined,
      outboxPending:
        row.outbox_pending == null || row.outbox_pending === ''
          ? null
          : Number(row.outbox_pending),
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
      (connectionPage.items || [])
        .filter((row) => text(row.health) === 'DEGRADED' || text(row.last_error))
        .map((row) => ({
          id: text(row.id),
          connectionId: text(row.id),
          connectionName: text(row.name),
          protocol: protocolOf(text(row.protocol)),
          status: text(row.health) === 'DEGRADED' ? 'degraded' : 'critical',
          uptimeSeconds: 0,
          messagesReceived: 0,
          messagesDropped: null,
          lastError: text(row.last_error),
        })),
    )
  }, [showArchivedResources])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  useEffect(() => {
    if (!isStreaming) return
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [isStreaming, refresh])

  const revertToZero = async (confirm: string, password: string) => {
    await api('/api/v1/admin/revert-to-zero', {
      method: 'POST',
      body: JSON.stringify({ confirm, password }),
    })
    setAllResources([])
    setConnections([])
    setEdges([])
    setSignals([])
    setLayoutNodes([])
    setOutputGroups([])
    setActivities([])
    setDiagnostics([])
    setPlants([])
    setCurrentPlant(EMPTY_PLANT)
    window.location.assign('/register')
  }

  const markLayoutDragging = (dragging: boolean) => {
    layoutDraggingRef.current = dragging
    setLayoutDragging(dragging)
  }

  const publishLayout = async () => {
    let meta = layoutMeta
    if (!meta) {
      const created = await api<{ id: string; version: number }>('/api/v1/layouts', {
        method: 'POST',
        body: JSON.stringify({ name: 'Factory floor', scope_resource_id: currentPlant.id || null }),
      })
      meta = { id: created.id, version: Number(created.version || 1) }
      setLayoutMeta(meta)
    }
    await api(`/api/v1/layouts/${meta.id}/publish`, { method: 'POST' })
    await refresh()
  }

  const addResource = async (resource: Partial<ResourceNode> & { force?: boolean }) => {
    const typeKey = (resource.type || 'machine').toLowerCase()
    const name = resource.name || 'Resource'
    const code = codeFrom(resource.code || name)
    const parent = allResources.find((item) => item.id === resource.parentId)
    let siteId = parent?.attributes?.siteId || ''
    let edgeCreated: { id: string; name: string } | null = null
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
        force: Boolean(resource.force),
      }),
    })
    if (typeKey === 'site') {
      const edgeName = `Edge ${name}`
      const edge = await api<{ id: string }>('/api/v1/edges', {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId, name: edgeName }),
      })
      try {
        await api(`/api/v1/edges/${edge.id}/appliance`, { method: 'POST' })
      } catch {
        // Appliance mode may be off; Edge still needs manual enrollment.
      }
      edgeCreated = { id: edge.id, name: edgeName }
    }
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
    if (edgeCreated) {
      return { edgeCreated: true, edgeId: edgeCreated.id, edgeName: edgeCreated.name }
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
      const current = allResources.find((item) => item.id === resourceId)
      const parentId = current?.parentId || ''
      await api(`/api/v1/resources/${resourceId}/archive`, { method: 'POST' })
      await refresh()
      if (selectedResourceId === resourceId) {
        setSelectedResourceId(parentId)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Archive failed' }
    }
  }

  const restoreResource = async (resourceId: string) => {
    try {
      await api(`/api/v1/resources/${resourceId}/restore`, { method: 'POST' })
      await refresh()
      setSelectedResourceId(resourceId)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Restore failed' }
    }
  }

  const updateResource = async (
    resourceId: string,
    patch: { name?: string; code?: string; description?: string; properties?: Record<string, string> },
  ) => {
    const current = allResources.find((item) => item.id === resourceId)
    if (!current) return { success: false, error: 'Resource was not found.' }
    try {
      await api(`/api/v1/resources/${resourceId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: Number(current.attributes?.version || 1),
          name: patch.name,
          code: patch.code,
          description: patch.description,
          properties: patch.properties,
        }),
      })
      await refresh()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Update failed' }
    }
  }

  const importResources = async (
    rows: Array<Record<string, string>>,
    opts?: { dryRun?: boolean; siteId?: string },
  ) => {
    try {
      const result = await api<{ created?: number; accepted?: number }>('/api/v1/resources/import', {
        method: 'POST',
        body: JSON.stringify({
          site_id: opts?.siteId || null,
          dry_run: Boolean(opts?.dryRun),
          rows,
        }),
      })
      if (!opts?.dryRun) await refresh()
      return { success: true, created: Number(result.created || result.accepted || 0) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Import failed' }
    }
  }

  const createResourceType = async (input: {
    key: string
    name: string
    category?: string
    parent_type_keys?: string[]
    child_type_keys?: string[]
  }) => {
    await api('/api/v1/resource-types', {
      method: 'POST',
      body: JSON.stringify({
        key: input.key,
        name: input.name,
        category: input.category || 'CUSTOM',
        parent_type_keys: input.parent_type_keys || [],
        child_type_keys: input.child_type_keys || [],
      }),
    })
  }

  const updateLayoutNode = (id: string, updates: Partial<LayoutMachineNode>) => {
    setLayoutNodes((current) => {
      const existing = current.find((node) => node.id === id)
      let next: LayoutMachineNode[]
      if (existing) {
        next = current.map((node) => (node.id === id ? { ...node, ...updates } : node))
      } else {
        const resource = allResources.find((item) => item.id === id)
        if (!resource) return current
        const index = current.length
        next = [
          ...current,
          {
            id,
            resourceId: id,
            name: resource.name,
            code: resource.code,
            x: Number(updates.x ?? 40 + (index % 4) * 200),
            y: Number(updates.y ?? 40 + Math.floor(index / 4) * 140),
            width: Number(updates.width ?? 180),
            height: Number(updates.height ?? 100),
            status: resource.status,
            ...updates,
          },
        ]
      }
      const draft = {
        nodes: next.map((node) => ({
          resourceId: node.resourceId,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
        })),
      }
      void (async () => {
        try {
          let meta = layoutMeta
          if (!meta) {
            const created = await api<{ id: string; version: number }>('/api/v1/layouts', {
              method: 'POST',
              body: JSON.stringify({ name: 'Factory floor', scope_resource_id: currentPlant.id || null }),
            })
            meta = { id: created.id, version: Number(created.version || 1) }
            setLayoutMeta(meta)
          }
          const saved = await api<{ version: number }>(`/api/v1/layouts/${meta.id}/draft`, {
            method: 'PATCH',
            body: JSON.stringify({ version: meta.version, draft }),
          })
          setLayoutMeta({ id: meta.id, version: Number(saved.version || meta.version + 1) })
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            try {
              const page = await api<{ items: Array<Record<string, unknown>> }>('/api/v1/layouts')
              const layout = (page.items || [])[0]
              if (layout) {
                setLayoutMeta({ id: text(layout.id), version: Number(layout.version || 1) })
              }
            } catch {
              /* ignore refresh failure */
            }
          }
        }
      })()
      return next
    })
  }

  const connectionConfig = (draft: AcquisitionDraft): Record<string, unknown> => {
    const port = Number(draft.port)
    const interval_ms = draft.intervalMs
    if (draft.protocol === 'modbus') {
      return {
        host: draft.host,
        port,
        unit_id: Number(draft.extra || 1),
        timeout_ms: draft.modbusTimeoutMs ?? 3000,
        retries: draft.modbusRetries ?? 1,
        interval_ms,
      }
    }
    if (draft.protocol === 'opcua') {
      const endpoint = draft.host.startsWith('opc.tcp://') ? draft.host : `opc.tcp://${draft.host}:${port}`
      const security_mode = draft.opcSecurityMode || draft.extra || 'None'
      const username = draft.opcUsername?.trim()
      return {
        endpoint,
        security_mode,
        security_policy: draft.opcSecurityPolicy || (security_mode === 'None' ? 'None' : 'Basic256Sha256'),
        anonymous: !username,
        username: username || undefined,
        allow_insecure: security_mode === 'None',
        trust_all: Boolean(draft.opcTrustAll),
        interval_ms,
      }
    }
    if (draft.protocol === 'mqtt') {
      const topic = draft.extra.trim()
      const username = draft.mqttUsername?.trim()
      const anonymous = draft.mqttAnonymous !== false && !username
      const qos = typeof draft.mqttQos === 'number' ? draft.mqttQos : 1
      return {
        host: draft.host,
        port,
        anonymous,
        username: username || undefined,
        topics: topic ? [topic] : [],
        qos,
        protocol_version: draft.mqttVersion === '5' || draft.mqttVersion === '5.0' ? '5' : draft.mqttVersion || '3.1.1',
        client_id: draft.mqttClientId || undefined,
        keepalive: draft.mqttKeepalive ?? 60,
        clean_session: true,
        tls: Boolean(draft.mqttTls),
        tls_verify: draft.mqttTlsVerify !== false,
        tls_ca: draft.mqttTlsCa || undefined,
        tls_client_cert: draft.mqttTlsClientCert || undefined,
        timestamp_jsonpath: draft.timestampJsonpath || '$.source_timestamp',
        interval_ms,
      }
    }
    const url = draft.host.startsWith('http') ? new URL(draft.host) : null
    let headers: Record<string, string> = {}
    if (draft.httpHeaders?.trim()) {
      try {
        headers = JSON.parse(draft.httpHeaders) as Record<string, string>
      } catch {
        headers = {}
      }
    }
    return {
      base_url: url ? `${url.protocol}//${url.host}` : `http://${draft.host}:${port}`,
      path: url?.pathname || draft.extra || '/',
      method: draft.httpMethod || 'GET',
      auth: draft.httpAuth || 'none',
      username: draft.httpUsername || undefined,
      headers,
      timeout_ms: draft.httpTimeoutMs ?? 5000,
      interval_ms,
    }
  }

  const ensureEdge = async (siteId: string) => {
    const edges = await api<{ items: Array<Record<string, unknown>> }>('/api/v1/edges')
    const existing = (edges.items || []).find((item) => text(item.site_id) === siteId)
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
    const secret =
      draft.protocol === 'mqtt'
        ? draft.mqttPassword
        : draft.protocol === 'opcua'
          ? draft.opcPassword
          : draft.protocol === 'http'
            ? draft.httpPassword
            : undefined
    const created = await api<{ id: string; jobs?: Array<{ id: string }> }>('/api/v1/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: draft.name || `${draft.protocol} ${draft.host}`,
        site_id: siteId,
        edge_id: edgeId,
        protocol: storedProtocol(draft.protocol),
        config: connectionConfig(draft),
        secret_input: secret || undefined,
      }),
    })
    const jobId = created.jobs?.[0]?.id
    if (!jobId) throw new Error('The collector did not create an acquisition job.')
    await refresh()
    return { connectionId: created.id, jobId, edgeId }
  }

  const commissionAcquisition = async (connectionId: string) => {
    let queued: { job_id?: string; error_code?: string; message?: string; status?: string }
    try {
      queued = await api(`/api/v1/connections/${connectionId}/tests`, { method: 'POST' })
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'EDGE_NOT_ENROLLED' || /not enrolled/i.test(error.message))) {
        return {
          passed: false,
          errorCode: 'EDGE_NOT_ENROLLED',
          stages: [{ name: 'EDGE_ENROLLMENT', status: 'FAILED', latency: undefined }],
        }
      }
      throw error
    }
    if (text(queued.error_code) === 'EDGE_NOT_ENROLLED') {
      return {
        passed: false,
        errorCode: 'EDGE_NOT_ENROLLED',
        stages: [{ name: 'EDGE_ENROLLMENT', status: 'FAILED', latency: undefined }],
      }
    }
    const jobId = text(queued.job_id)
    if (!jobId) throw new Error('Commission job was not created.')
    let last: {
      status?: string
      error_code?: string
      diagnostic?: string
      stages_json?: Array<{
        stage: string
        status: string
        duration_ms?: number
        detail?: string
        sample?: unknown
      }>
    } = {}
    for (let attempt = 0; attempt < 12; attempt += 1) {
      last = await api(`/api/v1/commissioning/${jobId}`)
      const status = text(last.status)
      const code = text(last.error_code)
      if (code === 'EDGE_NOT_ENROLLED') {
        return {
          passed: false,
          errorCode: 'EDGE_NOT_ENROLLED',
          stages: [{ name: 'EDGE_ENROLLMENT', status: 'FAILED', latency: undefined }],
        }
      }
      if (['PASSED', 'FAILED', 'COMPLETED', 'ERROR'].includes(status)) break
      await new Promise((resolve) => window.setTimeout(resolve, 1000))
    }
    const DUPLICATE_ALIASES = new Set(['transport', 'read_sample', 'decode_quality'])
    const mapStage = (stage: {
      stage: string
      status: string
      duration_ms?: number
      detail?: string
      sample?: unknown
    }) => ({
      name: stage.stage,
      status: stage.status,
      latency: stage.duration_ms && stage.duration_ms > 0 ? stage.duration_ms : undefined,
      detail: stage.detail,
      sample: stage.sample,
    })
    const finalStatus = text(last.status)
    if (!['PASSED', 'FAILED', 'COMPLETED', 'ERROR'].includes(finalStatus)) {
      return {
        passed: false,
        diagnostic: text(last.diagnostic) || undefined,
        stages: [
          ...(last.stages_json || [])
            .filter((stage) => !DUPLICATE_ALIASES.has(String(stage.stage || '').toLowerCase()))
            .map(mapStage),
          {
            name: 'TIMEOUT',
            status: 'FAILED',
            latency: undefined,
          },
        ],
      }
    }
    const stages = (last.stages_json || [])
      .filter((stage) => !DUPLICATE_ALIASES.has(String(stage.stage || '').toLowerCase()))
      .map(mapStage)
    const failed = stages.some((stage) => stage.status === 'FAILED')
    // CR-Q06: NETWORK alone is never enough — Activate only when Map fields passes.
    const mapFields = stages.find((stage) =>
      ['MAPPING', 'MAP_FIELDS'].includes(String(stage.name).toUpperCase()),
    )
    const mapFieldsPassed =
      mapFields?.status === 'PASSED' ||
      mapFields?.status === 'COMPLETED' ||
      // Protocols without a mapping stage (e.g. Modbus probe) may mark N/A after a real read.
      (mapFields?.status === 'NOT_APPLICABLE' &&
        stages.some(
          (stage) =>
            ['DECODE', 'READ_OR_SUBSCRIBE', 'VALIDATION'].includes(String(stage.name).toUpperCase()) &&
            (stage.status === 'PASSED' || stage.status === 'COMPLETED'),
        ))
    const passed =
      !failed &&
      Boolean(mapFieldsPassed) &&
      (finalStatus === 'PASSED' || finalStatus === 'COMPLETED')
    return { passed, stages, diagnostic: text(last.diagnostic) || undefined }
  }

  const activateAcquisition = async (prepared: PreparedConnection, draft: AcquisitionDraft) => {
    const native = (value: string) => {
      const name = value.toLowerCase().replace(/[\s_-]/g, '')
      if (name === 'string' || name === 'text' || name === 'json' || name === 'timestamp') return 'string'
      if (name === 'bool' || name === 'boolean') return 'bool'
      if (name === 'int16') return 'int16'
      if (name === 'uint16') return 'uint16'
      if (name === 'int32') return 'int32'
      if (name === 'uint32') return 'uint32'
      if (name === 'int64' || name === 'integer' || name === 'int') return 'int64'
      if (name === 'float32' || name === 'float') return 'float32'
      if (name === 'float64' || name === 'number' || name === 'double') return 'float64'
      if (name.includes('string') || name.includes('text')) return 'string'
      if (name.includes('bool')) return 'bool'
      if (name.includes('int')) return 'int64'
      if (name.includes('float') || name.includes('number')) return 'float64'
      return 'string'
    }
    const canonical = (value: string) => {
      const kind = native(value)
      if (kind === 'bool') return 'bool'
      if (kind === 'string') return 'string'
      if (kind === 'int16' || kind === 'uint16' || kind === 'int32' || kind === 'uint32' || kind === 'int64') {
        return 'int64'
      }
      if (kind === 'float32' || kind === 'float64') return 'float64'
      return 'string'
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
                ? {
                    offset: Number(field.address),
                    register_area: field.registerArea || 'holding',
                    native_type: native(field.dataType),
                    word_order: field.wordOrder || 'big',
                  }
                : draft.protocol === 'opcua'
                  ? { node_id: field.address }
                  : draft.protocol === 'mqtt'
                    ? {
                        topic: (field.topic || draft.extra || '').trim(),
                        jsonpath: field.address || '$.source_timestamp',
                        qos:
                          typeof field.qos === 'number'
                            ? field.qos
                            : typeof draft.mqttQos === 'number'
                              ? draft.mqttQos
                              : 1,
                      }
                    : { path: connectionConfig(draft).path, jsonpath: field.address },
            scale: field.scale ?? 1,
            offset: field.offset ?? 0,
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
    const result = await commissionAcquisition(id)
    return { success: result.passed, latency: result.stages.find((stage) => stage.latency)?.latency || 0 }
  }

  const deleteConnection = async (connectionId: string) => {
    await api(`/api/v1/connections/${connectionId}`, { method: 'DELETE' })
    await refresh()
  }

  const pauseConnection = async (connectionId: string) => {
    await api(`/api/v1/connections/${connectionId}/pause`, { method: 'POST' })
    await refresh()
  }

  const resumeConnection = async (connectionId: string) => {
    await api(`/api/v1/connections/${connectionId}/resume`, { method: 'POST' })
    await refresh()
  }

  const updateConnection = async (
    connectionId: string,
    patch: { name?: string; config?: Record<string, unknown> },
  ) => {
    const current = connections.find((item) => item.id === connectionId)
    if (!current) throw new Error('Connection was not found.')
    await api(`/api/v1/connections/${connectionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        version: Number(current.version || 1),
        name: patch.name,
        config: patch.config,
      }),
    })
    await refresh()
  }

  const duplicateConnection = async (connectionId: string) => {
    const detail = await api<Record<string, unknown>>(`/api/v1/connections/${connectionId}`)
    if (detail.secret_configured) {
      throw new Error('This connection cannot be duplicated because its secret is not copied.')
    }
    const created = await api<{ id: string }>('/api/v1/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: `${text(detail.name)} (copy)`,
        site_id: text(detail.site_id),
        edge_id: text(detail.edge_id),
        protocol: text(detail.protocol),
        config: (detail.config as Record<string, unknown>) || {},
      }),
    })
    await refresh()
    return created.id
  }

  const updateSignal = async (
    signalId: string,
    patch: {
      display_name?: string
      unit?: string
      description?: string
      expected_interval_ms?: number
      status?: string
      data_type?: string
    },
  ) => {
    const current = signals.find((item) => item.id === signalId)
    if (!current) return { success: false, error: 'Signal was not found.' }
    try {
      await api(`/api/v1/signals/${signalId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: Number(current.version || 1),
          display_name: patch.display_name,
          unit: patch.unit,
          description: patch.description,
          expected_interval_ms: patch.expected_interval_ms,
          status: patch.status,
          data_type: patch.data_type,
        }),
      })
      await refresh()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Update failed' }
    }
  }

  const bulkDeleteSignals = async (signalIds: string[]) => {
    let count = 0
    for (const signalId of signalIds) {
      const current = signals.find((item) => item.id === signalId)
      if (!current) continue
      await api(`/api/v1/signals/${signalId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: Number(current.version || 1),
          status: 'ARCHIVED',
        }),
      })
      count += 1
    }
    await refresh()
    return { count }
  }

  const bulkAssignOutputGroup = async (signalIds: string[], groupId: string) => {
    const group = outputGroups.find((item) => item.id === groupId)
    if (!group) throw new Error('Output group was not found.')
    const existing = new Set(group.assignedSignals)
    const members = [
      ...group.assignedSignals.map((id) => ({
        signal_id: id,
        alias: signals.find((s) => s.id === id)?.tag || id.slice(0, 8),
      })),
      ...signalIds
        .filter((id) => !existing.has(id))
        .map((id) => ({
          signal_id: id,
          alias: signals.find((s) => s.id === id)?.tag || id.slice(0, 8),
        })),
    ]
    await api(`/api/v1/output-groups/${groupId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        version: Number(group.version || 1),
        members,
      }),
    })
    await refresh()
  }

  const saveOutputGroup = async (group: OutputGroup) => {
    const topic = (group.topicTemplate || '{enterprise}/{site}/{area}/{line}/{machine}/{group}')
      .trim()
      .replace(/^\/+/, '')
      .replace(/\/{2,}/g, '/')
    const usedAliases = new Set<string>()
    const members = (group.assignedSignals || []).map((id) => {
      let alias = signals.find((s) => s.id === id)?.tag || id.slice(0, 8)
      if (usedAliases.has(alias)) alias = `${alias}-${id.slice(0, 4)}`
      usedAliases.add(alias)
      return { signal_id: id, alias }
    })
    const resourceId = group.resourceId || resources[0]?.id
    if (!resourceId) throw new Error('Choose a scope resource before saving an output group.')
    const projection = {
      mode: group.payloadFormat === 'flat' ? 'compact' : 'rich',
      missing: 'null',
      format: group.payloadFormat === 'flat' ? 'flat' : 'uns',
    }
    if (group.id && !group.id.startsWith('grp-draft-') && outputGroups.some((g) => g.id === group.id)) {
      await api(`/api/v1/output-groups/${group.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: Number(group.version || 1),
          display_name: group.name,
          topic_template: topic,
          resource_id: resourceId,
          members,
          projection_policy: projection,
        }),
      })
      await refresh()
      return group.id
    }
    const created = await api<{ id: string }>('/api/v1/output-groups', {
      method: 'POST',
      body: JSON.stringify({
        resource_id: resourceId,
        key: codeFrom(group.key || group.name),
        display_name: group.name,
        topic_template: topic,
        members,
        projection_policy: projection,
      }),
    })
    await refresh()
    return created.id
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
    revertToZero,
    refresh,
    isDemoMode: false,
    demoScenario: 'healthy',
    setDemoScenario: () => undefined,
    availablePlants: plants.length ? plants : [EMPTY_PLANT],
    currentPlant,
    setCurrentPlant,
    resources,
    allResources,
    siteNameById,
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
    layoutDragging,
    setLayoutDragging: markLayoutDragging,
    publishLayout,
    resetToReference: () => undefined,
    addResource,
    updateResource,
    moveResource,
    archiveResource,
    restoreResource,
    importResources,
    showArchivedResources,
    setShowArchivedResources,
    updateLayoutNode,
    testConnection,
    runDeterministicConnectionTest: async (id, _scenario) => {
      const result = await testConnection(id)
      return { overallStatus: result.success ? 'PASS' : 'FAIL', latency: result.latency, steps: [] }
    },
    prepareAcquisition,
    commissionAcquisition,
    activateAcquisition,
    deleteConnection,
    pauseConnection,
    resumeConnection,
    updateConnection,
    duplicateConnection,
    issueEnrollmentToken,
    queueApplianceEnroll,
    addSignal: () => undefined,
    updateSignal,
    bulkDeleteSignals,
    bulkAssignOutputGroup,
    saveCalculatedSignal: () => undefined,
    saveOutputGroup,
    createResourceType,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextType {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp must be used inside AppProvider')
  return context
}
