// Right pane of the body builder: the exact output JSON, re-evaluated every sample_ms while editing.
import React, { useState } from 'react';
import { AlertTriangle, Pause, Play, RefreshCw } from 'lucide-react';
import type { FieldError, PreviewResult } from '../types';
import { CopyButton, JsonBlock, sampleLabel, timeAgo, useNow } from '../ui';
import { formatJsonText } from '../json';

interface Props {
  result: PreviewResult | null;
  error: string | null;
  running: boolean;
  unsupported: boolean;
  paused: boolean;
  onPause: (paused: boolean) => void;
  onRefresh: () => void;
  sampleMs: number;
  /** Issues that could not be attached to a row (shown here). */
  errors: FieldError[];
  onJump: (path: string, nodeId?: string) => void;
  emptyBody: boolean;
}

export const PreviewPane: React.FC<Props> = ({ result, error, running, unsupported, paused, onPause, onRefresh, sampleMs, errors, onJump, emptyBody }) => {
  const [pretty, setPretty] = useState(true);
  const now = useNow(1000);
  const body = result?.body ?? null;
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-1.5 mb-2">
        <h3 className="text-[13px] font-bold text-[#111B37] mr-auto">Live preview</h3>
        <div role="group" aria-label="Format" className="inline-flex rounded-md border border-[#D4DFEC] overflow-hidden text-[11px] font-semibold">
          <button type="button" aria-pressed={pretty} onClick={() => setPretty(true)} className={`px-2 h-7 ${pretty ? 'bg-[#111B37] text-white' : 'bg-white text-[#334568]'}`}>
            Pretty
          </button>
          <button type="button" aria-pressed={!pretty} onClick={() => setPretty(false)} className={`px-2 h-7 ${!pretty ? 'bg-[#111B37] text-white' : 'bg-white text-[#334568]'}`}>
            Compact
          </button>
        </div>
        <CopyButton text={body ? formatJsonText(body, pretty) : null} />
        <button
          type="button"
          onClick={() => onPause(!paused)}
          aria-label={paused ? 'Resume live preview' : 'Pause live preview'}
          title={paused ? 'Resume live preview' : 'Pause live preview'}
          className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-[#D4DFEC] bg-white text-[#334568] hover:bg-[#F1F5FA]"
        >
          {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Evaluate now"
          title="Evaluate now"
          className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-[#D4DFEC] bg-white text-[#334568] hover:bg-[#F1F5FA]"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <p className="text-[11px] text-[#657794] mb-2" aria-live="polite">
        {unsupported
          ? 'Live preview is not available on this server version.'
          : paused
          ? 'Paused.'
          : `Re-evaluated every ${sampleLabel(Math.max(1000, sampleMs))}${result?.sampledAt ? ` · last ${timeAgo(result.sampledAt, now)}` : ''}.`}
      </p>
      {error && (
        <p role="alert" className="mb-2 text-[11px] text-red-800 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
          {error}
        </p>
      )}
      <div className="flex-1 min-h-[200px] overflow-auto rounded-xl border border-slate-200 bg-[#FBFCFE] p-3">
        <JsonBlock
          text={body}
          pretty={pretty}
          ariaLabel="Preview body"
          placeholder={emptyBody ? 'Add fields to see the body.' : running ? 'Evaluating…' : 'No preview yet.'}
        />
      </div>
      {errors.length > 0 && (
        <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 space-y-1" aria-label="Field errors">
          {errors.map((e, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onJump(e.path, e.nodeId)}
              className={`w-full text-left flex items-start gap-1.5 text-[11px] ${e.severity === 'warning' ? 'text-amber-800' : 'text-red-800'} hover:underline`}
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                {e.path && <span className="font-mono font-semibold">{e.path} </span>}
                {e.message}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
