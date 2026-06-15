/**
 * Inline autocomplete for the query language. Pure helpers used by the search
 * bar: find the token under the cursor and propose completions (field names,
 * `level:` values, and boolean keywords).
 */

export interface Suggestion {
  /** Text inserted in place of the current token. */
  insert: string;
  /** Shown in the dropdown. */
  label: string;
  /** Secondary right-aligned hint (kind of suggestion). */
  hint: string;
  /** Whether to append a space after the insert and move the cursor past it. */
  trailingSpace: boolean;
}

const KEYWORDS = ['AND', 'OR', 'NOT'];
/** Always-available fields the query language understands, even if not "detected". */
const BASE_FIELDS = ['level', 'timestamp'];
const MAX = 8;

/** The whitespace/paren-delimited token ending at the cursor. */
export function tokenBounds(text: string, cursor: number): { start: number; token: string } {
  let start = cursor;
  while (start > 0 && !' \t()'.includes(text[start - 1])) start--;
  return { start, token: text.slice(start, cursor) };
}

export function computeSuggestions(
  token: string,
  fieldNames: string[],
  levels: string[],
): Suggestion[] {
  if (token === '') return [];
  const out: Suggestion[] = [];
  const colon = token.indexOf(':');

  if (colon >= 0) {
    // value side of `field:value` — we can only complete known value sets
    const field = token.slice(0, colon);
    const valuePart = token.slice(colon + 1);
    const opMatch = /^(>=|<=|>|<|=)?(.*)$/.exec(valuePart);
    const op = opMatch?.[1] ?? '';
    const frag = (opMatch?.[2] ?? '').toLowerCase();
    if (field.toLowerCase() === 'level' && op === '') {
      for (const lv of levels) {
        if (lv === 'NONE') continue;
        if (lv.toLowerCase().startsWith(frag)) {
          out.push({ insert: `level:${lv}`, label: `level:${lv}`, hint: 'level', trailingSpace: true });
        }
      }
    }
    return out.slice(0, MAX);
  }

  const upper = token.toUpperCase();
  const lower = token.toLowerCase();

  for (const kw of KEYWORDS) {
    if (kw !== upper && kw.startsWith(upper)) {
      out.push({ insert: kw, label: kw, hint: 'operator', trailingSpace: true });
    }
  }

  const seen = new Set<string>();
  for (const f of [...BASE_FIELDS, ...fieldNames]) {
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.toLowerCase().startsWith(lower)) {
      out.push({ insert: `${f}:`, label: `${f}:`, hint: 'field', trailingSpace: false });
    }
  }

  return out.slice(0, MAX);
}
