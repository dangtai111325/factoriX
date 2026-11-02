import React, { useEffect, useState } from 'react';
import { X, Pencil } from 'lucide-react';
import { ResourceNode } from '../../types';
import { translateApiError } from '../../utils/apiErrors';
import { codePreviewFromName, placeholderForType, typeDisplayLabel, validateResourceName } from '../../utils/resourceHierarchy';

export interface EditResourceModalProps {
  isOpen: boolean;
  resource: ResourceNode | null;
  onClose: () => void;
  onSave: (patch: {
    name: string;
    code: string;
    description: string;
    properties: Record<string, string>;
  }) => Promise<void>;
}

export const EditResourceModal: React.FC<EditResourceModalProps> = ({
  isOpen,
  resource,
  onClose,
  onSave,
}) => {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [properties, setProperties] = useState<Array<{ key: string; value: string }>>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen || !resource) return;
    setName(resource.name);
    setCode(resource.code);
    setDescription(resource.description || '');
    const attrs = Object.entries(resource.attributes || {}).filter(
      ([key]) => key !== 'siteId' && key !== 'version',
    );
    setProperties(attrs.map(([key, value]) => ({ key, value: String(value) })));
    setError('');
    setSubmitting(false);
  }, [isOpen, resource]);

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

  if (!isOpen || !resource) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nameError = validateResourceName(name);
    if (nameError) {
      setError(nameError);
      return;
    }
    if (!code.trim()) {
      setError('Resource code is required.');
      return;
    }
    const propsMap = properties.reduce<Record<string, string>>((acc, item) => {
      if (item.key.trim()) acc[item.key.trim()] = item.value.trim();
      return acc;
    }, {});
    setSubmitting(true);
    setError('');
    try {
      await onSave({
        name: name.trim(),
        code: code.trim(),
        description: description.trim(),
        properties: propsMap,
      });
      onClose();
    } catch (caught) {
      setError(translateApiError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-resource-title"
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-50 text-[#EF1B24] flex items-center justify-center">
              <Pencil className="w-5 h-5" />
            </div>
            <div>
              <h2 id="edit-resource-title" className="text-lg font-bold text-slate-900">
                Edit resource
              </h2>
              <p className="text-xs text-slate-500">
                {typeDisplayLabel(resource.type)} · display name is separate from code
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-200" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-6 space-y-4 overflow-y-auto flex-1 text-sm">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Display name <span className="text-[#EF1B24]">*</span>
            </label>
            <input
              type="text"
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={placeholderForType(resource.type)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg"
            />
            <div className="mt-1 flex justify-between text-[11px] text-slate-500">
              <span>Shown in the tree and inspector</span>
              <span>{name.length}/200</span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Code <span className="text-[#EF1B24]">*</span>
            </label>
            <input
              type="text"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg font-mono text-xs"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              Unique under the same parent. Preview from name:{' '}
              <span className="font-mono">{codePreviewFromName(name) || '—'}</span>
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Description</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-slate-700">Properties</label>
              <button
                type="button"
                onClick={() => setProperties((prev) => [...prev, { key: '', value: '' }])}
                className="text-xs font-medium text-[#EF1B24]"
              >
                Add property
              </button>
            </div>
            <div className="space-y-2 max-h-36 overflow-y-auto">
              {properties.map((prop, idx) => (
                <div key={idx} className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Key"
                    value={prop.key}
                    onChange={(e) => {
                      const next = [...properties];
                      next[idx] = { ...next[idx], key: e.target.value };
                      setProperties(next);
                    }}
                    className="flex-1 px-2 py-1.5 border border-slate-200 rounded-md text-xs"
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
                    className="flex-1 px-2 py-1.5 border border-slate-200 rounded-md text-xs"
                  />
                </div>
              ))}
            </div>
          </div>

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-3 py-2 rounded-lg bg-[#EF1B24] text-white text-xs font-semibold disabled:opacity-50"
            >
              {submitting ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
