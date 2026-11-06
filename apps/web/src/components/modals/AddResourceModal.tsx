import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, FolderPlus, AlertCircle } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import { ResourceNode } from '../../types';
import { translateApiError } from '../../utils/apiErrors';
import { slugifyResourceCode } from '../../utils/slugify';
import { allowedChildTypes, buildResourceTree, HierarchyTreeNode } from '../../utils/resourceHierarchy';
import { resourceTypeLabel } from '../common/ResourceTypeIcon';
import { useDialogA11y } from './useDialogA11y';

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
    if (!trimmedName) {
      setNameError('Enter a name.');
      return;
    }
    if (FORBIDDEN_NAME.test(trimmedName)) {
      setNameError('Names cannot contain / # + $ or control characters.');
      return;
    }
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setCodeError('Enter a code.');
      return;
    }
    if (!CODE_PATTERN.test(trimmedCode)) {
      setCodeError('Start with a letter or digit; use only letters, digits, dot, underscore or hyphen (max 64).');
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

  return (
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
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
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
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="add-resource-name" className="block text-xs font-semibold text-slate-700">
                  Name <span className="text-[#EF1B24]">*</span>
                </label>
                <span className="text-[11px] text-slate-400" aria-hidden="true">
                  {name.length}/200
                </span>
              </div>
              <input
                id="add-resource-name"
                type="text"
                data-autofocus
                maxLength={200}
                value={name}
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? 'add-resource-name-error' : undefined}
                onChange={(event) => {
                  setName(event.target.value);
                  if (nameError) setNameError('');
                }}
                placeholder={parent ? 'e.g. Assembly line 1' : 'e.g. Acme Manufacturing'}
                className={`w-full px-3 py-2 bg-white border rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 ${
                  nameError ? 'border-red-500' : 'border-slate-200 focus:border-[#EF1B24]'
                }`}
              />
              {nameError && (
                <p id="add-resource-name-error" className="mt-1 text-xs text-red-600 font-medium flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{nameError}</span>
                </p>
              )}
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
                  if (codeError) setCodeError('');
                }}
                placeholder="e.g. LINE-01"
                className={`w-full px-3 py-2 bg-white border rounded-lg font-mono text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 ${
                  codeError ? 'border-red-500 bg-red-50/50' : 'border-slate-200 focus:border-[#EF1B24]'
                }`}
              />
              {codeError ? (
                <p id="add-resource-code-hint" className="mt-1 text-xs text-red-600 font-medium flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{codeError}</span>
                </p>
              ) : (
                <p id="add-resource-code-hint" className="mt-1 text-[11px] text-slate-500">
                  {codeUserEdited
                    ? 'Identifier used in topics and paths.'
                    : 'Suggested from the name. You can change it.'}
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
              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
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
  );
};
