import type { SignalItem } from '../../types'

export interface TrendPoint {
  at: number
  value: number
}

function observedValue(signal: SignalItem): unknown {
  return 'rawValue' in signal ? signal.rawValue : signal.currentValue
}

export function displayValue(signal: SignalItem): string {
  if (signal.hasObservation === false) return '—'
  const value = observedValue(signal)
  if (value === undefined) return '—'
  if (value === null) return 'null'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export function isNumericSignal(signal: SignalItem): boolean {
  return signal.canonicalType
    ? ['float64', 'int64', 'float32', 'int32', 'uint32', 'int16', 'uint16'].includes(signal.canonicalType)
    : ['analog', 'integer', 'calculated'].includes(signal.dataType)
}

/** Only observations seen while a signal is selected are retained, in memory. */
export class SessionTrends {
  private series = new Map<string, { points: TrendPoint[]; lastObservation?: string }>()
  private visible = new Map<string, TrendPoint[]>()

  constructor(private readonly maxPoints = 300) {
    if (!Number.isInteger(maxPoints) || maxPoints < 1) throw new RangeError('Choose a positive sample limit.')
  }

  select(ids: string[]): void {
    const wanted = new Set(ids)
    if (wanted.size > 4) throw new RangeError('Choose at most four signals.')
    for (const id of this.series.keys())
      if (!wanted.has(id)) {
        this.series.delete(id)
        this.visible.delete(id)
      }
    for (const id of wanted)
      if (!this.series.has(id)) {
        this.series.set(id, { points: [] })
        this.visible.set(id, [])
      }
  }

  observe(signals: SignalItem[], seenAt: number): void {
    for (const signal of signals) {
      const entry = this.series.get(signal.id)
      const value = observedValue(signal)
      if (!entry || !isNumericSignal(signal) || signal.hasObservation === false ||
          typeof value !== 'number' || !Number.isFinite(value) || !['GOOD', 'UNCERTAIN'].includes(signal.quality)) continue
      const observation =
        signal.observationId || [signal.lastUpdated, signal.receivedTime].filter(Boolean).join('|')
      if (!observation || entry.lastObservation === observation) continue
      entry.lastObservation = observation
      entry.points.push({ at: seenAt, value })
      if (entry.points.length > this.maxPoints) entry.points.splice(0, entry.points.length - this.maxPoints)
    }
  }

  snapshot(frozen = false): Record<string, TrendPoint[]> {
    if (!frozen) for (const [id, entry] of this.series) this.visible.set(id, [...entry.points])
    return Object.fromEntries(
      [...this.visible].map(([id, points]) => [id, points.map((point) => ({ ...point }))]),
    )
  }
}

export function formatTimestamp(value: string | undefined, timeZone?: string, short = false): string {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      ...(short ? {} : ({ year: 'numeric', month: 'short', day: '2-digit' } as const)),
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date)
  } catch {
    return date.toISOString()
  }
}

function csvCell(value: unknown): string {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (typeof value === 'string' && /^\s*[=+@-]/u.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

export function signalsCsv(signals: SignalItem[]): string {
  const rows: unknown[][] = [
    [
      'Tag',
      'Name',
      'Resource',
      'Connection',
      'Type',
      'Value',
      'Unit',
      'Quality',
      'Freshness',
      'Event time',
      'Source time',
      'Received time',
    ],
  ]
  for (const signal of signals)
    rows.push([
      signal.tag,
      signal.name,
      signal.resourcePath,
      signal.sourceConnectionName,
      signal.canonicalType || signal.dataType,
      signal.hasObservation === false ? '' : observedValue(signal) === null ? 'null' : observedValue(signal),
      signal.unit || '',
      signal.quality,
      signal.freshness || 'UNKNOWN',
      signal.lastUpdated,
      signal.sourceTime || '',
      signal.receivedTime || '',
    ])
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
}
