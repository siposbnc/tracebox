import { useEffect, useState } from 'react';
import { api, formatCount, formatTs, formatDelta } from '../api';
import { detectAnomalies, type Anomalies } from '../anomalies';
import { useEscapeKey } from '../escStack';
import type { TriageResult } from '../types';

const LEVEL_DOT: Record<string, string> = {
  ERROR: 'bg-red-500',
  FATAL: 'bg-fuchsia-500',
  WARN: 'bg-amber-500',
  INFO: 'bg-sky-500',
  DEBUG: 'bg-slate-500',
  TRACE: 'bg-slate-600',
};

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** A field's stat values: milliseconds get a compact duration, else a plain number. */
function statValue(field: string, n: number): string {
  return /ms$/i.test(field) ? formatDelta(n) : Math.round(n).toLocaleString('en-US');
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
      <div className="divide-y divide-edge/50 overflow-hidden rounded-lg border border-edge bg-surface-2/40">
        {children}
      </div>
    </section>
  );
}

/** A clickable drill row: label + right-aligned count and a chevron. */
function DrillRow({ children, count, onClick, title }: { children: React.ReactNode; count?: string; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="group flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-3/40"
    >
      <span className="min-w-0 flex-1 truncate text-sm text-gray-200 group-hover:text-gray-100">{children}</span>
      {count && <span className="shrink-0 font-mono text-xs text-gray-400">{count}</span>}
      <span className="shrink-0 text-gray-600 transition-all group-hover:translate-x-0.5 group-hover:text-sky-300">›</span>
    </button>
  );
}

/**
 * "What's wrong" landing dashboard shown when a file opens: error counts, the top
 * log-pattern clusters among errors, activity spikes & gaps, and a slowest-field
 * summary. Each finding drills into the main view (and closes the panel).
 */
export default function TriagePanel({
  sessionId,
  file,
  onClose,
  onFilterLevel,
  onDrillCluster,
  onTimeRange,
  onQuery,
}: {
  sessionId: string;
  file: string;
  onClose: () => void;
  onFilterLevel: (level: string) => void;
  onDrillCluster: (templateId: number) => void;
  onTimeRange: (start: number, end: number) => void;
  onQuery: (query: string) => void;
}) {
  useEscapeKey(onClose, 'modal');
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [anomalies, setAnomalies] = useState<Anomalies>({ spikes: [], gaps: [] });
  const [bucketMs, setBucketMs] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([api.triage(sessionId), api.histogram(sessionId)]).then(([t, h]) => {
      if (cancelled) return;
      setTriage(t);
      if (h) {
        setAnomalies(detectAnomalies(h));
        setBucketMs(h.bucketMs);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // run a drill action and close the landing view
  const act = (fn: () => void) => (): void => {
    fn();
    onClose();
  };

  const span =
    triage && triage.span.start !== null && triage.span.end !== null
      ? `${formatTs(triage.span.start)} → ${formatTs(triage.span.end)} · ${formatDelta(triage.span.end - triage.span.start)}`
      : null;

  const nothing =
    triage !== null &&
    triage.errorTotal === 0 &&
    anomalies.spikes.length === 0 &&
    anomalies.gaps.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[620px] max-w-[94vw] animate-toast-in flex-col overflow-hidden rounded-lg border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-100">
            <svg className="h-4 w-4 text-sky-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l3 2" />
            </svg>
            Triage · <span className="font-mono font-normal text-gray-300">{baseName(file)}</span>
          </h2>
          <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200" title="Dismiss (Esc)">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {loading || !triage ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
              <svg className="h-4 w-4 animate-spin text-sky-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.22-8.56" />
              </svg>
              Analyzing…
            </div>
          ) : (
            <>
              {/* overview */}
              <div className="rounded-lg border border-edge bg-surface-2/40 px-3 py-2.5">
                <div className="text-sm text-gray-200">
                  <span className="font-mono">{formatCount(triage.total)}</span> lines
                  {span && <span className="text-gray-500"> · {span}</span>}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {triage.levels.map((l) => (
                    <button
                      key={l.level}
                      onClick={act(() => onFilterLevel(l.level))}
                      title={`Filter to ${l.level}`}
                      className="flex items-center gap-1.5 rounded-full border border-edge bg-surface-0 px-2 py-0.5 text-xs text-gray-300 hover:border-sky-700 hover:text-gray-100"
                    >
                      <span className={`h-2 w-2 rounded-full ${LEVEL_DOT[l.level] ?? 'bg-gray-500'}`} />
                      {l.level} <span className="font-mono text-gray-500">{formatCount(l.count)}</span>
                    </button>
                  ))}
                </div>
              </div>

              {nothing && (
                <div className="rounded-lg border border-edge bg-surface-2/40 px-3 py-4 text-center text-sm text-emerald-300">
                  No errors, spikes, or gaps detected — this log looks healthy.
                </div>
              )}

              {/* top error patterns */}
              {triage.errorClusters.length > 0 && (
                <Section title={`Top error patterns · ${formatCount(triage.errorTotal)} error${triage.errorTotal === 1 ? '' : 's'}`}>
                  {triage.errorClusters.map((c) => (
                    <DrillRow
                      key={c.id}
                      count={formatCount(c.count)}
                      onClick={act(() => onDrillCluster(c.id))}
                      title="Drill into this pattern"
                    >
                      <span className="font-mono text-[13px] text-gray-300">{c.pattern}</span>
                    </DrillRow>
                  ))}
                </Section>
              )}

              {/* activity: spikes & gaps */}
              {(anomalies.spikes.length > 0 || anomalies.gaps.length > 0) && (
                <Section title="Activity">
                  {anomalies.spikes.map((s) => (
                    <DrillRow
                      key={`s${s.index}`}
                      count={`${s.ratio === Infinity ? '∞' : `${s.ratio.toFixed(1)}×`}`}
                      onClick={act(() => onTimeRange(s.start, s.start + bucketMs))}
                      title="Filter to this time window"
                    >
                      <span className="text-amber-300">⚡ Volume spike</span>{' '}
                      <span className="text-gray-500">at {formatTs(s.start)} · {formatCount(s.total)} lines</span>
                    </DrillRow>
                  ))}
                  {anomalies.gaps.map((g, i) => (
                    <DrillRow
                      key={`g${i}`}
                      count={formatDelta(g.durationMs)}
                      onClick={act(() => onTimeRange(g.start, g.end))}
                      title="Filter to this quiet window"
                    >
                      <span className="text-sky-300">⏸ Quiet gap</span>{' '}
                      <span className="text-gray-500">
                        {formatTs(g.start)} → {formatTs(g.end)}
                      </span>
                    </DrillRow>
                  ))}
                </Section>
              )}

              {/* slowest field */}
              {triage.slowest && (
                <Section title="Slowest">
                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="flex items-center gap-4 text-sm">
                      <span className="font-mono text-gray-300">{triage.slowest.field}</span>
                      <span className="text-gray-500">
                        p50 <span className="text-gray-300">{statValue(triage.slowest.field, triage.slowest.p50)}</span>
                        {'  '}· p95 <span className="text-amber-300">{statValue(triage.slowest.field, triage.slowest.p95)}</span>
                        {'  '}· max <span className="text-red-300">{statValue(triage.slowest.field, triage.slowest.max)}</span>
                      </span>
                    </div>
                    <button
                      onClick={act(() => onQuery(`${triage!.slowest!.field}:>=${Math.round(triage!.slowest!.p95)}`))}
                      className="shrink-0 rounded-md border border-edge bg-surface-2 px-2.5 py-1 text-xs text-gray-300 hover:text-gray-100"
                    >
                      Show slowest
                    </button>
                  </div>
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
