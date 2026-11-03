import React from 'react'
import { Link } from 'react-router-dom'
import { Braces, Layers, ArrowRight } from 'lucide-react'
import { useApp } from '../../store/AppContext'
import { Card } from '../../components/common/Card'

export const ModelCatalogPage: React.FC = () => {
  const { outputGroups } = useApp()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="fx-page-title">Model Catalog</h1>
        <p className="fx-page-subtitle">Manage structured outputs built from collected signals.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-4 p-5">
          <Layers aria-hidden="true" className="h-6 w-6 text-[var(--fx-muted)]" />
          <div>
            <h2 className="text-base font-bold">Output Groups</h2>
            <p className="mt-1 text-sm text-[var(--fx-muted)]">
              Group signals, configure field aliases and preview JSON payloads.
            </p>
          </div>
          <p className="text-sm">
            {outputGroups.length} configured group{outputGroups.length === 1 ? '' : 's'}
          </p>
          <Link
            to="/models/output-groups"
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--fx-border)] px-4 py-2 text-sm font-semibold"
          >
            Open Output Groups <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </Card>
        <Card className="space-y-4 p-5">
          <Braces aria-hidden="true" className="h-6 w-6 text-[var(--fx-muted)]" />
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-bold">Design & Preview</h2>
          </div>
          <p className="text-sm text-[var(--fx-muted)]">
            Configure output groups and inspect their current JSON values, quality and timestamps.
          </p>
          <p className="text-xs text-[var(--fx-muted)]">External publishing is not available.</p>
          <div className="flex flex-wrap gap-3">
            <Link
              to="/models/designer"
              className="rounded-lg border border-[var(--fx-border)] px-3 py-2 text-sm font-semibold"
            >
              Model Designer
            </Link>
            <Link
              to="/models/live-preview"
              className="rounded-lg border border-[var(--fx-border)] px-3 py-2 text-sm font-semibold"
            >
              Live Preview
            </Link>
          </div>
        </Card>
      </div>
    </div>
  )
}
