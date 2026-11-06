import React, { useEffect, useRef, useState } from 'react';
import { X, UploadCloud, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import { Button } from '../common/Button';
import { resourceTypeLabel } from '../common/ResourceTypeIcon';
import { translateApiError } from '../../utils/apiErrors';
import { useDialogA11y } from './useDialogA11y';

interface ImportTopicsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (createdCount: number) => void | Promise<void>;
}

interface PreviewRow {
  code: string;
  type: string;
  parent?: string;
}

const EXAMPLE = [
  'uns/Enterprise/Site/Area/Line-01/Machine-01/state',
  'uns/Enterprise/Site/Area/Line-01/Machine-02/state',
].join('\n');

function topicLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export const ImportTopicsModal: React.FC<ImportTopicsModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [topicsText, setTopicsText] = useState('');
  const [loading, setLoading] = useState<'preview' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ created: PreviewRow[]; existing: number; conflicts: number } | null>(null);

  useDialogA11y(isOpen, dialogRef, () => {
    if (!loading) onClose();
  });

  useEffect(() => {
    if (!isOpen) return;
    setTopicsText('');
    setError(null);
    setPreview(null);
    setLoading(null);
  }, [isOpen]);

  if (!isOpen) return null;

  const lines = topicLines(topicsText);

  const request = (dryRun: boolean) =>
    api<{
      create?: Array<{ code: string; type?: string; type_key?: string; parent?: string; parent_code?: string }>;
      existing?: unknown;
      conflicts?: unknown;
    }>('/api/v1/resources/import/from-topics', {
      method: 'POST',
      body: JSON.stringify({ topics: lines, dry_run: dryRun, prefix_levels: 1, skip_suffix_levels: 1 }),
    });

  const handlePreview = async () => {
    setError(null);
    setLoading('preview');
    try {
      const res = await request(true);
      const count = (value: unknown) => (Array.isArray(value) ? value.length : typeof value === 'number' ? value : 0);
      setPreview({
        created: (res.create || []).map((item) => ({
          code: item.code,
          type: item.type_key || item.type || '',
          parent: item.parent_code || item.parent,
        })),
        existing: count(res.existing),
        conflicts: count(res.conflicts),
      });
    } catch (caught) {
      setError(translateApiError(caught));
    } finally {
      setLoading(null);
    }
  };

  const handleImport = async () => {
    setError(null);
    setLoading('import');
    try {
      const res = await request(false);
      await onSuccess((res.create || []).length);
      onClose();
    } catch (caught) {
      setError(translateApiError(caught));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fadeIn"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !loading) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-topics-title"
        tabIndex={-1}
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] outline-none"
      >
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-50 text-[#EF1B24] flex items-center justify-center">
              <UploadCloud className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="import-topics-title" className="text-lg font-bold text-slate-900">
                Import from MQTT topics
              </h2>
              <p className="text-xs text-slate-500">Create the hierarchy from the levels of your topic names.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={Boolean(loading)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto flex-1 text-sm">
          {error && (
            <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label htmlFor="import-topics-text" className="block text-xs font-semibold text-slate-700 mb-1">
              Topics, one per line
            </label>
            <textarea
              id="import-topics-text"
              rows={8}
              value={topicsText}
              onChange={(event) => {
                setTopicsText(event.target.value);
                setPreview(null);
              }}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg font-mono text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#EF1B24]/20 focus:border-[#EF1B24]"
              placeholder={EXAMPLE}
            />
            <p className="mt-1.5 text-[11px] text-slate-500 leading-relaxed">
              The first level (for example <span className="font-mono">uns</span>) and the last level (the data
              group, for example <span className="font-mono">state</span>) are skipped. The remaining levels become
              enterprise, site, area, zone, line and machine, in that order. Resources that already exist are kept.
            </p>
          </div>

          {preview && (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
              <p className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                {preview.created.length} new, {preview.existing} already in the model
                {preview.conflicts > 0 ? `, ${preview.conflicts} conflicting` : ''}
              </p>
              {preview.created.length > 0 && (
                <div className="max-h-48 overflow-y-auto divide-y divide-slate-200 bg-white border border-slate-200 rounded-lg">
                  {preview.created.map((item, idx) => (
                    <div key={`${item.parent || ''}/${item.code}/${idx}`} className="p-2 flex items-center justify-between gap-3 text-xs">
                      <span className="font-mono text-slate-800 truncate" title={item.parent ? `${item.parent} / ${item.code}` : item.code}>
                        {item.code}
                      </span>
                      <span className="px-2 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 shrink-0">
                        {resourceTypeLabel(item.type)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex items-center justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={Boolean(loading)}>
            Cancel
          </Button>
          <Button type="button" variant="secondary" onClick={() => void handlePreview()} disabled={Boolean(loading) || lines.length === 0}>
            {loading === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" aria-label="Checking" /> : 'Preview'}
          </Button>
          <Button type="button" variant="primary" onClick={() => void handleImport()} disabled={Boolean(loading) || lines.length === 0}>
            {loading === 'import' ? <Loader2 className="w-4 h-4 animate-spin" aria-label="Importing" /> : 'Import'}
          </Button>
        </div>
      </div>
    </div>
  );
};
