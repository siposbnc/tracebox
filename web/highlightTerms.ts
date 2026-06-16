/** Extract the literal text terms from a query string, for in-row highlighting. */
export function extractHighlightTerms(active: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(active)) !== null) {
    if (m[1] !== undefined) {
      terms.push(m[1]);
    } else {
      const word = m[2];
      if (/^(AND|OR|NOT)$/i.test(word)) continue;
      if (word.includes(':')) continue;
      const clean = word.replace(/^[-(]+|[)]+$/g, '');
      if (clean.length >= 2) terms.push(clean.replaceAll('*', ''));
    }
  }
  return terms.filter((t) => t.length >= 2);
}

/** Build a case-insensitive alternation regex from highlight terms (or null). */
export function highlightRegexFor(terms: string[]): RegExp | null {
  const escaped = terms.filter((t) => t.length > 0).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return null;
  try {
    return new RegExp(`(${escaped.join('|')})`, 'gi');
  } catch {
    return null;
  }
}
