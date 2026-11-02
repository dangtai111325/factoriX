/** Relative age with UTC+7 absolute tooltip helper (CR-DS01). */

const TZ = 'Asia/Ho_Chi_Minh';

export function relativeAge(iso?: string): string {
  if (!iso || iso === '—') return '—';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec} s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

export function absoluteUtc7(iso?: string): string {
  if (!iso || iso === '—') return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ts)) + ' (UTC+7)';
  } catch {
    return iso;
  }
}
