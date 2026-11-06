import React from 'react';
import { AlertCircle, CheckCircle2, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { COLLECTOR_STARTING_MESSAGE, CommissionResult, useCollectorStarting } from '../../lib/commissioning';

const STAGE_LABEL: Record<string, string> = {
  REACH: 'Reach endpoint',
  AUTH: 'Authenticate',
  READ: 'Read values',
  SUBSCRIBE: 'Subscribe',
  SAMPLE: 'Receive sample',
  MAP: 'Map fields',
  CAPTURE: 'Capture',
  EDGE_ENROLLMENT: 'Edge collector enrollment',
  REQUEST: 'Send request',
  STATUS: 'Read test status',
};

function stageIcon(status: string) {
  const s = status.toUpperCase();
  if (s === 'PASSED' || s === 'COMPLETED') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />;
  if (s === 'FAILED' || s === 'ERROR') return <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />;
  if (s === 'NOT_APPLICABLE' || s === 'SKIPPED') return <MinusCircle className="w-3.5 h-3.5 text-slate-400 shrink-0" />;
  return <MinusCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />;
}

function stageStatusLabel(status: string): string {
  const s = status.toUpperCase();
  if (s === 'PASSED' || s === 'COMPLETED') return 'Passed';
  if (s === 'FAILED' || s === 'ERROR') return 'Failed';
  if (s === 'NOT_APPLICABLE') return 'Not applicable';
  if (s === 'SKIPPED') return 'Not verified';
  if (s === 'NOT_TESTED' || s === 'PENDING') return 'Not reached';
  return status;
}

interface TestResultPanelProps {
  running?: boolean;
  runningLabel?: string;
  result: CommissionResult | null;
  successLabel?: string;
}

/** Renders the real stage results returned by the Edge collector (no invented timings). */
export const TestResultPanel: React.FC<TestResultPanelProps> = ({ running, runningLabel, result, successLabel }) => {
  const collectorStarting = useCollectorStarting();
  if (running) {
    return (
      <div className="p-3 rounded-xl border border-[#CBD5E1] bg-[#F8FAFC] text-xs text-[#334568] flex items-center gap-2" role="status" aria-live="polite">
        <Loader2 className="w-4 h-4 animate-spin text-[#134074]" />
        <span>{collectorStarting ? COLLECTOR_STARTING_MESSAGE : runningLabel || 'The Edge collector is running the test…'}</span>
      </div>
    );
  }
  if (!result) return null;
  const ok = result.passed;
  return (
    <div
      role="status"
      className={`p-3 rounded-xl border text-xs space-y-2 ${ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-900'}`}
    >
      <div className="flex items-start gap-2 font-bold">
        {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />}
        <span className="break-words">
          {ok ? successLabel || 'Test passed' : result.message || 'Test failed'}
          {!ok && result.errorCode && <span className="ml-1 font-mono font-semibold opacity-70">({result.errorCode})</span>}
        </span>
      </div>
      {result.stages.length > 0 && (
        <ul className="pl-6 space-y-1 text-[11px]">
          {result.stages.map((stage, index) => (
            <li key={`${stage.stage}-${index}`} className="flex items-start gap-2">
              {stageIcon(stage.status)}
              <span className="font-semibold min-w-[110px]">{STAGE_LABEL[stage.stage] || stage.stage}</span>
              <span className={`min-w-[80px] ${stage.status.toUpperCase() === 'SKIPPED' ? 'text-[#657794]' : ''}`}>{stageStatusLabel(stage.status)}</span>
              {typeof stage.duration_ms === 'number' && stage.duration_ms > 0 && (
                <span className="font-mono text-[#64748B]">{stage.duration_ms} ms</span>
              )}
              {stage.detail && <span className={`break-all ${stage.status.toUpperCase() === 'SKIPPED' ? 'text-[#657794] italic' : 'text-[#475569]'}`}>{stage.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
