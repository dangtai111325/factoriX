/**
 * Import a dashboard exported as JSON (`POST /dashboards/import`). The file is read locally, checked
 * for the export format, and sent as-is; the server answers with the new draft and warnings for
 * bindings that do not resolve in this tenant (they stay, and block publishing until fixed).
 */
import React, { useEffect, useRef, useState } from 'react';
import { FileJson, TriangleAlert, Upload } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { Dialog } from '../13_DataModels/ui';
import { errorLine, importDashboard } from '../../features/dashboard/api';
import type { DashboardImportResult } from '../../features/dashboard/types';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const ImportDashboardDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  onImported: (d: DashboardImportResult) => void;
  onOpen: (id: string) => void;
}> = ({ open, onClose, onImported, onOpen }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [payload, setPayload] = useState<unknown>(null);
  const [summary, setSummary] = useState<{ name: string; widgets: number } | null>(null);
  const [name, setName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DashboardImportResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setFileName('');
    setPayload(null);
    setSummary(null);
    setName('');
    setParseError(null);
    setError(null);
    setResult(null);
  }, [open]);

  const onFile = (file: File | undefined) => {
    setParseError(null);
    setPayload(null);
    setSummary(null);
    setResult(null);
    if (!file) return;
    setFileName(file.name);
    if (file.size > MAX_FILE_BYTES) {
      setParseError('The file is larger than 2 MB; a dashboard export is much smaller.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || '')) as Record<string, unknown>;
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
        const doc = (data.document || {}) as { widgets?: unknown[] };
        if (data.format && data.format !== 'factorix.dashboard') {
          setParseError(`This file is a “${String(data.format)}” export, not a FactoriX dashboard.`);
          return;
        }
        // The server only imports full exports (format + format_version + document); a bare document
        // used to pass this check and then fail with IMPORT_FORMAT.
        if (data.format !== 'factorix.dashboard' || !data.document) {
          setParseError('This file is not a FactoriX dashboard export. Use “Export JSON” of a dashboard to create one.');
          return;
        }
        if (!Array.isArray(doc.widgets)) {
          setParseError('This file does not contain a dashboard document (no widget list).');
          return;
        }
        setPayload(data);
        const n = typeof data.name === 'string' ? data.name : file.name.replace(/\.json$/i, '').replace(/\.dashboard$/i, '');
        setSummary({ name: n, widgets: doc.widgets.length });
        setName(n);
      } catch {
        setParseError('The file is not valid JSON.');
      }
    };
    reader.onerror = () => setParseError('The file could not be read.');
    reader.readAsText(file);
  };

  const submit = async () => {
    if (!payload || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await importDashboard({ name: name.trim() || undefined, payload });
      setResult(res);
      onImported(res);
    } catch (e) {
      setError(errorLine(e, 'The import was refused.'));
    } finally {
      setBusy(false);
    }
  };

  const warnings = (result?.warnings || []).map((w) => (typeof w === 'string' ? w : w.message)).filter(Boolean);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      title="Import dashboard"
      subtitle="Choose a JSON file exported from FactoriX. It becomes a new draft."
      width="md"
      footer={
        result ? (
          <>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" onClick={() => onOpen(result.id)}>
              Open in Studio
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" icon={<Upload className="w-4 h-4" />} onClick={() => void submit()} loading={busy} disabled={!payload}>
              Import
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <p className="text-[13px] text-[#334568]">
            Imported <strong className="text-[#111B37]">{result.name}</strong> as a draft.
          </p>
          {warnings.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-[12px] font-semibold text-amber-900 flex items-center gap-1.5">
                <TriangleAlert className="w-4 h-4" aria-hidden="true" /> {warnings.length} item{warnings.length === 1 ? '' : 's'} need attention before publishing
              </p>
              <ul className="mt-1.5 text-[12px] text-amber-900 list-disc pl-5 space-y-0.5 max-h-48 overflow-y-auto">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[12px] text-emerald-800">Every data source resolved in this tenant.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <input ref={inputRef} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} aria-label="Dashboard JSON file" />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="w-full rounded-xl border-2 border-dashed border-[#CBD5E1] hover:border-[#2A82E7] bg-[#F9FAFD] p-6 text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onFile(e.dataTransfer.files?.[0]);
            }}
          >
            <FileJson className="w-7 h-7 mx-auto text-[#657794]" aria-hidden="true" />
            <span className="block mt-2 text-[13px] font-semibold text-[#111B37]">{fileName || 'Choose a file or drop it here'}</span>
            <span className="block text-[11px] text-[#657794]">.json, up to 2 MB</span>
          </button>
          {parseError && (
            <p role="alert" className="text-[12px] text-red-700">
              {parseError}
            </p>
          )}
          {summary && (
            <div>
              <p className="text-[12px] text-[#334568] mb-2">
                {summary.widgets} widget{summary.widgets === 1 ? '' : 's'} found.
              </p>
              <label htmlFor="dash-import-name" className="block text-[12px] font-semibold text-[#334568] mb-1">
                Name
              </label>
              <input id="dash-import-name" className="fx-input" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          {error && (
            <p role="alert" className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
};
