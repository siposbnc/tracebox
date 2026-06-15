/** Compare two dotted version strings. Returns -1, 0, or 1 (a vs b). */
export function compareVersions(a: string, b: string): number {
  const part = (s: string): number => Number(String(s).replace(/[^\d].*$/, '')) || 0;
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = part(pa[i] ?? '0') - part(pb[i] ?? '0');
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
