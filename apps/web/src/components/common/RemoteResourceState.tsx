import React from 'react';
import { AlertCircle, AlertTriangle, RefreshCw, Database, ServerOff } from 'lucide-react';
import { ApiError } from '../../api/client';
import { Button } from './Button';

export interface RemoteErrorInfo {
  message: string;
  code?: string;
  statusCode?: number;
  correlationId?: string;
}

export function parseRemoteError(error: unknown): RemoteErrorInfo {
  if (!error) {
    return { message: 'An unexpected error occurred.' };
  }
  if (error instanceof ApiError) {
    const correlationId =
      (error.details?.correlation_id as string) ||
      (error.details?.request_id as string) ||
      undefined;
    return {
      message: error.message || 'API request failed.',
      code: error.code || `HTTP_${error.status}`,
      statusCode: error.status,
      correlationId,
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  return { message: String(error) };
}

interface RemoteErrorStateProps {
  error: unknown;
  subject?: string;
  onRetry?: () => void;
  className?: string;
}

export const RemoteErrorState: React.FC<RemoteErrorStateProps> = ({
  error,
  subject = 'resource',
  onRetry,
  className = '',
}) => {
  const [retrying, setRetrying] = React.useState(false);
  const info = parseRemoteError(error);

  const isUnavailable =
    info.statusCode === 503 ||
    info.code?.includes('UNAVAILABLE') ||
    info.message.toLowerCase().includes('connect') ||
    info.message.toLowerCase().includes('offline');

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      role="alert"
      className={`p-6 bg-white border border-[#FAC6C9] rounded-xl shadow-xs text-center flex flex-col items-center justify-center max-w-lg mx-auto my-6 ${className}`}
    >
      <div className="w-12 h-12 rounded-full bg-[#FEF2F2] flex items-center justify-center mb-3">
        {isUnavailable ? (
          <ServerOff className="w-6 h-6 text-[#EF1B24]" />
        ) : (
          <AlertCircle className="w-6 h-6 text-[#EF1B24]" />
        )}
      </div>

      <h3 className="text-[15px] font-bold text-[#111B37] mb-1">
        Failed to load {subject}
      </h3>

      <p className="text-[13px] text-[#657794] mb-3 max-w-md">
        {info.message}
      </p>

      {/* Typed metadata badges */}
      <div className="flex flex-wrap items-center justify-center gap-2 mb-4 font-mono text-[11px]">
        {info.code && (
          <span className="px-2 py-0.5 rounded bg-[#FEF2F2] text-[#EF1B24] font-semibold border border-[#FAC6C9]">
            CODE: {info.code}
          </span>
        )}
        {info.statusCode && (
          <span className="px-2 py-0.5 rounded bg-[#F1F5FA] text-[#334568] border border-[#D4DFEC]">
            HTTP {info.statusCode}
          </span>
        )}
        {info.correlationId && (
          <span className="px-2 py-0.5 rounded bg-[#F8FAFC] text-[#657794] border border-[#E3EAF3]">
            Trace: {info.correlationId}
          </span>
        )}
      </div>

      {onRetry && (
        <Button
          type="button"
          variant="primary"
          onClick={handleRetry}
          disabled={retrying}
          icon={<RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />}
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      )}
    </div>
  );
};

interface RemoteLoadingStateProps {
  subject?: string;
  className?: string;
}

export const RemoteLoadingState: React.FC<RemoteLoadingStateProps> = ({
  subject = 'data',
  className = '',
}) => {
  return (
    <div
      role="status"
      className={`flex flex-col items-center justify-center gap-3 py-16 text-[13px] text-[#657794] ${className}`}
    >
      <RefreshCw className="w-5 h-5 animate-spin text-[#EF1B24]" />
      <span>Loading {subject}…</span>
    </div>
  );
};

interface RemoteEmptyStateProps {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
}

export const RemoteEmptyState: React.FC<RemoteEmptyStateProps> = ({
  title,
  description,
  actionLabel,
  onAction,
  icon: Icon = Database,
  className = '',
}) => {
  return (
    <div
      className={`p-8 bg-white border border-[#E3EAF3] rounded-xl text-center flex flex-col items-center justify-center max-w-lg mx-auto my-6 ${className}`}
    >
      <div className="w-12 h-12 rounded-full bg-[#F1F5FA] flex items-center justify-center mb-3">
        <Icon className="w-6 h-6 text-[#657794]" />
      </div>
      <h3 className="text-[15px] font-bold text-[#111B37] mb-1">{title}</h3>
      <p className="text-[13px] text-[#657794] mb-4 max-w-md">{description}</p>
      {actionLabel && onAction && (
        <Button type="button" variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
};

interface StaleSnapshotBadgeProps {
  observedAt: string;
  className?: string;
}

export const StaleSnapshotBadge: React.FC<StaleSnapshotBadgeProps> = ({
  observedAt,
  className = '',
}) => {
  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#FFF6E5] border border-[#FFE2A8] text-[#B76E00] rounded-md text-[11px] font-semibold ${className}`}
      title="This data is a cached snapshot and does not represent live stream status"
    >
      <AlertTriangle className="w-3.5 h-3.5" />
      <span>STALE SNAPSHOT — Source time: {new Date(observedAt).toLocaleString()}</span>
    </div>
  );
};
