import React, { useEffect, useMemo, useState } from 'react';
import { X, Plus, FolderPlus, Trash2 } from 'lucide-react';
import { translateApiError } from '../../utils/apiErrors';
import {
  ALL_RESOURCE_TYPE_KEYS,
  codePreviewFromName,
  ISA95_TYPE_GROUPS,
  placeholderForType,
  typeDisplayLabel,
  validateResourceName,
} from '../../utils/resourceHierarchy';

export interface AddResourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  parentPath?: string;
  parentType?: string;
  /** Recommended child type keys (lowercase). */
  recommendedTypes?: string[];
  onAddResource?: (newResource: {
    name: string;
    type: string;
    parentPath: string;
    description: string;
    properties: Record<string, string>;
    force?: boolean;
  }) => void | Promise<void>;
  onCreateCustomType?: (input: {
    key: string;
    name: string;
    parentType?: string;
  }) => Promise<void>;
}

export const AddResourceModal: React.FC<AddResourceModalProps> = ({
  isOpen,
  onClose,
  parentPath = '(root)',
  parentType,
  recommendedTypes = [],
  onAddResource,
  onCreateCustomType,
}) => {
  const recommended = useMemo(
    () => new Set(recommendedTypes.map((t) => t.toLowerCase())),
    [recommendedTypes],
  );
  const defaultType = recommendedTypes[0] || 'machine';
  const [name, setName] = useState('');
  const [type, setType] = useState(defaultType);
  const [description, setDescription] = useState('');
  const [properties, setProperties] = useState<Array<{ key: string; value: string }>>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customKey, setCustomKey] = useState('');
  const [customName, setCustomName] = useState('');
  const [extraTypes, setExtraTypes] = useState<string[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setType(defaultType);
    setDescription('');
    setProperties([]);
    setError('');
    setSubmitting(false);
    setShowCustom(false);
    setCustomKey('');
    setCustomName('');
  }, [isOpen, defaultType, parentPath]);

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

  const codePreview = codePreviewFromName(name);
  const typeKey = type.toLowerCase();
  const isRecommended = recommended.size === 0 || recommended.has(typeKey);
  const softWarn =
    !isRecommended && parentType
      ? `"${typeDisplayLabel(typeKey)}" is not a recommended child of ${typeDisplayLabel(parentType)}. You can still create it.`
      : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nameError = validateResourceName(name);
    if (nameError) {
      setError(nameError);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onAddResource?.({
        name: name.trim(),
        type: typeKey,
        parentPath,
        description: description.trim(),
        properties: properties.reduce<Record<string, string>>((acc, item) => {
          if (item.key.trim()) acc[item.key.trim()] = item.value.trim();
          return acc;
        }, {}),
        force: !isRecommended,
      });
      onClose();
    } catch (caught) {
      setError(translateApiError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateCustom = async () => {
    if (!onCreateCustomType) return;
    const key = codePreviewFromName(customKey || customName).toLowerCase();
    if (!key || !customName.trim()) {
      setError('Custom type needs a key and name.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onCreateCustomType({
        key,
        name: customName.trim(),
        parentType: parentType?.toLowerCase(),
      });
      setExtraTypes((prev) => (prev.includes(key) ? prev : [...prev, key]));
      setType(key);
      setShowCustom(false);
    } catch (caught) {
      setError(translateApiError(caught));
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
                Display name is separate from code. All ISA-95 types are listed.
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

        <form onSubmit={(e) => void handleSubmit(e)} className="p-6 space-y-5 overflow-y-auto flex-1 text-sm">
          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">
              Parent
            </label>
            <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-700 break-all">
              {parentPath}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Display name <span className="text-[#EF1B24]">*</span>
              </label>
              <input
                type="text"
                required
                maxLength={200}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError('');
                }}
                placeholder={placeholderForType(typeKey)}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
              />
              <div className="mt-1.5 flex justify-between text-[11px] text-slate-500">
                <span className="font-mono">
                  Code preview: <span className="text-slate-700 font-semibold">{codePreview || '—'}</span>
                </span>
                <span>{name.length}/200</span>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Resource type <span className="text-[#EF1B24]">*</span>
              </label>
              <select
                value={typeKey}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
              >
                {ISA95_TYPE_GROUPS.map((group) => (
                  <optgroup key={group.id} label={group.label}>
                    {group.types.map((key) => (
                      <option key={key} value={key}>
                        {typeDisplayLabel(key)}
                        {recommended.has(key) ? ' · Recommended' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {extraTypes.map((key) => (
                  <option key={key} value={key}>
                    {typeDisplayLabel(key)} (custom)
                  </option>
                ))}
                {ALL_RESOURCE_TYPE_KEYS.filter(
                  (key) => !ISA95_TYPE_GROUPS.some((g) => g.types.includes(key)),
                ).map((key) => (
                  <option key={key} value={key}>
                    {typeDisplayLabel(key)}
                  </option>
                ))}
              </select>
              {onCreateCustomType && (
                <button
                  type="button"
                  onClick={() => setShowCustom((v) => !v)}
                  className="mt-1.5 text-[11px] font-semibold text-[#2A82E7]"
                >
                  {showCustom ? 'Hide custom type' : 'Create custom type…'}
                </button>
              )}
            </div>
          </div>

          {showCustom && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
              <p className="text-[11px] text-slate-600">
                Registers a custom type via POST /resource-types and selects it.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  placeholder="Key (e.g. robot_cell)"
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  className="px-2 py-1.5 border border-slate-200 rounded-md text-xs font-mono"
                />
                <input
                  type="text"
                  placeholder="Display name"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="px-2 py-1.5 border border-slate-200 rounded-md text-xs"
                />
              </div>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleCreateCustom()}
                className="text-xs font-semibold text-[#EF1B24]"
              >
                Save custom type
              </button>
            </div>
          )}

          {softWarn && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {softWarn}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Description</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Operational purpose, physical location, or maintenance notes..."
              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-slate-700">Properties</label>
              <button
                type="button"
                onClick={() => setProperties([...properties, { key: '', value: '' }])}
                className="text-xs font-medium text-[#EF1B24] hover:text-red-700 flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Add Property
              </button>
            </div>
            <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
              {properties.map((prop, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Key"
                    value={prop.key}
                    onChange={(e) => {
                      const next = [...properties];
                      next[idx] = { ...next[idx], key: e.target.value };
                      setProperties(next);
                    }}
                    className="flex-1 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-md text-xs"
                  />
                  <input
                    type="text"
                    placeholder="Value"
                    value={prop.value}
                    onChange={(e) => {
                      const next = [...properties];
                      next[idx] = { ...next[idx], value: e.target.value };
                      setProperties(next);
                    }}
                    className="flex-1 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-md text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setProperties(properties.filter((_, i) => i !== idx))}
                    className="p-1.5 text-slate-400 hover:text-red-600 rounded"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-lg bg-[#EF1B24] text-white text-xs font-semibold disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create resource'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
