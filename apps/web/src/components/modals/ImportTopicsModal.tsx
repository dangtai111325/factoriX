import React, { useState } from 'react';
import { X, UploadCloud, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import { Button } from '../common/Button';

interface ImportTopicsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const TIPA_SAMPLE_TOPICS = [
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-01-AB/AA10-01/state",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-01-AB/AA10-01/energy",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/AA10-02/state",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/AA10-02/energy",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/AA10-02/production",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-02-AB/AA10-02/order",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-03-MM/AA10-03/state",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-03-MM/AA10-03/energy",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-04-MM/AA10-04/state",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-04-MM/AA10-04/energy",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-05-MM/AA10-05/state",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-05-MM/AA10-05/energy",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-06-MM/AA10-06/state",
  "uns/TIPA/DongNai/Factory-1/ASSY/Assembly-AA10-06-MM/AA10-06/energy",
  "uns/TIPA/DongNai/Factory-1/PACK/Packaging-PK01-01-ST/PK01-01/state",
  "uns/TIPA/DongNai/Factory-1/PACK/Packaging-PK01-01-ST/PK01-01/energy",
].join('\n');

export const ImportTopicsModal: React.FC<ImportTopicsModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [topicsText, setTopicsText] = useState(TIPA_SAMPLE_TOPICS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<{
    created: Array<{ code: string; type: string; parent?: string }>;
    existing: number;
  } | null>(null);

  if (!isOpen) return null;

  const handlePreview = async () => {
    setError(null);
    setLoading(true);
    try {
      const topicLines = topicsText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const res = await api<{ create: Array<{ code: string; type: string; parent?: string }>; existing: number }>('/api/v1/resources/import/from-topics', {
        method: 'POST',
        body: JSON.stringify({
          topics: topicLines,
          dry_run: true,
          prefix_levels: 1,
          skip_suffix_levels: 1,
        }),
      });
      setPreviewResult({
        created: res.create || [],
        existing: res.existing || 0,
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to preview import.');
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    setError(null);
    setLoading(true);
    try {
      const topicLines = topicsText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      await api('/api/v1/resources/import/from-topics', {
        method: 'POST',
        body: JSON.stringify({
          topics: topicLines,
          dry_run: false,
          prefix_levels: 1,
          skip_suffix_levels: 1,
        }),
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to import resources.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-fadeIn">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-topics-title"
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 text-[#2A82E7] flex items-center justify-center font-bold">
              <UploadCloud className="w-5 h-5" />
            </div>
            <div>
              <h2 id="import-topics-title" className="text-lg font-bold text-slate-900">
                Import from MQTT Topics
              </h2>
              <p className="text-xs text-slate-500">
                Automatically parse UNS topic structures into hierarchical resources
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

        <div className="p-6 space-y-4 overflow-y-auto flex-1 text-sm">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-slate-700">
                MQTT Topics (one per line)
              </label>
              <button
                type="button"
                onClick={() => setTopicsText(TIPA_SAMPLE_TOPICS)}
                className="text-xs text-[#2A82E7] hover:underline"
              >
                Load TIPA sample
              </button>
            </div>
            <textarea
              rows={8}
              value={topicsText}
              onChange={(e) => setTopicsText(e.target.value)}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg font-mono text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-[#2A82E7]/20 focus:border-[#2A82E7]"
              placeholder="uns/Enterprise/Site/Area/Line/Machine/metric"
            />
          </div>

          {previewResult && (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  Preview: {previewResult.created.length} new resources to create, {previewResult.existing} existing
                </span>
              </div>
              <div className="max-h-48 overflow-y-auto divide-y divide-slate-200 bg-white border border-slate-200 rounded-lg">
                {previewResult.created.map((item, idx) => (
                  <div key={idx} className="p-2 flex items-center justify-between text-xs">
                    <span className="font-mono text-slate-800">{item.code}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] bg-slate-100 text-slate-600 uppercase">
                      {item.type}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={handlePreview} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Run Preview (Dry Run)'}
          </Button>
          <Button variant="primary" onClick={handleImport} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Import Resources'}
          </Button>
        </div>
      </div>
    </div>
  );
};
