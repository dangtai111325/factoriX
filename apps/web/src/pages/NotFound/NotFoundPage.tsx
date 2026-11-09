import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Compass, House } from 'lucide-react';

/** R3-NAV-01: unknown routes show a real "Page not found" instead of silently opening the Overview. */
export const NotFoundPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const canGoBack = typeof window !== 'undefined' && window.history.length > 1;

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="fx-card w-full max-w-lg p-6 sm:p-8 text-center">
        <div className="mx-auto w-12 h-12 rounded-full bg-[#EEF5FF] text-[#2A82E7] flex items-center justify-center">
          <Compass className="w-6 h-6" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-[22px] font-extrabold text-[#111B37]">Page not found</h1>
        <p className="mt-2 text-[13px] text-[#657794] leading-relaxed">
          There is no page at{' '}
          <code className="font-mono text-[12px] text-[#334568] bg-[#F1F5FA] px-1.5 py-0.5 rounded break-all">
            {location.pathname}
          </code>
          . The link may be outdated or mistyped.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link
            to="/overview"
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[#EF1B24] hover:bg-[#D9141D] text-white text-[13px] font-semibold"
          >
            <House className="w-4 h-4" aria-hidden="true" />
            Go to Overview
          </Link>
          {canGoBack && (
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg border border-[#D4DFEC] bg-white text-[#334568] hover:bg-[#F9FAFD] text-[13px] font-semibold"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              Go back
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
