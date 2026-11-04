import React, { useState, useEffect } from 'react';
import { X, Edit2, AlertCircle, AlertTriangle } from 'lucide-react';
import { api } from '../../api/client';
import { Button } from '../common/Button';
import { translateApiError } from '../../utils/apiErrors';

export interface EditResourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  resource: {
    id: string;
    name: string;
    code: string;
    description?: string;
    attributes?: Record<string, any>;
  } | null;
  onSuccess?: () => void;
}

export const EditResourceModal: React.FC<EditResourceModalProps> = ({
  isOpen,
  onClose,
  resource,
  onSuccess,
}) => {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [properties, setProperties] = useState<Array<{ key: string; value: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const initialCode = resource?.code || '';
  const initialVersion = Number(resource?.attributes?.version || 1);

  useEffect(() => {
    if (!isOpen || !resource) return;
    setName(resource.name || '');
    setCode(resource.code || '');
    setDescription(resource.description || '');
    const rawProps = resource.attributes || {};
    const propList = Object.entries(rawProps)
      .filter(([k]) => k !== 'version' && k !== 'siteId')
      .map(([key, value]) => ({ key, value: String(value ?? '') }));
    setProperties(propList);
    setError(null);
    setCodeError(null);
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

  const isCodeChanged = code.trim().toLowerCase() !== initialCode.toLowerCase();

  const handleAddProperty = () => {
    setProperties((prev) => [...prev, { key: '', value: '' }]);
  };

  const handleRemoveProperty = (index: number) => {
    setProperties((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePropertyChange = (index: number, field: 'key' | 'value', val: string) => {
    setProperties((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: val } : item))
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCodeError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Enter a name.');
      return;
    }
    if (/[/#+$]/.test(trimmedName) || /[\x00-\x1F\x7F]/.test(trimmedName)) {
      setError('Names cannot contain / # + $ or control characters.');
      return;
    }
    if (trimmedName.length > 200) {
      setError('Name is too long (max 200 characters).');
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

    // Convert properties array to object
    const propsObj: Record<string, string> = {};
    for (const p of properties) {
      const k = p.key.trim();
      if (k) {
        propsObj[k] = p.value.trim();
      }
    }

    setSubmitting(true);
    try {
      await api(`/api/v1/resources/${resource.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: initialVersion,
          name: trimmedName,
          code: trimmedCode,
          description: description.trim(),
          properties: propsObj,
        }),
      });
      onSuccess?.();
      onClose();
    } catch (caught: any) {
      const resp = caught?.response?.data || caught?.data;
      const errCode = resp?.error?.code || caught?.code;
      if (errCode === 'RESOURCE_VERSION_CONFLICT') {
        setError('Someone else changed this resource. Reload to see the latest version.');
      } else if (errCode === 'DUPLICATE') {
        setCodeError(resp?.error?.message || `A resource with code "${trimmedCode}" already exists under this parent.`);
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
        aria-labelledby="edit-resource-title"
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-50 text-[#EF1B24] flex items-center justify-center font-bold">
              <Edit2 className="w-5 h-5" />
            </div>
            <div>
              <h2 id="edit-resource-title" className="text-lg font-bold text-slate-900">
                Edit {resource.name}
              </h2>
              <p className="text-xs text-slate-500 font-mono">
                Code: {resource.code}
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

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto flex-1 text-sm">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Name & Code */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-semibold text-slate-700">
                  Name <span className="text-[#EF1B24]">*</span>
                </label>
                <span className="text-[11px] text-slate-400">{name.length}/200</span>
              </div>
              <input
                type="text"
                required
                maxLength={200}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Code <span className="text-[#EF1B24]">*</span>
              </label>
              <input
                type="text"
                required
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  if (codeError) setCodeError(null);
                }}
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

          {/* Warning when code changes */}
          {isCodeChanged && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2.5 text-amber-800 text-xs">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
              <span>
                Changing the code changes MQTT/UNS paths used by this resource and its children.
              </span>
            </div>
          )}

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

          {/* Properties */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-slate-700">Properties</label>
              <button
                type="button"
                onClick={handleAddProperty}
                className="text-xs text-[#EF1B24] font-medium hover:underline"
              >
                + Add property
              </button>
            </div>
            {properties.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No properties yet.</p>
            ) : (
              <div className="space-y-2">
                {properties.map((prop, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Key"
                      value={prop.key}
                      onChange={(e) => handlePropertyChange(idx, 'key', e.target.value)}
                      className="w-1/2 px-2.5 py-1.5 border border-slate-200 rounded-md text-xs font-mono"
                    />
                    <input
                      type="text"
                      placeholder="Value"
                      value={prop.value}
                      onChange={(e) => handlePropertyChange(idx, 'value', e.target.value)}
                      className="w-1/2 px-2.5 py-1.5 border border-slate-200 rounded-md text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveProperty(idx)}
                      className="p-1 text-slate-400 hover:text-red-500 rounded"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer buttons */}
          <div className="pt-4 border-t border-slate-100 flex items-center justify-end gap-3">
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
