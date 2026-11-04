import React, { useEffect, useState } from 'react';
import { X, FolderPlus, AlertCircle } from 'lucide-react';
import { translateApiError } from '../../utils/apiErrors';
import { slugifyResourceCode } from '../../utils/slugify';
import { api } from '../../api/client';

export interface AddResourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  parentId?: string | null;
  parentName?: string;
  parentPath?: string;
  recommendedTypes?: string[];
  hierarchyMode?: 'guided' | 'strict';
  onAddResource?: (newResource: {
    name: string;
    code: string;
    type: string;
    parent_id?: string | null;
    description: string;
    properties: Record<string, string>;
  }) => void | Promise<void>;
}

interface ResourceTypeOption {
  key: string;
  name: string;
  category: string;
  recommended_children?: string[];
}

export const AddResourceModal: React.FC<AddResourceModalProps> = ({
  isOpen,
  onClose,
  parentId = null,
  parentName,
  parentPath = '(root)',
  recommendedTypes = [],
  hierarchyMode = 'guided',
  onAddResource,
}) => {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeUserEdited, setCodeUserEdited] = useState(false);
  const [type, setType] = useState('line');
  const [availableTypes, setAvailableTypes] = useState<ResourceTypeOption[]>([]);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setCode('');
    setCodeUserEdited(false);
    setDescription('');
    setError('');
    setCodeError('');
    setSubmitting(false);

    // Fetch types from API
    api<{ types: ResourceTypeOption[] }>('/api/v1/resource-types')
      .then((res) => {
        const types = res?.types || [];
        setAvailableTypes(types);
        if (recommendedTypes.length > 0) {
          setType(recommendedTypes[0]);
        } else if (types.length > 0) {
          setType(types[0].key);
        }
      })
      .catch(() => {
        // Fallback standard types
        setAvailableTypes([
          { key: 'enterprise', name: 'Enterprise', category: 'ENTERPRISE' },
          { key: 'site', name: 'Site', category: 'SITE' },
          { key: 'area', name: 'Area', category: 'AREA' },
          { key: 'zone', name: 'Zone', category: 'AREA' },
          { key: 'line', name: 'Line', category: 'LINE' },
          { key: 'machine', name: 'Machine', category: 'MACHINE' },
        ]);
        setType('line');
      });
  }, [isOpen, parentId]);

  useEffect(() => {
    if (!codeUserEdited) {
      setCode(slugifyResourceCode(name));
    }
  }, [name, codeUserEdited]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isRecommended = recommendedTypes.length === 0 || recommendedTypes.includes(type);
  const isStrictBlocked = hierarchyMode === 'strict' && !isRecommended;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setCodeError('');

    if (!name.trim()) {
      setError('Enter a name.');
      return;
    }

    if (/[/#+$]/.test(name) || /[\x00-\x1F\x7F]/.test(name)) {
      setError('Names cannot contain / # + $ or control characters.');
      return;
    }

    const trimmedCode = code.trim();
    if (!trimmedCode) {
      setCodeError('Code is required.');
      return;
    }

    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(trimmedCode)) {
      setCodeError('Code must start with a letter or digit and use only letters, digits, . _ -');
      return;
    }

    if (isStrictBlocked) {
      setError(`Cannot add '${type}' under '${parentName || 'root'}' in strict hierarchy mode.`);
      return;
    }

    setSubmitting(true);
    try {
      await onAddResource?.({
        name: name.trim(),
        code: trimmedCode,
        type,
        parent_id: parentId,
        description: description.trim(),
        properties: {},
      });
      onClose();
    } catch (caught: any) {
      const resp = caught?.response?.data;
      if (resp?.error?.code === 'DUPLICATE') {
        setCodeError(resp.error.message || `Code '${trimmedCode}' already exists under '${parentName || 'root'}'.`);
      } else {
        setError(translateApiError(caught));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fadeIn">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-resource-title"
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-50 text-[#EF1B24] flex items-center justify-center font-bold">
              <FolderPlus className="w-5 h-5" />
            </div>
            <div>
              <h2 id="add-resource-title" className="text-lg font-bold text-slate-900">
                Add Factory Resource
              </h2>
              <p className="text-xs text-slate-500">
                Define and insert a new entity into the factory hierarchy
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto flex-1 text-sm">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Context Path */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
              Parent Resource
            </label>
            <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-700 break-all flex items-center justify-between">
              <span>{parentName ? `${parentName} (${parentPath})` : '(Root - No Parent)'}</span>
              <span className="text-[10px] px-2 py-0.5 rounded bg-slate-200 text-slate-600 uppercase">
                {hierarchyMode} Mode
              </span>
            </div>
          </div>

          {/* Resource Name and Code */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-semibold text-slate-700">
                  Resource Name <span className="text-[#EF1B24]">*</span>
                </label>
                <span className="text-[11px] text-slate-400">{name.length}/200</span>
              </div>
              <input
                type="text"
                required
                autoFocus
                maxLength={200}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError('');
                }}
                placeholder={parentId ? "e.g. Assembly Line 01" : "e.g. Acme Corp"}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Code (Unique Identifier) <span className="text-[#EF1B24]">*</span>
              </label>
              <input
                type="text"
                required
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setCodeUserEdited(true);
                  if (codeError) setCodeError('');
                }}
                placeholder="e.g. ASSY-01"
                className={`w-full px-3 py-2 bg-white border rounded-lg font-mono text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 ${
                  codeError ? 'border-red-500 bg-red-50/50' : 'border-slate-200 focus:border-[#EF1B24]'
                }`}
              />
              {codeError && (
                <p className="mt-1 text-xs text-red-600 font-medium flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{codeError}</span>
                </p>
              )}
            </div>
          </div>

          {/* Resource Type */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-slate-700">
                Resource Type <span className="text-[#EF1B24]">*</span>
              </label>
              {isRecommended ? (
                <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  Recommended placement
                </span>
              ) : (
                <span className="text-[11px] font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                  {hierarchyMode === 'strict' ? 'Strict mode: Not allowed' : 'Non-standard placement'}
                </span>
              )}
            </div>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
            >
              {availableTypes.map((t) => {
                const rec = recommendedTypes.length === 0 || recommendedTypes.includes(t.key);
                return (
                  <option key={t.key} value={t.key} disabled={hierarchyMode === 'strict' && !rec}>
                    {t.name} ({t.category}) {rec ? '— Recommended' : '— Non-standard'}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Description</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional notes or details about this resource"
              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
            />
          </div>

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
            Resource code uniqueness is strictly scoped to its siblings under{' '}
            <span className="font-semibold text-slate-800">{parentName || 'Root'}</span>. Identical codes under different parents are permitted.
          </div>

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
              disabled={submitting || isStrictBlocked}
              className="px-4 py-2 bg-[#EF1B24] hover:bg-[#D9151E] text-white rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {submitting ? 'Creating...' : 'Create Resource'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
