export function validateTopicFilter(t: string): string | null {
  if (!t) return 'Enter a topic filter.';
  if (t.startsWith('/')) return 'Topics should not start with "/".';
  if (t.startsWith('$')) return 'Topics starting with "$" are reserved by the broker.';
  const parts = t.split('/');
  if (parts.some((p) => p === '')) return 'Topic levels cannot be empty.';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.includes('#') && (p !== '#' || i !== parts.length - 1)) {
      return '"#" must be the last level on its own.';
    }
    if (p.includes('+') && p !== '+') {
      return '"+" must take a whole level.';
    }
  }
  if (new TextEncoder().encode(t).length > 65535) return 'Topic is too long.';
  return null;
}
