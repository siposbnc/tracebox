import { parseQuery, type QueryNode } from './queryParser.ts';

/**
 * Watch rules turn live tailing into light monitoring: while a session follows
 * appended data, each new line is evaluated against the session's rules and a
 * {@link WatchTrigger} fires when one matches. Two kinds:
 *
 * - `match` — fire whenever a newly-appended line matches the rule's query.
 * - `rate`  — fire when matching lines reach `threshold` within a sliding
 *   `windowSec` wall-clock window (e.g. "ERRORs exceed 20/min"). Rate rules are
 *   edge-triggered: they fire once when the window crosses the threshold and
 *   re-arm only after it drops back below, so a sustained burst is one alert.
 *
 * Rules are owned by the client (persisted per file) and pushed to the session;
 * the backend just evaluates whatever set it was last given.
 */

export type WatchRuleKind = 'match' | 'rate';

export interface WatchRule {
  /** Stable id (client-generated), so rate state and triggers can be keyed to it. */
  id: string;
  /** Display name; falls back to the query when empty. */
  name: string;
  kind: WatchRuleKind;
  /** Query-language condition selecting matching lines (the full TraceBox query language). */
  query: string;
  /** Rate rules: fire when the windowed match count reaches this. Ignored for `match`. */
  threshold: number;
  /** Rate rules: sliding window length in seconds. Ignored for `match`. */
  windowSec: number;
  enabled: boolean;
  /** Also raise a desktop (OS) notification, not only an in-app toast. */
  desktop: boolean;
}

export interface WatchTrigger {
  ruleId: string;
  ruleName: string;
  kind: WatchRuleKind;
  /** Wall-clock time the rule fired (epoch ms). */
  at: number;
  /** Matches in this append batch (`match`), or within the window (`rate`). */
  count: number;
  /** Rate threshold/window echoed back for the alert text; null for `match`. */
  threshold: number | null;
  windowSec: number | null;
  desktop: boolean;
  /** The most recent matching line — a preview, and the jump target. */
  sample: { lineNo: number; ts: number | null; level: string | null; text: string } | null;
}

/** A rule paired with its parsed AST (null when the query failed to parse — such rules are skipped). */
export interface CompiledRule {
  rule: WatchRule;
  ast: QueryNode | null;
}

const MAX_RULES = 50;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Sanitize and parse an untrusted rule list (from the API or persisted client
 * state). Unparseable queries are kept but marked `ast: null` so a bad rule
 * never breaks the whole set — it is simply not evaluated.
 */
export function compileRules(raw: unknown): CompiledRule[] {
  if (!Array.isArray(raw)) return [];
  const out: CompiledRule[] = [];
  for (const item of raw.slice(0, MAX_RULES)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const query = typeof r.query === 'string' ? r.query.trim() : '';
    if (query === '') continue;
    const kind: WatchRuleKind = r.kind === 'rate' ? 'rate' : 'match';
    const rule: WatchRule = {
      id: typeof r.id === 'string' && r.id ? r.id : `rule-${out.length}`,
      name: typeof r.name === 'string' ? r.name.slice(0, 200) : '',
      kind,
      query,
      threshold: clampInt(r.threshold, 1, 1_000_000, 10),
      windowSec: clampInt(r.windowSec, 1, 86_400, 60),
      enabled: r.enabled !== false,
      desktop: r.desktop === true,
    };
    let ast: QueryNode | null = null;
    try {
      ast = parseQuery(query);
    } catch {
      ast = null;
    }
    out.push({ rule, ast });
  }
  return out;
}
