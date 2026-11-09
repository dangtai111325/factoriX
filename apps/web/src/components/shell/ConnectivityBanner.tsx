import React, { useState } from 'react';
import { CloudOff, RefreshCw, WifiOff, Zap } from 'lucide-react';
import { api } from '../../api/client';
import { useConnectivity } from '../../lib/connectivity';
import { refreshCollectorHealth } from './collectorHealth';

function clock(ts: number | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Global connection banner (R3-OV-01): the browser is offline, the appliance does not answer, or the
 * live stream is interrupted. While shown, pages display collector / connection / signal states as
 * "Unknown (no connection to appliance)" (see lib/connectivity.ts) and polling backs off.
 */
export const ConnectivityBanner: React.FC = () => {
  const connectivity = useConnectivity();
  const [checking, setChecking] = useState(false);

  if (connectivity.state === 'ok') return null;

  const lastContact = connectivity.lastOkAt ? ` Last contact with the appliance at ${clock(connectivity.lastOkAt)}.` : '';

  const retry = async () => {
    if (checking) return;
    setChecking(true);
    try {
      // Any answer flips the state back to connected (api() reports it); a failure keeps the banner.
      await api('/api/v1/auth/status');
      refreshCollectorHealth();
    } catch (error) {
      console.warn('Connectivity check failed', error);
    } finally {
      setChecking(false);
    }
  };

  if (connectivity.state === 'stream_down') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="bg-[#FFF6E5] border-b border-[#FFD48A] text-[#7A4B00] text-[12px] font-medium px-4 py-1.5 flex items-center gap-2"
      >
        <Zap className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          Live updates are interrupted. Values refresh every few seconds until the live connection is back.
        </span>
      </div>
    );
  }

  const offline = connectivity.state === 'browser_offline';
  const Icon = offline ? WifiOff : CloudOff;
  return (
    <div
      role="alert"
      className="bg-[#111B37] text-white text-[12px] px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      <Icon className="w-4 h-4 shrink-0 text-[#FFAA23]" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="font-bold">{offline ? 'You are offline.' : 'No connection to the FactoriX appliance.'}</span>{' '}
        {offline
          ? 'This browser has no network connection.'
          : 'The appliance does not answer.'}{' '}
        Statuses are shown as Unknown and values are the last known ones.{lastContact} Retrying automatically.
      </span>
      {!offline && (
        <button
          type="button"
          onClick={() => void retry()}
          disabled={checking}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-white/15 hover:bg-white/25 text-[11px] font-bold disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
          {checking ? 'Checking…' : 'Retry now'}
        </button>
      )}
    </div>
  );
};
