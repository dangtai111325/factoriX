import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, FolderPlus, AlertCircle } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import { ResourceNode } from '../../types';
import { translateApiError } from '../../utils/apiErrors';
import { slugifyResourceCode } from '../../utils/slugify';
import { allowedChildTypes, buildResourceTree, HierarchyTreeNode } from '../../utils/resourceHierarchy';
import { resourceTypeLabel } from '../common/ResourceTypeIcon';
import { useDialogA11y } from './useDialogA11y';
import { ModalPortal } from './ModalPortal';

export interface NewResourceInput {
  name: string;
  code: string;
  type: string;
  parent_id: string | null;
  description: string;
}

export interface AddResourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Active resources that may act as the parent of the new resource. */
  resources: ResourceNode[];
  /** Parent preselected when the dialog opens; `null` means top level. */
  defaultParentId?: string | null;
  onAddResource: (input: NewResourceInput) => Promise<void>;
}

interface ResourceTypeOption {
  key: string;
  name: string;
}

const TOP_LEVEL = '';
const TOP_LEVEL_TYPES = ['enterprise', 'site'];
const FALLBACK_TYPES: ResourceTypeOption[] = [
  'enterprise',
  'site',
  'plant',
  'area',
  'zone',
  'line',
  'workshop',
  'cell',
  'utility_system',
  'machine',
  'sensor',
].map((key) => ({ key, name: resourceTypeLabel(key) }));

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Generic examples per resource type (never customer data). */
const EXAMPLES: Record<string, { name: string; code: string }> = {
  enterprise: { name: 'e.g. Acme Manufacturing', code: 'e.g. ENT-01' },
  site: { name: 'e.g. North site', code: 'e.g. SITE-01' },
  plant: { name: 'e.g. Plant 1', code: 'e.g. PLANT-01' },
  area: { name: 'e.g. Assembly area', code: 'e.g. AREA-01' },
  zone: { name: 'e.g. Zone A', code: 'e.g. ZONE-01' },
  line: { name: 'e.g. Assembly line 1', code: 'e.g. LINE-01' },
  workshop: { name: 'e.g. Workshop 1', code: 'e.g. WS-01' },
  cell: { name: 'e.g. Cell 1', code: 'e.g. CELL-01' },
  utility_system: { name: 'e.g. Compressed air', code: 'e.g. UTIL-01' },
  machine: { name: 'e.g. Press 1', code: 'e.g. MC-01' },
  sensor: { name: 'e.g. Temperature sensor 1', code: 'e.g. SENS-01' },
};

/** Name and code placeholders for a resource type. */
export function resourceExamples(type: string): { name: string; code: string } {
  return EXAMPLES[type.toLowerCase()] || { name: 'e.g. Unit 1', code: 'e.g. UNIT-01' };
}

/** Neutral focus style: the brand red is reserved for errors and primary actions. */
export const FIELD_BASE =
  'w-full h-10 px-3 bg-white border rounded-lg text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#2A82E7]/20';
export const FIELD_OK = 'border-slate-200 focus:border-[#2A82E7]';
export const FIELD_ERROR = 'border-red-500 focus:border-red-500 focus:ring-red-500/20';

export function resourceNameProblem(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a name.';
  if (FORBIDDEN_NAME.test(trimmed)) return 'Names cannot contain / # + $ or control characters.';
  return '';
}

export function resourceCodeProblem(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a code.';
  if (!CODE_PATTERN.test(trimmed)) return 'Start with a letter or digit; use only letters, digits, dot, underscore or hyphen (max 64).';
  return '';
}
const FORBIDDEN_NAME = /[/#+$\x00-\x1F\x7F]/;

function flattenTree(nodes: HierarchyTreeNode[], depth = 0, out: Array<{ resource: ResourceNode; depth: number }> = []) {
  for (const node of nodes) {
    out.push({ resource: node.resource, depth });
    flattenTree(node.children, depth + 1, out);
  }
  return out;
}

export const AddResourceModal: React.FC<AddResourceModalProps> = ({
  isOpen,
  onClose,
  resources,
  defaultParentId = null,
  onAddResource,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [parentId, setParentId] = useState<string>(TOP_LEVEL);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeUserEdited, setCodeUserEdited] = useState(false);
  const [type, setType] = useState('');
  const [availableTypes, setAvailableTypes] = useState<ResourceTypeOption[]>(FALLBACK_TYPES);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useDialogA11y(isOpen, dialogRef, () => {
    if (!submitting) onClose();
  });

  // Initialise once per opening. Parent data refreshes every few seconds; it must not reset the
  // form, so the effect depends on `isOpen` only and reads the default parent at open time.
  const defaultParentRef = useRef(defaultParentId);
  defaultParentRef.current = defaultParentId;
  useEffect(() => {
    if (!isOpen) return;
    setParentId(defaultParentRef.current || TOP_LEVEL);
    setName('');
    setCode('');
    setCodeUserEdited(false);
    setType('');
    setDescription('');
    setError('');
    setNameError('');
    setCodeError('');
    setSubmitting(false);
    let active = true;
    api<{ items?: Array<{ key: string; name?: string }> }>('/api/v1/resource-types')
      .then((res) => {
        if (!active) return;
        const items = (res?.items || [])
          .filter((item) => item.key)
          .map((item) => ({ key: item.key, name: item.name || resourceTypeLabel(item.key) }));
        if (items.length) setAvailableTypes(items);
      })
      .catch(() => {
        // The built-in ISA-95 list stays in place when the catalog cannot be read.
      });
    return () => {
      active = false;
    };
  }, [isOpen]);

  const parentOptions = useMemo(() => flattenTree(buildResourceTree(resources)), [resources]);
  const parent = parentId ? resources.find((item) => item.id === parentId) : undefined;
  const parentPath = useMemo(() => {
    if (!parent) return '';
    const byId = new Map(resources.map((item) => [item.id, item]));
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: ResourceNode | undefined = parent;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      names.unshift(cursor.name);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return names.join(' › ');
  }, [parent, resources]);

  const { recommended, others } = useMemo(() => {
    const byKey = new Map(availableTypes.map((item) => [item.key.toLowerCase(), item]));
    if (!parent) {
      return {
        recommended: TOP_LEVEL_TYPES.map((key) => byKey.get(key)).filter(Boolean) as ResourceTypeOption[],
        others: [] as ResourceTypeOption[],
      };
    }
    const allowed = allowedChildTypes(parent.type);
    const rec = allowed.map((key) => byKey.get(key)).filter(Boolean) as ResourceTypeOption[];
    const recKeys = new Set(rec.map((item) => item.key.toLowerCase()));
    const rest = availableTypes.filter(
      (item) => !recKeys.has(item.key.toLowerCase()) && !TOP_LEVEL_TYPES.includes(item.key.toLowerCase()),
    );
    return { recommended: rec, others: rest };
  }, [availableTypes, parent]);

  // Keep the selected type valid for the chosen parent.
  useEffect(() => {
    if (!isOpen) return;
    const valid = [...recommended, ...others].some((item) => item.key === type);
    if (!valid) setType(recommended[0]?.key || others[0]?.key || '');
  }, [isOpen, recommended, others, type]);

  useEffect(() => {
    if (!codeUserEdited) setCode(slugifyResourceCode(name));
  }, [name, codeUserEdited]);

  if (!isOpen) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setNameError('');
    setCodeError('');

    const trimmedName = name.trim();
    const trimmedCode = code.trim();
    const nameIssue = resourceNameProblem(name);
    const codeIssue = resourceCodeProblem(code);
    setNameError(nameIssue);
    setCodeError(codeIssue);
    if (nameIssue || codeIssue) {
      document.getElementById(nameIssue ? 'add-resource-name' : 'add-resource-code')?.focus();
      return;
    }
    if (!type) {
      setError('Choose a resource type.');
      return;
    }

    setSubmitting(true);
    try {
      await onAddResource({
        name: trimmedName,
        code: trimmedCode,
        type,
        parent_id: parent ? parent.id : null,
        description: description.trim(),
      });
      onClose();
    } catch (caught) {
      const codeKey = caught instanceof ApiError ? caught.code : '';
      if (codeKey === 'DUPLICATE' || codeKey === 'INVALID_CODE') {
        setCodeError(translateApiError(caught));
      } else if (codeKey === 'NAME_CHARS' || codeKey === 'NAME_LENGTH') {
        setNameError(translateApiError(caught));
      } else {
        setError(translateApiError(caught));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const parentLabel = parent ? parent.name : 'Top level';
  const examples = resourceExamples(type);

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fadeIn"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !submitting) onClose();
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-resource-title"
          aria-describedby="add-resource-desc"
          tabIndex={-1}
          className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] outline-none"
        >
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-red-50 text-[#EF1B24] flex items-center justify-center">
                <FolderPlus className="w-5 h-5" aria-hidden="true" />
              </div>
              <div>
                <h2 id="add-resource-title" className="text-lg font-bold text-slate-900">
                  Add resource
                </h2>
                <p id="add-resource-desc" className="text-xs text-slate-500">
                  Add an enterprise, site, area, line, machine or other unit to the factory model.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} noValidate className="p-6 space-y-4 overflow-y-auto flex-1 text-sm">
            {error && (
              <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="add-resource-parent" className="block text-xs font-semibold text-slate-700 mb-1">
                  Parent
                </label>
                <select
                  id="add-resource-parent"
                  value={parentId}
                  onChange={(event) => setParentId(event.target.value)}
                  className={`${FIELD_BASE} ${FIELD_OK}`}
                >
                  <option value={TOP_LEVEL}>Top level (no parent)</option>
                  {parentOptions.map(({ resource }) => (
                    <option key={resource.id} value={resource.id}>
                      {`${resource.name} (${resourceTypeLabel(resource.type)})`}
                    </option>
                  ))}
                </select>
                {parentPath && (
                  <p className="mt-1 text-[11px] text-slate-500 truncate" title={parentPath}>
                    {parentPath}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="add-resource-type" className="block text-xs font-semibold text-slate-700 mb-1">
                  Type <span className="text-[#EF1B24]">*</span>
                </label>
                <select
                  id="add-resource-type"
                  value={type}
                  onChange={(event) => setType(event.target.value)}
                  className={`${FIELD_BASE} ${FIELD_OK}`}
                >
                  {recommended.length > 0 && (
                    <optgroup label={parent ? `Recommended under ${resourceTypeLabel(parent.type).toLowerCase()}` : 'Top level'}>
                      {recommended.map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {others.length > 0 && (
                    <optgroup label={recommended.length > 0 ? 'Other types' : 'Types'}>
                      {others.map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {parent && recommended.length === 0 && (
                  <p className="mt-1 text-[11px] text-amber-700">
                    A {resourceTypeLabel(parent.type).toLowerCase()} normally has nothing under it. Choose a type only if your
                    model needs it.
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div>
                <label htmlFor="add-resource-name" className="block text-xs font-semibold text-slate-700 mb-1">
                  Name <span className="text-[#EF1B24]">*</span>
                </label>
                <input
                  id="add-resource-name"
                  type="text"
                  data-autofocus
                  maxLength={200}
                  value={name}
                  aria-invalid={Boolean(nameError)}
                  aria-describedby="add-resource-name-hint"
                  onChange={(event) => {
                    setName(event.target.value);
                    // Clear as soon as the input is valid again; new errors appear on blur or submit.
                    if (nameError && !resourceNameProblem(event.target.value)) setNameError('');
                  }}
                  onBlur={() => {
                    // Validate what was typed; an untouched empty field is only reported on submit.
                    if (name) setNameError(resourceNameProblem(name));
                  }}
                  placeholder={examples.name}
                  className={`${FIELD_BASE} ${nameError ? FIELD_ERROR : FIELD_OK}`}
                />
                <div id="add-resource-name-hint" className="mt-1 flex items-start justify-between gap-2 text-[11px]">
                  {nameError ? (
                    <span className="text-red-600 font-medium flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      <span>{nameError}</span>
                    </span>
                  ) : (
                    <span className="text-slate-500">Shown in the hierarchy and in data models.</span>
                  )}
                  <span className="text-slate-400 shrink-0 tabular-nums" aria-hidden="true">
                    {name.length}/200
                  </span>
                </div>
              </div>
              <div>
                <label htmlFor="add-resource-code" className="block text-xs font-semibold text-slate-700 mb-1">
                  Code <span className="text-[#EF1B24]">*</span>
                </label>
                <input
                  id="add-resource-code"
                  type="text"
                  maxLength={64}
                  value={code}
                  aria-invalid={Boolean(codeError)}
                  aria-describedby="add-resource-code-hint"
                  onChange={(event) => {
                    setCode(event.target.value);
                    setCodeUserEdited(true);
                    if (codeError && !resourceCodeProblem(event.target.value)) setCodeError('');
                  }}
                  onBlur={() => {
                    if (codeUserEdited) setCodeError(resourceCodeProblem(code));
                  }}
                  placeholder={examples.code}
                  className={`${FIELD_BASE} font-mono ${codeError ? FIELD_ERROR : FIELD_OK}`}
                />
                {codeError ? (
                  <p id="add-resource-code-hint" className="mt-1 text-[11px] text-red-600 font-medium flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>{codeError}</span>
                  </p>
                ) : (
                  <p id="add-resource-code-hint" className="mt-1 text-[11px] text-slate-500">
                    {codeUserEdited ? 'Identifier used in topics and paths.' : 'Suggested from the name. You can change it.'}
                  </p>
                )}
              </div>
            </div>

            <div>
              <label htmlFor="add-resource-description" className="block text-xs font-semibold text-slate-700 mb-1">
                Description
              </label>
              <textarea
                id="add-resource-description"
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Optional notes about this resource"
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#2A82E7]/20 focus:border-[#2A82E7]"
              />
            </div>

            <p className="text-xs text-slate-500">
              Codes must be unique among the resources directly under{' '}
              <span className="font-semibold text-slate-700">{parentLabel}</span>.
            </p>

            <div className="pt-2 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="px-4 py-2 border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !type}
                className="px-4 py-2 bg-[#EF1B24] hover:bg-[#D9151E] text-white rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {submitting ? 'Creating…' : 'Create resource'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </ModalPortal>
  );
};
