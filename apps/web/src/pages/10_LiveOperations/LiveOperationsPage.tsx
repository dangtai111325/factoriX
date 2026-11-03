import React, { useEffect, useMemo, useState } from 'react'
import { Download, Pause, Play, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '../../components/common/Button'
import { Card } from '../../components/common/Card'
import { Badge } from '../../components/common/Badge'
import { LineChart } from '../../components/charts/LineChart'
import { useApp } from '../../store/AppContext'
import type { ActivityEvent, ConnectionItem, SignalItem } from '../../types'
import {
  displayValue,
  formatTimestamp,
  isNumericSignal,
  SessionTrends,
  signalsCsv,
  type TrendPoint,
} from '../../features/monitor/session'

const protocolNames = { modbus: 'Modbus TCP', opcua: 'OPC UA', mqtt: 'MQTT', http: 'HTTP API' }

export const LiveOperationsPage: React.FC = () => {
  const { scopedSignals, scopedConnections, scopedResources, activities, currentPlant, refresh } = useApp()
  const scopeIds = new Set(
    [...scopedResources, ...scopedSignals, ...scopedConnections].map((item) => item.id),
  )
  const scopeEvents = currentPlant.id
    ? activities.filter((event) => event.entityId && scopeIds.has(event.entityId))
    : activities
  return (
    <LiveOperationsView
      signals={scopedSignals}
      connections={scopedConnections}
      activities={scopeEvents}
      onRefresh={refresh}
    />
  )
}

const TrendCard = React.memo(
  ({ signal, points, color }: { signal: SignalItem; points: TrendPoint[]; color: string }) => {
    const data = useMemo(
      () =>
        points.map((point) => ({
          time: formatTimestamp(new Date(point.at).toISOString(), signal.timezone, true),
          value: point.value,
          at: point.at,
        })),
      [points, signal.timezone],
    )
    const values = points.map((point) => point.value)
    const summary = values.length
      ? {
          min: Math.min(...values),
          max: Math.max(...values),
          avg: values.reduce((total, value) => total + value, 0) / values.length,
        }
      : null
    return (
      <section
        className="rounded-lg border border-[#E3EAF3] p-3 space-y-2"
        aria-label={`Trend: ${signal.name} · ${signal.resourcePath}`}
      >
        <div className="flex justify-between gap-3 text-[12px]">
          <div className="min-w-0">
            <p className="font-bold text-[#111B37]">{signal.name}</p>
            <p className="text-[#657794] truncate" title={signal.resourcePath}>
              {signal.resourcePath}
            </p>
          </div>
          <div className="text-right space-y-1 shrink-0"><span className="text-[#657794] block">{signal.unit || 'No unit'}</span><Badge variant={signal.quality === 'BAD' ? 'error' : signal.quality === 'GOOD' ? 'good' : 'warning'}>{signal.quality}</Badge></div>
        </div>
        {data.length ? (
          <LineChart data={data} unit={signal.unit || ''} strokeColor={color} height={170} />
        ) : (
          <p className="text-[12px] text-[#657794] py-6">Waiting for a numeric observation.</p>
        )}
        {summary && (
          <p className="text-[11px] text-[#657794] tabular-nums">
            Displayed samples: {points.length} · Min {summary.min.toLocaleString()} · Avg{' '}
            {Number(summary.avg.toPrecision(6)).toLocaleString()} · Max {summary.max.toLocaleString()}
          </p>
        )}
      </section>
    )
  },
)

function signalFreshness(signal: SignalItem, now: number): string {
  if (signal.hasObservation === false) return 'UNKNOWN'
  const timestamp = Date.parse(signal.lastUpdated)
  if (Number.isFinite(timestamp) && now - timestamp > Math.max(signal.sampleIntervalMs, 1) * 2) return 'STALE'
  return signal.freshness || 'UNKNOWN'
}

export const LiveOperationsView: React.FC<{
  signals: SignalItem[]
  connections?: ConnectionItem[]
  activities?: ActivityEvent[]
  onRefresh?: () => Promise<void>
}> = ({ signals, connections = [], activities = [], onRefresh }) => {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [selectedTrends, setSelectedTrends] = useState<string[]>([])
  const [trends] = useState(() => new SessionTrends())
  const [plotted, setPlotted] = useState<Record<string, TrendPoint[]>>({})
  const [frozen, setFrozen] = useState(false)
  const [pageIndex, setPageIndex] = useState(0)
  const [notice, setNotice] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    const wanted = selectedTrends.filter((id) =>
      signals.some((signal) => signal.id === id && isNumericSignal(signal)),
    )
    if (wanted.length !== selectedTrends.length) setSelectedTrends(wanted)
    trends.select(wanted)
    trends.observe(signals, Date.now())
    setPlotted(trends.snapshot(frozen))
  }, [signals, selectedTrends, frozen, trends])

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return signals.filter(
      (signal) =>
        !needle ||
        [signal.name, signal.tag, signal.resourcePath, signal.sourceConnectionName].some((value) =>
          value.toLocaleLowerCase().includes(needle),
        ),
    )
  }, [signals, query])
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50))
  const page = Math.min(pageIndex, pageCount - 1)
  const rows = filtered.slice(page * 50, (page + 1) * 50)
  const inspected = filtered.find((signal) => signal.id === selectedId) || rows[0]
  const healthyConnections = connections.filter((connection) => connection.status === 'connected').length
  const good = signals.filter((signal) => signal.quality === 'GOOD').length
  const bad = signals.filter((signal) => signal.quality === 'BAD').length
  const uncertain = signals.filter((signal) => signal.quality === 'UNCERTAIN').length
  const stale = signals.filter((signal) => signalFreshness(signal, now) === 'STALE').length

  const toggleTrend = (id: string) =>
    setSelectedTrends((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : previous.length < 4
          ? [...previous, id]
          : previous,
    )
  const exportCsv = () => {
    const url = URL.createObjectURL(
      new Blob(['\uFEFF', signalsCsv(filtered)], { type: 'text/csv;charset=utf-8' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `factorix-latest-${new Date().toISOString().replace(/:/g, '-')}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    setNotice(`CSV prepared for ${filtered.length} signals.`)
  }
  const refresh = async () => {
    if (!onRefresh) return
    setRefreshing(true)
    try {
      await onRefresh()
      setNotice('Latest values refreshed.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not refresh values.')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="fx-page-title">Live Acquisition Monitor</h1>
          <p className="fx-page-subtitle">Latest collected values for the selected factory scope.</p>
        </div>
        <div className="flex gap-2">
          {onRefresh && (
            <Button
              variant="secondary"
              icon={<RefreshCw className="w-4 h-4" />}
              loading={refreshing}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<Download className="w-4 h-4" />}
            disabled={!filtered.length}
            onClick={exportCsv}
          >
            Export CSV
          </Button>
        </div>
      </div>
      {notice && (
        <p role="status" className="text-[12px] text-[#334568]">
          {notice}
        </p>
      )}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {[
          ['Signals in scope', signals.length, 'Configured signals'],
          ['Good quality', good, `${uncertain} uncertain · ${bad} bad`],
          ['Stale values', stale, 'Based on each expected update interval'],
          [
            'Connections healthy',
            `${healthyConnections}/${connections.length}`,
            'Health reported by the collector',
          ],
        ].map(([label, value, hint]) => (
          <div key={label} className="fx-card p-4">
            <p className="text-[12px] text-[#657794]">{label}</p>
            <p className="text-2xl font-bold text-[#111B37] tabular-nums mt-1">{value}</p>
            <p className="text-[11px] text-[#657794] mt-1">{hint}</p>
          </div>
        ))}
      </div>
      <Card
        title={`Latest values (${filtered.length})`}
        headerClassName="flex-wrap gap-3"
        action={
          <label className="relative block">
            <span className="sr-only">Filter signals</span>
            <Search className="absolute w-3.5 h-3.5 left-2.5 top-2.5 text-[#657794]" />
            <input
              className="fx-input pl-8 max-w-52"
              placeholder="Filter signals…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPageIndex(0)
              }}
            />
          </label>
        }
      >
        <div className="overflow-x-auto">
          <table className="fx-table">
            <thead>
              <tr>
                <th>Trend</th>
                <th>Signal</th>
                <th>Resource</th>
                <th>Connection</th>
                <th>Latest value</th>
                <th>Quality</th>
                <th>Freshness</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((signal) => (
                <tr key={signal.id} className={inspected?.id === signal.id ? 'bg-[#FFF0F1]' : ''}>
                  <td>
                    {isNumericSignal(signal) ? (
                      <input
                        type="checkbox"
                        aria-label={`Trend ${signal.name} · ${signal.resourcePath}`}
                        checked={selectedTrends.includes(signal.id)}
                        disabled={!selectedTrends.includes(signal.id) && selectedTrends.length >= 4}
                        onChange={() => toggleTrend(signal.id)}
                      />
                    ) : (
                      <span className="text-[#657794]" title="Trends require numeric values.">
                        —
                      </span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="text-left font-semibold text-[#111B37] hover:underline"
                      onClick={() => setSelectedId(signal.id)}
                    >
                      {signal.name}
                      <span className="block text-[11px] font-mono font-normal text-[#657794]">
                        {signal.tag}
                      </span>
                    </button>
                  </td>
                  <td className="text-[12px] text-[#657794]">{signal.resourcePath}</td>
                  <td className="text-[12px] text-[#657794]">
                    {signal.sourceConnectionName || 'Not linked'}
                    {signal.sourceProtocol && <span className="block mt-1"><Badge variant={signal.sourceProtocol}>{protocolNames[signal.sourceProtocol]}</Badge></span>}
                  </td>
                  <td className="font-mono tabular-nums max-w-72">
                    <span className="break-words whitespace-pre-wrap">{displayValue(signal)}</span>
                    {signal.unit && <span className="text-[#657794] ml-1">{signal.unit}</span>}
                  </td>
                  <td>
                    <Badge
                      variant={
                        signal.quality === 'GOOD'
                          ? 'good'
                          : signal.quality === 'BAD'
                            ? 'error'
                            : signal.quality === 'UNKNOWN'
                              ? 'neutral'
                              : 'warning'
                      }
                    >
                      {signal.quality}
                    </Badge>
                  </td>
                  <td>
                    <Badge
                      variant={
                        signalFreshness(signal, now) === 'FRESH'
                          ? 'good'
                          : signalFreshness(signal, now) === 'STALE'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {signalFreshness(signal, now)}
                    </Badge>
                  </td>
                  <td
                    className="text-[11px] text-[#657794] whitespace-nowrap"
                    title={`${signal.receivedTime || signal.lastUpdated} · ${signal.timezone || 'Browser timezone'}`}
                  >
                    {formatTimestamp(signal.receivedTime || signal.lastUpdated, signal.timezone)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <p className="text-[13px] text-[#657794] py-6 text-center">
            {signals.length
              ? 'No signals match this search.'
              : 'No signals yet. They appear here after a connection is activated.'}
          </p>
        )}
        {filtered.length > 0 && (
          <div className="flex flex-wrap justify-between items-center gap-2 pt-3 text-[12px] text-[#657794]">
            <span>
              Showing {page * 50 + 1}–{Math.min((page + 1) * 50, filtered.length)} of {filtered.length}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={page === 0}
                onClick={() => setPageIndex(page - 1)}
              >
                Previous
              </Button>
              <span>
                {page + 1} / {pageCount}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={page + 1 === pageCount}
                onClick={() => setPageIndex(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <div className="space-y-4 min-w-0">
          {inspected && (
            <Card title={`Signal Inspector: ${inspected.name}`}>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-[12px]">
                {[
                  ['Resource', inspected.resourcePath],
                  ['Connection', inspected.sourceConnectionName || 'Not linked'],
                  ['Protocol', inspected.sourceProtocol ? protocolNames[inspected.sourceProtocol] : '—'],
                  ['Type', inspected.canonicalType || inspected.dataType],
                  ['Latest value', `${displayValue(inspected)}${inspected.unit ? ` ${inspected.unit}` : ''}`],
                  ['Quality', inspected.quality],
                  ['Freshness', signalFreshness(inspected, now)],
                  ['Source time', formatTimestamp(inspected.sourceTime, inspected.timezone)],
                  ['Received time', formatTimestamp(inspected.receivedTime, inspected.timezone)],
                  ['Expected interval', `${inspected.sampleIntervalMs} ms`],
                  [
                    'Last good value',
                    displayValue({
                      ...inspected,
                      rawValue: inspected.lastGoodValue,
                      hasObservation: inspected.lastGoodValue !== undefined,
                    }),
                  ],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-[#657794] mb-1">{label}</dt>
                    <dd className="text-[#111B37] font-medium break-words whitespace-pre-wrap">{value}</dd>
                  </div>
                ))}
              </dl>
              {inspected.sourceAddress && <details className="mt-4 text-[12px] text-[#657794]"><summary className="cursor-pointer">Source mapping</summary><pre className="whitespace-pre-wrap break-all font-mono mt-2">{JSON.stringify(inspected.sourceAddress, null, 2)}</pre></details>}
              {inspected.qualityReason && (
                <p className="text-[12px] text-[#B96B00] mt-4">{inspected.qualityReason}</p>
              )}
            </Card>
          )}
          <Card title="Recent events in this scope">
            {activities.length ? (
              <ul className="space-y-3">
                {activities.slice(0, 5).map((event) => (
                  <li key={event.id} className="text-[12px] space-y-1">
                    <div className="flex items-start gap-2">
                      <Badge
                        variant={
                          event.severity === 'error'
                            ? 'error'
                            : event.severity === 'warning'
                              ? 'warning'
                              : 'info'
                        }
                      >
                        {event.severity.toUpperCase()}
                      </Badge>
                      <span className="text-[#334568] break-words">{event.message}</span>
                    </div>
                    <time dateTime={event.timestamp} className="text-[11px] text-[#657794]">
                      {formatTimestamp(event.timestamp)}
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-[#657794]">No recorded events in this scope.</p>
            )}
          </Card>
        </div>
        <Card
          title={`Session trends (${selectedTrends.length}/4)`}
          action={
            <Button
              size="sm"
              variant="secondary"
              icon={frozen ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              disabled={!selectedTrends.length}
              onClick={() => setFrozen((value) => !value)}
            >
              {frozen ? 'Resume charts' : 'Freeze charts'}
            </Button>
          }
        >
          <p className="text-[12px] text-[#657794] mb-3">
            Trends start when you select a signal. They keep the latest 300 updates observed in this session.
            Freezing charts keeps the latest-values table updating.
          </p>
          <div className="space-y-3">
            {selectedTrends.map((id, index) => {
              const signal = signals.find((item) => item.id === id)
              return signal ? (
                <div key={id}>
                  <div className="flex justify-end mb-1">
                    <button
                      type="button"
                      className="text-[11px] text-[#657794] flex items-center gap-1 hover:text-[#EF1B24]"
                      aria-label={`Remove trend ${signal.name} · ${signal.resourcePath}`}
                      onClick={() => toggleTrend(id)}
                    >
                      <X className="w-3 h-3" />
                      Remove
                    </button>
                  </div>
                  <TrendCard
                    signal={signal}
                    points={plotted[id] || []}
                    color={['#EF1B24', '#2A82E7', '#0A9855', '#B96B00'][index]}
                  />
                </div>
              ) : null
            })}
          </div>
          {!selectedTrends.length && (
            <p className="text-[12px] text-[#657794] py-6 text-center">
              Select up to four numeric signals in the table to compare them.
            </p>
          )}
        </Card>
      </div>
    </div>
  )
}
