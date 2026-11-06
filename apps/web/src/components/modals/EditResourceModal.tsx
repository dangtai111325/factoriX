import React, { useEffect, useRef, useState } from 'react';
import { X, Edit2, AlertCircle, AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import { Button } from '../common/Button';
import { translateApiError } from '../../utils/apiErrors';
import { useDialogA11y } from './useDialogA11y';

export interface EditResourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  resource: {
    id: string;
    name: string;
    code: string;
    attributes?: Record<string, unknown>;
  } | null;
  onSuccess?: (updated: { name: string; code: string }) => void | Promise<void>;
}

interface ResourceDetail {
  id: string;
  name: string;
  code: string;
  description?: string | null;
  properties_json?: Record<string, unknown> | null;
  version?: number;
}

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FORBIDDEN_NAME = /[/#+$\x00-\x1F\x7F]/;

/** Keys starting with "_" are maintained by the server (e.g. archive bookkeeping) and are never edited here. */
function isInternalKey(key: string): boolean {
  return key.startsWith('_');
}

export const EditResourceModal: React.FC<EditResourceModalProps> = ({ isOpen, onClose, resource, onSuccess }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [properties, setProperties] = useState<Array<{ key: string; value: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useDialogA11y(isOpen && Boolean(resource), dialogRef, () => {
    if (!submitting) onClose();
  });

  // Initialise once per opening (and per resource). The parent refreshes its data every few
  // seconds and passes a new object each time; that must never overwrite what the user typed.
  // The effect therefore depends on the id only, not on the `resource` object.
  const resourceId = resource?.id || '';
  useEffect(() => {
    if (!isOpen || !resource) return;

    setDetail(null);
    setName(resource.name || '');
    setCode(resource.code || '');
    setDescription('');
    setProperties([]);
    setError(null);
    setNameError(null);
    setCodeError(null);
    setSubmitting(false);
    setLoading(true);

    let active = true;
    // The list endpoint omits description and properties; read the full record so saving keeps them.
    api<ResourceDetail>(`/api/v1/resources/${encodeURIComponent(resource.id)}`)
      .then((row) => {
        if (!active) return;
        setDetail(row);
        setName(row.name || '');
        setCode(row.code || '');
        setDescription(row.description || '');
        setProperties(
          Object.entries(row.properties_json || {})
            .filter(([key]) => !isInternalKey(key))
            .map(([key, value]) => ({
              key,
              value: typeof value === 'string' ? value : JSON.stringify(value),
            })),
        );
      })
      .catch((caught) => {
        if (active) setError(`Could not load the resource details: ${translateApiError(caught)}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // `resource` is intentionally read only when the dialog opens (see comment above).
  }, [isOpen, resourceId]);

  if (!isOpen || !resource) return null;

  const originalCode = detail?.code ?? resource.code ?? '';
  const isCodeChanged = code.trim().toLowerCase() !== originalCode.toLowerCase();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNameError(null);
    setCodeError(null);
    if (!detail) {
      setError('The resource details are still loading.');
      return;
    }

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

    const seen = new Set<string>();
    const nextProperties: Record<string, unknown> = {};
    // Carry server-maintained keys over unchanged.
    for (const [key, value] of Object.entries(detail.properties_json || {})) {
      if (isInternalKey(key)) nextProperties[key] = value;
    }
    for (const item of properties) {
      const key = item.key.trim();
      if (!key) continue;
      if (isInternalKey(key)) {
        setError(`Property names cannot start with "_" (${key}).`);
        return;
      }
      if (seen.has(key)) {
        setError(`The property "${key}" is listed twice.`);
        return;
      }
      seen.add(key);
      const original = detail.properties_json?.[key];
      const unchanged =
        original !== undefined &&
        typeof original !== 'string' &&
        JSON.stringify(original) === item.value.trim();
      // Keep numbers, booleans and objects typed when the user did not change them.
      nextProperties[key] = unchanged ? original : item.value.trim();
    }

    setSubmitting(true);
    try {
      await api(`/api/v1/resources/${encodeURIComponent(resource.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: Number(detail.version || resource.attributes?.version || 1),
          name: trimmedName,
          code: trimmedCode,
          description: description.trim(),
          properties: nextProperties,
        }),
      });
      await onSuccess?.({ name: trimmedName, code: trimmedCode });
      onClose();
    } catch (caught) {
      const errCode = caught instanceof ApiError ? caught.code : '';
      if (errCode === 'RESOURCE_VERSION_CONFLICT') {
        setError('Someone else changed this resource after you opened it. Close this dialog and open it again to edit the latest version.');
      } else if (errCode === 'DUPLICATE' || errCode === 'INVALID_CODE') {
        setCodeError(translateApiError(caught));
      } else if (errCode === 'NAME_CHARS' || errCode === 'NAME_LENGTH') {
        setNameError(translateApiError(caught));
      } else {
        setError(translateApiError(caught));
      }
    } finally {
      setSubmitting(false);
    }
  };

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
        aria-labelledby="edit-resource-title"
        tabIndex={-1}
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh] outline-none"
      >
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3 bg-slate-50">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-red-50 text-[#EF1B24] flex items-center justify-center shrink-0">
              <Edit2 className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 id="edit-resource-title" className="text-lg font-bold text-slate-900 truncate" title={resource.name}>
                Edit {resource.name}
              </h2>
              <p className="text-xs text-slate-500 font-mono truncate">Code: {originalCode}</p>
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
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="edit-resource-name" className="block text-xs font-semibold text-slate-700">
                  Name <span className="text-[#EF1B24]">*</span>
                </label>
                <span className="text-[11px] text-slate-400" aria-hidden="true">
                  {name.length}/200
                </span>
              </div>
              <input
                id="edit-resource-name"
                type="text"
                data-autofocus
                maxLength={200}
                value={name}
                aria-invalid={Boolean(nameError)}
                onChange={(event) => {
                  setName(event.target.value);
                  if (nameError) setNameError(null);
                }}
                className={`w-full px-3 py-2 bg-white border rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 ${
                  nameError ? 'border-red-500' : 'border-slate-200 focus:border-[#EF1B24]'
                }`}
              />
              {nameError && (
                <p className="mt-1 text-xs text-red-600 font-medium flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{nameError}</span>
                </p>
              )}
            </div>
            <div>
              <label htmlFor="edit-resource-code" className="block text-xs font-semibold text-slate-700 mb-1">
                Code <span className="text-[#EF1B24]">*</span>
              </label>
              <input
                id="edit-resource-code"
                type="text"
                maxLength={64}
                value={code}
                aria-invalid={Boolean(codeError)}
                onChange={(event) => {
                  setCode(event.target.value);
                  if (codeError) setCodeError(null);
                }}
                className={`w-full px-3 py-2 bg-white border rounded-lg font-mono text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 ${
                  codeError ? 'border-red-500 bg-red-50/50' : 'border-slate-200 focus:border-[#EF1B24]'
                }`}
              />
              {codeError && (
                <p className="mt-1 text-xs text-red-600 font-medium flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{codeError}</span>
                </p>
              )}
            </div>
          </div>

          {isCodeChanged && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2.5 text-amber-800 text-xs">
              <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" aria-hidden="true" />
              <span>Changing the code changes the topic and path of this resource and of everything under it.</span>
            </div>
          )}

          <div>
            <label htmlFor="edit-resource-description" className="block text-xs font-semibold text-slate-700 mb-1">
              Description
            </label>
            <textarea
              id="edit-resource-description"
              rows={2}
              value={description}
              disabled={loading}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={loading ? 'Loading…' : 'Optional notes about this resource'}
              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24] disabled:bg-slate-50"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-700">Properties</span>
              <button
                type="button"
                disabled={loading}
                onClick={() => setProperties((prev) => [...prev, { key: '', value: '' }])}
                className="inline-flex items-center gap-1 text-xs text-[#EF1B24] font-medium hover:underline disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                Add property
              </button>
            </div>
            {loading ? (
              <p className="text-xs text-slate-400">Loading properties…</p>
            ) : properties.length === 0 ? (
              <p className="text-xs text-slate-400">No properties yet.</p>
            ) : (
              <div className="space-y-2">
                {properties.map((prop, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      aria-label={`Property ${idx + 1} name`}
                      placeholder="Name"
                      value={prop.key}
                      onChange={(event) =>
                        setProperties((prev) => prev.map((item, i) => (i === idx ? { ...item, key: event.target.value } : item)))
                      }
                      className="w-1/2 px-2.5 py-1.5 border border-slate-200 rounded-md text-xs font-mono"
                    />
                    <input
                      type="text"
                      aria-label={`Property ${idx + 1} value`}
                      placeholder="Value"
                      value={prop.value}
                      onChange={(event) =>
                        setProperties((prev) => prev.map((item, i) => (i === idx ? { ...item, value: event.target.value } : item)))
                      }
                      className="w-1/2 px-2.5 py-1.5 border border-slate-200 rounded-md text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => setProperties((prev) => prev.filter((_, i) => i !== idx))}
                      className="p-1 text-slate-400 hover:text-red-500 rounded"
                      aria-label={`Remove property ${prop.key || idx + 1}`}
                      title="Remove property"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-slate-100 flex items-center justify-end gap-3">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={submitting || loading || !detail}>
              {submitting ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
