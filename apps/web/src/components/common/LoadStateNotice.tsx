import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useApp } from '../../store/AppContext';
import { Button } from './Button';

interface LoadStateNoticeProps {
  /** What is being loaded, e.g. "the factory model". */
  subject: string;
  className?: string;
}

/**
 * Shown instead of an empty state while the shared data has never loaded successfully:
 * a spinner while loading, an error with Retry after a failed load. Renders nothing once data is ready.
 * Pages must only show their "empty" state when `loadState === 'ready'`.
 */
export const LoadStateNotice: React.FC<LoadStateNoticeProps> = ({ subject, className = '' }) => {
  const { loadState, loadError, retryLoad } = useApp();
  const [retrying, setRetrying] = React.useState(false);
  if (loadState === 'ready') return null;
  if (loadState === 'loading') {
    return (
      <div role="status" aria-live="polite" className={`flex flex-col items-center justify-center gap-3 py-16 text-[13px] text-[#657794] ${className}`}>
        <RefreshCw className="w-5 h-5 animate-spin text-[#94A3B8]" aria-hidden="true" />
        <span>Loading {subject}…</span>
      </div>
    );
  }
  return (
    <div role="alert" className={`flex flex-col items-center justify-center gap-3 py-14 px-6 text-center ${className}`}>
      <span className="w-11 h-11 rounded-full bg-[#FFF6E5] flex items-center justify-center">
        <AlertTriangle className="w-5 h-5 text-[#B76E00]" aria-hidden="true" />
      </span>
      <div>
        <p className="text-[14px] font-bold text-[#111B37]">Could not load {subject}</p>
        <p className="text-[12px] text-[#657794] mt-1 max-w-md">
          The server did not answer{loadError ? ` (${loadError})` : ''}. Your data is not lost. Check the connection to the appliance and try again.
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        loading={retrying}
        onClick={async () => {
          setRetrying(true);
          await retryLoad();
          setRetrying(false);
        }}
      >
        {!retrying && <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />} Retry
      </Button>
    </div>
  );
};
