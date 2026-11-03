import React, { useEffect, useState } from 'react'
import { Button } from '../common/Button'
import { Dialog } from '../common/Dialog'
import type { ResourceNode } from '../../types'
import type { ResourceTypeDefinition } from '../../features/assets/model'
import { recommendedType, resourcePathLabel } from '../../features/assets/model'
import { descendantIds } from '../../utils/resourceHierarchy'
import { translateApiError } from '../../utils/apiErrors'

export interface MoveResourceModalProps {
  isOpen: boolean
  onClose: () => void
  selectedResource: ResourceNode
  allResources: ResourceNode[]
  resourceTypes: ResourceTypeDefinition[]
  onMoveResource: (
    parentId: string | null,
    hierarchyMode: 'guided' | 'strict',
  ) => Promise<{ success: boolean; error?: string }>
}

export const MoveResourceModal: React.FC<MoveResourceModalProps> = ({
  isOpen,
  onClose,
  selectedResource,
  allResources,
  resourceTypes,
  onMoveResource,
}) => {
  const [targetId, setTargetId] = useState(selectedResource.parentId || '')
  const [strict, setStrict] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!isOpen) return
    setTargetId(selectedResource.parentId || '')
    setStrict(false)
    setBusy(false)
    setError('')
  }, [isOpen, selectedResource.id])
  const blocked = descendantIds(allResources, selectedResource.id)
  const candidates = allResources.filter(
    (resource) => !blocked.has(resource.id) && resource.lifecycle !== 'ARCHIVED',
  )
  const target = candidates.find((resource) => resource.id === targetId)
  const type = resourceTypes.find((type) => type.key === selectedResource.type)
  const recommended = type ? recommendedType(type, target?.type) : false
  const currentLabel = selectedResource.parentId
    ? resourcePathLabel(allResources, selectedResource.parentId)
    : 'Root level'
  const move = async () => {
    if (targetId && !target) {
      setError('This destination is no longer available. Select another parent.')
      return
    }
    if (strict && !recommended) {
      setError('Choose a recommended placement or turn off Strict hierarchy.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await onMoveResource(targetId || null, strict ? 'strict' : 'guided')
      if (!result.success) {
        setError(result.error || 'Move failed.')
        return
      }
      onClose()
    } catch (caught) {
      setError(translateApiError(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog isOpen={isOpen} onClose={onClose} busy={busy} title={`Move "${selectedResource.name}"`}>
      <div className="space-y-4 p-6 text-sm">
        <p className="break-words text-xs text-[var(--fx-muted)]">Current parent: {currentLabel}</p>
        <label className="block text-xs font-semibold" htmlFor="move-resource-parent">
          New parent
        </label>
        <select
          id="move-resource-parent"
          className="fx-input"
          value={targetId}
          disabled={busy}
          onChange={(event) => setTargetId(event.target.value)}
        >
          <option value="">Root level{type && recommendedType(type) ? ' · Recommended' : ''}</option>
          {candidates.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resourcePathLabel(allResources, resource.id)}
              {type && recommendedType(type, resource.type) ? ' · Recommended' : ''}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={strict}
            disabled={busy}
            onChange={(event) => setStrict(event.target.checked)}
          />
          Strict hierarchy
        </label>
        {!recommended ? (
          <p className="rounded-lg bg-[var(--fx-warning-soft)] p-3 text-xs text-amber-900">
            This destination is outside the recommended hierarchy. Guided mode allows flexible placement.
          </p>
        ) : null}
        <p className="text-xs leading-relaxed text-[var(--fx-muted)]">
          The subtree and its paths move together. Source topics and addresses stay unchanged. A different
          Site requires source mappings to be reassigned or detached first.
        </p>
        {error ? (
          <p role="alert" className="rounded-lg bg-[var(--fx-error-soft)] p-3 text-xs text-[var(--fx-error)]">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-3 border-t border-[var(--fx-border)] pt-4">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void move()}
            loading={busy}
            disabled={busy || targetId === (selectedResource.parentId || '')}
          >
            Confirm move
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
