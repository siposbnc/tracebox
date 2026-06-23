import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, formatCount } from '../api';
import { splitClauses, joinClauses } from '../queryClauses';
import type { Capture } from '../captures';

/**
 * The active query as a poppable funnel of clauses: the whole-file count, then a
 * chip per top-level clause showing the cumulative result count after it, each
 * removable with ×. Makes progressive narrowing legible and every step reversible
 * without editing the query string. Hidden in regex mode (no clause structure).
 */
export default function FilterBreadcrumb({
  sessionId,
  query,
  captures,
  grouped,
  lineCount,
  epoch,
  onChange,
}: {
  sessionId: string;
  query: string;
  captures: Capture[];
  /** Funnel counts are line counts, so they're hidden while grouping records. */
  grouped: boolean;
  lineCount: number;
  /** Bumped on every search (incl. tail growth) so counts refetch. */
  epoch: number;
  onChange: (query: string) => void;
}) {
  const clauses = useMemo(() => splitClauses(query), [query]);
  const [counts, setCounts] = useState<(number | null)[]>([]);

  const clauseKey = clauses.join('');
  const capKey = useMemo(() => captures.map((c) => `${c.name}=${c.pattern}`).join(''), [captures]);

  // counts[0] = whole file; counts[i+1] = cumulative after clause i, in the
  // active grouping mode so the numbers match the displayed total
  useEffect(() => {
    if (clauses.length === 0) {
      setCounts([]);
      return;
    }
    let cancelled = false;
    const prefixes = ['', ...clauses.map((_, i) => joinClauses(clauses.slice(0, i + 1)))];
    void Promise.all(
      prefixes.map((p) =>
        api
          .count(sessionId, p, captures, grouped)
          .then((r) => r.count)
          .catch(() => null),
      ),
    ).then((cs) => {
      if (!cancelled) setCounts(cs);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, clauseKey, capKey, grouped, epoch]);

  if (clauses.length === 0) return null;

  const remove = (i: number): void => onChange(joinClauses(clauses.filter((_, j) => j !== i)));
  const startCount = counts[0] ?? lineCount;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-edge bg-surface-1 px-3 py-1 text-xs">
      <span className="shrink-0 font-medium text-gray-500">Filters</span>
      <span className="shrink-0 font-mono text-gray-600" title={grouped ? 'Records in the whole file' : 'Lines in the whole file'}>
        {formatCount(startCount)}
      </span>
      {clauses.map((clause, i) => {
        const count = counts[i + 1];
        return (
          <Fragment key={`${i}:${clause}`}>
            <span className="shrink-0 select-none text-gray-600">›</span>
            <span className="group flex shrink-0 items-center gap-1.5 rounded border border-edge bg-surface-2 py-0.5 pl-2 pr-0.5">
              <span className="font-mono text-gray-200" title={clause}>
                {clause}
              </span>
              {count != null && (
                <span className="font-mono text-[10px] text-sky-300" title="Matches after this filter">
                  {formatCount(count)}
                </span>
              )}
              <button
                onClick={() => remove(i)}
                title="Remove this filter"
                className="rounded px-1 text-gray-500 hover:bg-surface-3 hover:text-red-300"
              >
                ×
              </button>
            </span>
          </Fragment>
        );
      })}
      {clauses.length > 1 && (
        <button
          onClick={() => onChange('')}
          title="Clear all filters"
          className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
