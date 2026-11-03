import React, { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../common/Button'
import { Dialog } from '../common/Dialog'
import type { ResourceNode } from '../../types'
import { translateApiError } from '../../utils/apiErrors'
import { codePreviewFromName, validateResourceName } from '../../utils/resourceHierarchy'
import { propertyRows, propertyValues, recommendedType, resourcePathLabel } from '../../features/assets/model'
import type {
  PropertyKind,
  PropertyRow,
  ResourceEditorSnapshot,
  ResourceFormValues,
  ResourceTypeDefinition,
  ResourceTypeInput,
  LocalApplianceStatus,
} from '../../features/assets/model'

export interface AddResourceModalProps {
  isOpen: boolean
  onClose: () => void
  resources: ResourceNode[]
  resourceTypes: ResourceTypeDefinition[]
  parentId?: string
  initialResource?: ResourceEditorSnapshot
  onSave: (values: ResourceFormValues) => Promise<void>
  onCreateType?: (values: ResourceTypeInput) => Promise<ResourceTypeDefinition>
  appliance?: LocalApplianceStatus | null
  applianceError?: string
}

const labelClass = 'mb-1 block text-xs font-semibold text-[var(--fx-body)]'
const categories = ['ENTERPRISE', 'SITE', 'AREA', 'WORK_CENTER', 'ASSET', 'POSITION', 'CUSTOM']

export const AddResourceModal: React.FC<AddResourceModalProps> = ({
  isOpen,
  onClose,
  resources,
  resourceTypes,
  parentId,
  initialResource,
  onSave,
  onCreateType,
  appliance,
  applianceError,
}) => {
  const editing = Boolean(initialResource)
  const initialParent = initialResource?.parentId ?? parentId
  const defaultType = () => {
    const parent = resources.find((resource) => resource.id === initialParent)
    return (
      initialResource?.type ||
      resourceTypes.find((type) => recommendedType(type, parent?.type))?.key ||
      resourceTypes[0]?.key ||
      ''
    )
  }
  const [name, setName] = useState(initialResource?.name || '')
  const [code, setCode] = useState(initialResource?.code || '')
  const [codeEdited, setCodeEdited] = useState(editing)
  const [typeKey, setTypeKey] = useState(defaultType)
  const [targetParent, setTargetParent] = useState(initialParent || '')
  const [description, setDescription] = useState(initialResource?.description || '')
  const [rows, setRows] = useState<PropertyRow[]>(() => propertyRows(initialResource?.properties || {}))
  const [strict, setStrict] = useState(false)
  const [timezone, setTimezone] = useState('Asia/Ho_Chi_Minh')
  const [useAppliance, setUseAppliance] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [newTypeKey, setNewTypeKey] = useState('')
  const [newTypeName, setNewTypeName] = useState('')
  const [newTypeCategory, setNewTypeCategory] = useState('CUSTOM')
  const [creatingType, setCreatingType] = useState(false)
  const [typeError, setTypeError] = useState('')
  const [createdTypes, setCreatedTypes] = useState<ResourceTypeDefinition[]>([])

  // Pin the form on open/object identity, never reset an unsaved draft during polling.
  useEffect(() => {
    if (!isOpen) return
    setName(initialResource?.name || '')
    setCode(initialResource?.code || '')
    setCodeEdited(Boolean(initialResource))
    setTypeKey(defaultType())
    setTargetParent(initialParent || '')
    setDescription(initialResource?.description || '')
    setRows(propertyRows(initialResource?.properties || {}))
    setStrict(false)
    setTimezone('Asia/Ho_Chi_Minh')
    setUseAppliance(false)
    setError('')
    setSubmitting(false)
    setNewTypeKey('')
    setNewTypeName('')
    setTypeError('')
    setCreatedTypes([])
  }, [isOpen, initialResource?.id])

  useEffect(() => {
    setUseAppliance(false)
  }, [typeKey])
  useEffect(() => {
    if (!appliance?.available) setUseAppliance(false)
  }, [appliance?.available])

  const parent = resources.find((resource) => resource.id === targetParent)
  const types = useMemo(
    () =>
      Array.from(new Map([...resourceTypes, ...createdTypes].map((type) => [type.key, type])).values()).sort(
        (a, b) =>
          Number(recommendedType(b, parent?.type)) - Number(recommendedType(a, parent?.type)) ||
          a.name.localeCompare(b.name),
      ),
    [resourceTypes, createdTypes, parent?.type],
  )
  useEffect(() => {
    if (!typeKey && types.length) setTypeKey(types[0].key)
  }, [typeKey, types])
  const selectedType = types.find((type) => type.key === typeKey)
  const typeGroups = [
    { label: 'Recommended', items: types.filter((type) => recommendedType(type, parent?.type)) },
    ...categories.map((category) => ({
      label: category.replace(/_/g, ' '),
      items: types.filter((type) => type.category === category && !recommendedType(type, parent?.type)),
    })),
  ].filter((group) => group.items.length)
  const isRecommended = selectedType ? recommendedType(selectedType, parent?.type) : false
  const actualCode = codeEdited ? code : codePreviewFromName(name)
  const busy = submitting || creatingType

  const updateRow = (index: number, update: Partial<PropertyRow>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...update } : row)))
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    const nameError = validateResourceName(name)
    if (nameError) {
      setError(nameError)
      return
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(actualCode.trim())) {
      setError(
        'Resource code must be 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.',
      )
      return
    }
    if (!selectedType) {
      setError('Select a resource type.')
      return
    }
    if (!editing && strict && !isRecommended) {
      setError('Choose a recommended placement or turn off Strict hierarchy.')
      return
    }
    setError('')
    setSubmitting(true)
    try {
      await onSave({
        name: name.trim(),
        code: actualCode.trim(),
        type: typeKey,
        parentId: targetParent || undefined,
        description,
        properties: propertyValues(rows),
        hierarchyMode: strict ? 'strict' : 'guided',
        timezone,
        useAppliance: typeKey === 'site' && useAppliance && Boolean(appliance?.available),
      })
      onClose()
    } catch (caught) {
      setError(translateApiError(caught))
    } finally {
      setSubmitting(false)
    }
  }
  const createType = async () => {
    if (!onCreateType) return
    if (!newTypeName.trim() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(newTypeKey.trim())) {
      setTypeError(
        'Enter a type name and a valid key of at most 64 letters, digits, dots, underscores or hyphens.',
      )
      return
    }
    setCreatingType(true)
    setTypeError('')
    try {
      const created = await onCreateType({
        key: newTypeKey.trim().toLowerCase(),
        name: newTypeName.trim(),
        category: newTypeCategory,
        parent_type_keys: parent ? [parent.type] : [],
        child_type_keys: [],
      })
      setCreatedTypes((current) => [...current, created])
      setTypeKey(created.key)
      setNewTypeKey('')
      setNewTypeName('')
    } catch (caught) {
      setTypeError(translateApiError(caught))
    } finally {
      setCreatingType(false)
    }
  }

  return (
    <Dialog isOpen={isOpen} onClose={onClose} busy={busy} title={editing ? 'Edit resource' : 'Add resource'}>
      <form onSubmit={(event) => void save(event)} className="space-y-5 p-6 text-sm">
        <fieldset disabled={busy} className="space-y-5">
          <div>
            <label className={labelClass} htmlFor="resource-parent">
              Parent
            </label>
            <select
              id="resource-parent"
              className="fx-input"
              value={targetParent}
              disabled={editing}
              onChange={(event) => setTargetParent(event.target.value)}
            >
              <option value="">Root level</option>
              {resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resourcePathLabel(resources, resource.id)}
                </option>
              ))}
            </select>
            {editing ? (
              <p className="mt-1 text-xs text-[var(--fx-muted)]">
                Use Move to change the parent and review its impact.
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="resource-name">
                Display name
              </label>
              <input
                id="resource-name"
                className="fx-input"
                required
                maxLength={200}
                value={name}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-[var(--fx-muted)] tabular-nums">{name.length}/200</p>
            </div>
            <div>
              <label className={labelClass} htmlFor="resource-code">
                Resource code
              </label>
              <input
                id="resource-code"
                className="fx-input font-mono"
                required
                maxLength={64}
                value={actualCode}
                onChange={(event) => {
                  setCodeEdited(true)
                  setCode(event.target.value)
                }}
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-[var(--fx-muted)]">
                Unique under this parent. Source addresses stay unchanged.
              </p>
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="resource-type">
              Resource type
            </label>
            <select
              id="resource-type"
              className="fx-input"
              value={typeKey}
              disabled={editing}
              onChange={(event) => setTypeKey(event.target.value)}
            >
              {!types.length ? <option value="">Resource types are unavailable</option> : null}
              {typeGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.items.map((type) => (
                    <option key={type.key} value={type.key}>
                      {type.name}
                      {recommendedType(type, parent?.type) ? ' · Recommended' : ''}
                      {!type.is_system ? ' · Custom' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {!editing ? (
              <>
                <label className="mt-3 flex items-center gap-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={strict}
                    onChange={(event) => setStrict(event.target.checked)}
                  />{' '}
                  Strict hierarchy
                </label>
                {!isRecommended && selectedType ? (
                  <p
                    role="status"
                    className="mt-2 rounded-lg bg-[var(--fx-warning-soft)] p-3 text-xs text-amber-900"
                  >
                    This placement is outside the recommended hierarchy. Guided mode allows it; Site
                    boundaries and cycle checks still apply.
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          {!editing && typeKey === 'site' ? (
            <div>
              <label className={labelClass} htmlFor="resource-timezone">
                Site timezone
              </label>
              <input
                id="resource-timezone"
                className="fx-input"
                required
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              />
              <p className="mt-1 text-xs text-[var(--fx-muted)]">
                IANA timezone, for example Asia/Ho_Chi_Minh or UTC. An Edge is created with the Site.
              </p>
              <label className="mt-3 flex items-center gap-2 text-xs font-medium">
                <input
                  type="checkbox"
                  name="useAppliance"
                  checked={useAppliance}
                  disabled={!appliance?.available}
                  onChange={(event) => setUseAppliance(event.target.checked)}
                />
                Use this appliance for this Site
              </label>
              <p className="mt-1 text-xs text-[var(--fx-muted)]">
                {applianceError
                  ? 'Appliance availability could not be verified. You can create the Site and enroll its Edge later.'
                  : !appliance
                    ? 'Checking local appliance availability…'
                    : !appliance.enabled
                      ? 'Local appliance enrollment is unavailable here. Enroll the Edge separately.'
                      : appliance.available
                        ? 'Optional. Enrollment is requested only when this option is selected.'
                        : appliance.state === 'CONFLICT'
                          ? 'The local appliance identity needs attention in Edge Collectors before enrollment.'
                          : 'This appliance is already assigned. Create the Site independently and manage its collector in Edge Collectors.'}
              </p>
            </div>
          ) : null}
          <div>
            <label className={labelClass} htmlFor="resource-description">
              Description
            </label>
            <textarea
              id="resource-description"
              className="fx-input"
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <section aria-label="Resource properties">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold">Properties</h3>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                icon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setRows((current) => [...current, { key: '', value: '', kind: 'string' }])}
              >
                Add property
              </Button>
            </div>
            {!rows.length ? <p className="text-xs text-[var(--fx-muted)]">No properties declared.</p> : null}
            <div className="space-y-3">
              {rows.map((row, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[minmax(0,1fr)_7rem_2rem] gap-2 rounded-lg border border-[var(--fx-border)] p-3"
                >
                  <input
                    className="fx-input min-w-0"
                    aria-label={`Property ${index + 1} name`}
                    placeholder="Property name"
                    value={row.key}
                    onChange={(event) => updateRow(index, { key: event.target.value })}
                  />
                  <select
                    className="fx-input"
                    aria-label={`Property ${index + 1} type`}
                    value={row.kind}
                    onChange={(event) =>
                      updateRow(index, {
                        kind: event.target.value as PropertyKind,
                        value:
                          event.target.value === 'null'
                            ? 'null'
                            : event.target.value === 'boolean'
                              ? 'false'
                              : row.value,
                      })
                    }
                  >
                    <option value="string">Text</option>
                    <option value="number">Number</option>
                    <option value="boolean">Boolean</option>
                    <option value="null">Null</option>
                    <option value="json">JSON</option>
                  </select>
                  <Button
                    type="button"
                    variant="ghost"
                    className="!p-0"
                    aria-label={`Remove property ${index + 1}`}
                    onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
                    icon={<Trash2 className="h-4 w-4" />}
                  />
                  <div className="col-span-3">
                    {row.kind === 'boolean' ? (
                      <select
                        className="fx-input"
                        aria-label={`Property ${index + 1} value`}
                        value={row.value}
                        onChange={(event) => updateRow(index, { value: event.target.value })}
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : row.kind === 'json' ? (
                      <textarea
                        className="fx-input font-mono"
                        rows={2}
                        aria-label={`Property ${index + 1} value`}
                        value={row.value}
                        onChange={(event) => updateRow(index, { value: event.target.value })}
                      />
                    ) : (
                      <input
                        className="fx-input"
                        aria-label={`Property ${index + 1} value`}
                        value={row.value}
                        disabled={row.kind === 'null'}
                        onChange={(event) => updateRow(index, { value: event.target.value })}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
          {!editing && onCreateType ? (
            <details className="rounded-lg border border-[var(--fx-border)] p-3">
              <summary className="cursor-pointer text-xs font-semibold">New resource type</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className={labelClass}>
                  Type name
                  <input
                    className="fx-input mt-1"
                    maxLength={200}
                    value={newTypeName}
                    onChange={(event) => setNewTypeName(event.target.value)}
                  />
                </label>
                <label className={labelClass}>
                  Type key
                  <input
                    className="fx-input mt-1 font-mono"
                    maxLength={64}
                    value={newTypeKey}
                    onChange={(event) => setNewTypeKey(event.target.value)}
                  />
                </label>
                <label className={labelClass}>
                  Category
                  <select
                    className="fx-input mt-1"
                    value={newTypeCategory}
                    onChange={(event) => setNewTypeCategory(event.target.value)}
                  >
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {category.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="self-end">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void createType()}
                    loading={creatingType}
                  >
                    Create type
                  </Button>
                </div>
              </div>
              <p className="mt-2 text-xs text-[var(--fx-muted)]">
                The selected parent's type becomes a recommended parent. The new type is available throughout
                the model.
              </p>
              {typeError ? (
                <p role="alert" className="mt-2 text-xs text-[var(--fx-error)]">
                  {typeError}
                </p>
              ) : null}
            </details>
          ) : null}
        </fieldset>
        {error ? (
          <p role="alert" className="rounded-lg bg-[var(--fx-error-soft)] p-3 text-xs text-[var(--fx-error)]">
            {error}
          </p>
        ) : null}
        <footer className="flex justify-end gap-3 border-t border-[var(--fx-border)] pt-4">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={busy || !selectedType}>
            {editing ? 'Save changes' : 'Create resource'}
          </Button>
        </footer>
      </form>
    </Dialog>
  )
}
