import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ApiError, api } from '../api/client'
import { commissioningPassed, mappingContract } from '../features/acquisition/contracts'
import { normalizeLiveState } from '../features/signals/live'
import { createAsset, loadModelResources } from '../features/assets/api'
import { codePreviewFromName } from '../utils/resourceHierarchy'
import type { ResourceEditorSnapshot, ResourceFormValues, ResourceTypeDefinition, ResourceTypeInput } from '../features/assets/model'
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
  topic?: string
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

interface AppContextType {
  revertToZero: (confirm: string) => Promise<void>
  refresh: () => Promise<void>
  isDemoMode: boolean
  demoScenario: 'healthy'
  setDemoScenario: (value: import('../types').DemoScenario) => void
  availablePlants: PlantScope[]
  currentPlant: PlantScope
  setCurrentPlant: (plant: PlantScope) => void
  resources: ResourceNode[]
  modelResources: ResourceNode[]
  modelSignals: SignalItem[]
  resourceTypes: ResourceTypeDefinition[]
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
  addResource: (resource: ResourceFormValues) => Promise<{ edgeCreated?: boolean; edgeId?: string; edgeName?: string; enrollmentStatus?: string; enrollmentError?: string; warnings?: Array<{ code: string; message: string }> }>
  loadResourceEditor: (id: string) => Promise<ResourceEditorSnapshot>
  editResource: (snapshot: ResourceEditorSnapshot, resource: ResourceFormValues) => Promise<void>
  createResourceType: (resourceType: ResourceTypeInput) => Promise<ResourceTypeDefinition>
  moveResource: (resourceId: string, newParentId: string | null, options?: { version?: number; hierarchyMode?: 'guided' | 'strict' }) => Promise<{ success: boolean; error?: string; version?: number; warnings?: Array<{ code: string; message: string }> }>
  archiveResource: (resourceId: string, version: number) => Promise<{ success: boolean; error?: string; version?: number; deploymentPending?: boolean }>
  restoreResource: (resourceId: string, version: number) => Promise<void>
  updateLayoutNode: (id: string, updates: Partial<LayoutMachineNode>) => void
  testConnection: (id: string) => Promise<{ success: boolean; latency: number }>
  runDeterministicConnectionTest: (id: string, scenario?: string) => Promise<{ overallStatus: TestExecutionState; latency: number; steps: TestStepResult[] }>
  prepareAcquisition: (draft: AcquisitionDraft) => Promise<PreparedConnection>
  commissionAcquisition: (connectionId: string, draft?: AcquisitionDraft) => Promise<{ passed: boolean; stages: Array<{ name: string; status: string; latency?: number; detail?: string }>; errorCode?: string }>
  activateAcquisition: (prepared: PreparedConnection, draft: AcquisitionDraft) => Promise<void>
  deleteConnection: (connectionId: string) => Promise<void>
  issueEnrollmentToken: (edgeId: string) => Promise<{ enrollment_token: string; expires_at: string; expires_in_seconds: number; edge_id: string }>
  queueApplianceEnroll: (edgeId: string) => Promise<{ status: string; refreshFailed?: boolean }>
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
  const raw = codePreviewFromName(name)
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

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [allResources, setAllResources] = useState<ResourceNode[]>([])
  const [resourceTypes, setResourceTypes] = useState<ResourceTypeDefinition[]>([])
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

  const activeResources = useMemo(() => allResources.filter(resource => resource.lifecycle !== 'ARCHIVED'), [allResources])
  const resources = useMemo(
    () => scopeToPlant(activeResources, currentPlant.id),
    [activeResources, currentPlant.id],
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
    const [resourcePage, connectionPage, signalPage, layoutPage, groupPage, auditPage, edgePage, sitePage, typePage] = await Promise.all([
      loadModelResources(),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/connections'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/signals?limit=500'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/layouts'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/output-groups'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/audit-events?limit=50'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/edges'),
      api<{ items: Array<Record<string, unknown>> }>('/api/v1/sites'),
      api<{ items: ResourceTypeDefinition[] }>('/api/v1/resource-types'),
    ])
    setResourceTypes(typePage.items)
    const mappedResources: ResourceNode[] = (resourcePage.items || []).map((row) => ({
      id: text(row.id),
      name: text(row.name),
      type: text(row.type_key) as ResourceNode['type'],
      code: text(row.code),
      status: 'idle',
      parentId: row.parent_id ? text(row.parent_id) : undefined,
      description: text(row.description),
      properties: row.properties_json && typeof row.properties_json === 'object' ? row.properties_json as Record<string, unknown> : {},
      version: Number(row.version || 1),
      lifecycle: text(row.status) as 'ACTIVE' | 'ARCHIVED',
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      attributes: {
        siteId: text(row.site_id),
        version: text(row.version || 1),
      },
    }))
    const siteTimezone = new Map((sitePage.items || []).map(site => [text(site.id), text(site.timezone)]))
    const resourcesById = new Map(mappedResources.map(resource => [resource.id, resource]))
    const resourcePath = (id: string, fallback: string) => {
      const chain: string[] = []
      const visited = new Set<string>()
      let resource = resourcesById.get(id)
      while (resource && !visited.has(resource.id)) {
        visited.add(resource.id)
        chain.unshift(resource.name)
        resource = resource.parentId ? resourcesById.get(resource.parentId) : undefined
      }
      return chain.join(' / ') || fallback
    }
    const activeModel = mappedResources.filter(item => item.lifecycle !== 'ARCHIVED')
    const plantRows = activeModel.filter((item) => item.type === 'plant')
    const nextPlants = plantRows.map((item) => ({
      id: item.id,
      name: item.name,
      code: item.code,
      zone: mappedResources.find((parent) => parent.id === item.parentId)?.name || 'Site',
      status: 'operational' as const,
      assetsCount: descendants(activeModel, item.id).size,
      timezone: siteTimezone.get(item.attributes?.siteId || '') || undefined,
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
    const connectionName = new Map((connectionPage.items || []).map((row) => [text(row.id), text(row.name)]))
    setConnections(
      (connectionPage.items || []).map((row) => {
        const health = text(row.health)
        const status = health === 'HEALTHY' ? 'connected' : health === 'DEGRADED' ? 'warning' : 'disconnected'
        return {
          id: text(row.id),
          name: text(row.name),
          protocol: protocolOf(text(row.protocol)),
          endpoint: text(row.endpoint_redacted),
          status,
          plantId: text(row.site_id),
          latencyMs: 0,
          lastConnected: text(row.last_success_at),
          signalsCount: 0,
          throughputPerSec: 0,
          errorRate: 0,
          config: (row.config as Record<string, unknown>) || {},
        }
      }),
    )
    setSignals(
      (signalPage.items || []).map((row) => {
        const state = latest.get(text(row.id))
        const dataType = text(row.data_type)
        return {
          id: text(row.id),
          name: text(row.display_name || row.key),
          tag: text(row.key),
          sourceConnectionId: text(row.connection_id),
          sourceConnectionName: connectionName.get(text(row.connection_id)) || text(row.connection_name) || 'Not linked',
          sourceProtocol: row.protocol ? protocolOf(text(row.protocol)) : undefined,
          sourceAddress: row.address_json && typeof row.address_json === 'object' ? row.address_json as Record<string, unknown> : undefined,
          resourceId: text(row.resource_id),
          resourcePath: resourcePath(text(row.resource_id), text(row.resource_name || row.resource_code)),
          dataType: dataType === 'boolean' || dataType === 'bool' ? 'boolean' : signalType(dataType),
          unit: text(row.unit),
          ...normalizeLiveState(state),
          canonicalType: dataType,
          timezone: siteTimezone.get(resourcesById.get(text(row.resource_id))?.attributes?.siteId || '') || undefined,
          sampleIntervalMs: Number(row.expected_interval_ms || 1000),
        }
      }),
    )
    const layout = (layoutPage.items || [])[0]
    const saved = ((layout?.draft_json as { nodes?: Array<Record<string, unknown>> } | undefined)?.nodes || [])
    const savedByResource = new Map(saved.map((node) => [text(node.resourceId), node]))
    const placeable = mappedResources.filter((item) => item.type === 'machine' || item.type === 'line')
    setLayoutMeta(layout ? { id: text(layout.id), version: Number(layout.version || 1) } : null)
    setLayoutNodes(
      placeable.map((item, index) => {
        const node = savedByResource.get(item.id)
        return {
          id: item.id,
          resourceId: item.id,
          name: item.name,
          code: item.code,
          x: Number(node?.x ?? 40 + (index % 4) * 220),
          y: Number(node?.y ?? 40 + Math.floor(index / 4) * 150),
          width: Number(node?.width ?? 180),
          height: Number(node?.height ?? 100),
          status: item.status,
        }
      }),
    )
    setOutputGroups(
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
    setActivities(
      (auditPage.items || []).map((row) => ({
        id: text(row.id),
        timestamp: text(row.occurred_at),
        severity: 'info',
        source: text(row.entity_type || 'Center'),
        eventType: text(row.event_type),
        message: `${text(row.event_type)} ${text(row.entity_type)}`.trim(),
        details: (row.after_json as Record<string, unknown>) || {},
        entityId: text(row.entity_id),
        entityType: text(row.entity_type),
      })),
    )
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
          messagesDropped: 0,
          lastError: text(row.last_error),
        })),
    )
  }, [])

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

  const revertToZero = async (confirm: string) => {
    await api('/api/v1/admin/revert-to-zero', {
      method: 'POST',
      body: JSON.stringify({ confirm }),
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

  const addResource = async (resource: ResourceFormValues) => {
    const typeKey = (resource.type || 'machine').toLowerCase()
    const name = resource.name || 'Resource'
    const code = resource.code
    const parent = allResources.find((item) => item.id === resource.parentId)
    const created = await createAsset(resource, parent)
    const edgeCreated = created.edge
    try {
      await refresh()
    } catch {
      created.warnings = [...(created.warnings || []), { code: 'REFRESH_FAILED', message: 'Resource was created, but the model could not refresh. Reload to see it.' }]
    }
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
      return { edgeCreated: true, edgeId: edgeCreated.id, edgeName: edgeCreated.name, enrollmentStatus: created.enrollmentStatus, enrollmentError: created.enrollmentError, warnings: created.warnings }
    }
    return { warnings: created.warnings }
  }

  const loadResourceEditor = async (id: string): Promise<ResourceEditorSnapshot> => {
    const row = await api<Record<string, unknown>>(`/api/v1/resources/${id}`)
    return { id: text(row.id), version: Number(row.version), name: text(row.name), code: text(row.code),
      type: text(row.type_key), parentId: row.parent_id ? text(row.parent_id) : undefined,
      description: text(row.description), properties: row.properties_json as Record<string, unknown> || {} }
  }

  const editResource = async (snapshot: ResourceEditorSnapshot, resource: ResourceFormValues) => {
    await api(`/api/v1/resources/${snapshot.id}`, { method: 'PATCH', body: JSON.stringify({
      version: snapshot.version, name: resource.name, code: resource.code, description: resource.description,
      properties: resource.properties,
    }) })
    await refresh()
  }

  const createResourceType = async (resourceType: ResourceTypeInput) => {
    const created = await api<ResourceTypeDefinition>('/api/v1/resource-types', { method: 'POST', body: JSON.stringify(resourceType) })
    setResourceTypes(current => [...current.filter(type => type.key !== created.key), created])
    return created
  }

  const moveResource = async (resourceId: string, newParentId: string | null, options?: { version?: number; hierarchyMode?: 'guided' | 'strict' }) => {
    const current = allResources.find((item) => item.id === resourceId)
    if (!current) return { success: false, error: 'Resource was not found.' }
    if (resourceId === newParentId) return { success: false, error: 'A resource cannot contain itself.' }
    try {
      const moved = await api<{ version: number; warnings?: Array<{ code: string; message: string }> }>(`/api/v1/resources/${resourceId}/move`, {
        method: 'POST',
        body: JSON.stringify({
          version: options?.version ?? Number(current.version || current.attributes?.version || 1),
          parent_id: newParentId,
          hierarchy_mode: options?.hierarchyMode || 'guided',
        }),
      })
      await refresh()
      return { success: true, version: moved.version, warnings: moved.warnings }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Move failed' }
    }
  }

  const archiveResource = async (resourceId: string, version: number) => {
    try {
      const archived = await api<{ version: number; deployments?: unknown[] }>(`/api/v1/resources/${resourceId}/archive`, {
        method: 'POST', body: JSON.stringify({ version }),
      })
      await refresh()
      if (selectedResourceId === resourceId) {
        setSelectedResourceId('')
      }
      return { success: true, version: archived.version, deploymentPending: Boolean(archived.deployments?.length) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Archive failed' }
    }
  }

  const restoreResource = async (resourceId: string, version: number) => {
    await api(`/api/v1/resources/${resourceId}/restore`, { method: 'POST', body: JSON.stringify({ version }) })
    await refresh()
    setSelectedResourceId(resourceId)
  }

  const updateLayoutNode = (id: string, updates: Partial<LayoutMachineNode>) => {
    setLayoutNodes((current) => {
      const next = current.map((node) => (node.id === id ? { ...node, ...updates } : node))
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
      })()
      return next
    })
  }

  const connectionConfig = (draft: AcquisitionDraft): Record<string, unknown> => {
    const port = Number(draft.port)
    const interval_ms = draft.intervalMs
    if (draft.protocol === 'modbus') {
      return { host: draft.host, port, unit_id: Number(draft.extra || 1), timeout_ms: 3000, retries: 1, interval_ms }
    }
    if (draft.protocol === 'opcua') {
      const endpoint = draft.host.startsWith('opc.tcp://') ? draft.host : `opc.tcp://${draft.host}:${port}`
      return { endpoint, security_mode: 'None', anonymous: true, interval_ms }
    }
    if (draft.protocol === 'mqtt') {
      const topic = draft.extra
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
    if (draft.protocol === 'mqtt' && !draft.extra) throw new Error('MQTT needs one topic.')
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

  const commissionAcquisition = async (connectionId: string, draft?: AcquisitionDraft) => {
    let queued: { job_id?: string; error_code?: string; message?: string; status?: string }
    try {
      queued = await api(`/api/v1/connections/${connectionId}/tests`, {
        method: 'POST', body: draft ? JSON.stringify({ fields: draft.fields.map(field => mappingContract(draft, field)) }) : undefined,
      })
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
      stages_json?: Array<{ stage: string; status: string; duration_ms?: number; detail?: string }>
    } = {}
    for (let attempt = 0; attempt < 48; attempt += 1) {
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
    const finalStatus = text(last.status)
    if (!['PASSED', 'FAILED', 'COMPLETED', 'ERROR'].includes(finalStatus)) {
      return {
        passed: false,
        stages: [
          ...(last.stages_json || []).map((stage) => ({
            name: stage.stage,
            status: stage.status,
            latency: stage.duration_ms,
          })),
          {
            name: 'TIMEOUT',
            status: 'FAILED',
            latency: undefined,
          },
        ],
      }
    }
    const stages = (last.stages_json || []).filter(stage => stage.stage === stage.stage.toUpperCase()).map((stage) => ({
      name: stage.stage,
      status: stage.status,
      latency: stage.duration_ms,
      detail: stage.detail,
    }))
    const passed = commissioningPassed(finalStatus, stages)
    return { passed, stages, errorCode: last.error_code }
  }

  const activateAcquisition = async (prepared: PreparedConnection, draft: AcquisitionDraft) => {
    await api('/api/v1/signals/bulk', {
      method: 'POST',
      body: JSON.stringify({
        resource_id: draft.resourceId,
        atomic: true,
        items: draft.fields.map((field) => ({
          key: codeFrom(field.name),
          name: field.name,
          data_type: mappingContract(draft, field).data_type,
          unit: field.unit,
          expected_interval_ms: draft.intervalMs,
          source_field: {
            acquisition_job_id: prepared.jobId,
            address_kind: draft.protocol === 'modbus' ? 'modbus_register' : draft.protocol,
            address: mappingContract(draft, field).address,
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
    try { await refresh() } catch { return { ...result, refreshFailed: true } }
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
    modelResources: allResources,
    modelSignals: signals,
    resourceTypes,
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
    loadResourceEditor,
    editResource,
    createResourceType,
    moveResource,
    archiveResource,
    restoreResource,
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
