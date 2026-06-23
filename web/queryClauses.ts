/**
 * Decompose a query-language string into its top-level clauses for the filter
 * breadcrumb. Whitespace at parenthesis depth 0 (outside quotes) separates
 * clauses; `AND` is the implicit/explicit conjunction between them and a
 * standalone `NOT` attaches to the next clause. A query with a top-level `OR`
 * isn't a simple funnel, so it's returned whole as a single clause (removing it
 * clears everything). Mirrors how the UI builds filters by space-joining clauses.
 */

/** Tokenize at paren depth 0, keeping quoted spans and parenthesized groups whole. */
function topLevelTokens(query: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (inQuote) {
      cur += ch;
      if (ch === '\\' && i + 1 < query.length) cur += query[++i];
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      cur += ch;
    } else if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (depth === 0 && /\s/.test(ch)) {
      if (cur !== '') tokens.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur !== '') tokens.push(cur);
  return tokens;
}

/** Top-level clauses of a query, in order. `[]` for an empty query. */
export function splitClauses(query: string): string[] {
  const tokens = topLevelTokens(query);
  if (tokens.length === 0) return [];
  // a top-level OR is not a clean conjunction — keep the whole query as one chip
  if (tokens.some((t) => t.toUpperCase() === 'OR')) return [query.trim()];

  const clauses: string[] = [];
  let pendingNot = false;
  for (const t of tokens) {
    const up = t.toUpperCase();
    if (up === 'AND') continue; // implicit conjunction between clauses
    if (up === 'NOT') {
      pendingNot = true;
      continue;
    }
    clauses.push(pendingNot ? `NOT ${t}` : t);
    pendingNot = false;
  }
  return clauses;
}

/** Rejoin clauses into a query (space-joined = implicit AND). */
export function joinClauses(clauses: string[]): string {
  return clauses.join(' ');
}
