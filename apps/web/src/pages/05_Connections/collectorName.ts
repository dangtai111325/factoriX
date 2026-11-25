/**
 * R1-36: v6 has no separate Edge daemon; the appliance collects with its built-in collector, one
 * per site. The server still names that collector record "Edge <site>" (internal, unchanged); the
 * UI shows the site it collects for.
 */
export function collectorSiteLabel(edgeName: string | undefined | null): string {
  const name = (edgeName || '').trim();
  if (!name || name === '—') return '—';
  const match = /^edge\s+(.+)$/i.exec(name);
  if (match) return match[1];
  if (/^appliance edge$/i.test(name)) return 'Built-in';
  return name;
}
