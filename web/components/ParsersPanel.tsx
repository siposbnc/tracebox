import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useEscapeKey } from '../escStack';
import type { CustomParserSpec, ParserTestResult } from '../types';

const META = new Set(['timestamp', 'level', 'message']);

const PLACEHOLDER =
  '^(?<timestamp>\\S+ \\S+) \\[(?<level>\\w+)\\] (?<logger>\\S+) - (?<message>.*)$';

/**
 * Manage user-defined parsers: a regex whose named groups become fields
 * (timestamp/level/message are metadata). Includes a live tester that dry-runs the
 * pattern against the open log (or pasted lines) so you can see what it extracts
 * before saving. Saving re-indexes affected logs on their next open.
 */
export default function ParsersPanel({ onClose, sessionId }: { onClose: () => void; sessionId: string | null }) {
  const [parsers, setParsers] = useState<CustomParserSpec[]>([]);
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [samples, setSamples] = useState('');
  const [test, setTest] = useState<ParserTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.parsers().then((r) => setParsers(r.parsers));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEscapeKey(onClose, 'modal');

  // Live test: debounce changes to the pattern / samples and dry-run against the
  // open session's head (or the pasted lines when provided).
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!pattern.trim()) {
      setTest(null);
      setTestError(null);
      return;
    }
    debounce.current = setTimeout(() => {
      const lines = samples.split('\n').filter((l) => l.length > 0);
      const opts = lines.length > 0 ? { samples: lines } : { sessionId: sessionId ?? undefined, count: 8 };
      if (!opts.samples && !opts.sessionId) {
        setTest(null);
        setTestError('Open a log or paste sample lines to test against.');
        return;
      }
      void api
        .testParser(pattern, opts)
        .then((r) => {
          setTest(r);
          setTestError(null);
        })
        .catch((e: unknown) => {
          setTest(null);
          setTestError(e instanceof Error ? e.message : String(e));
        });
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [pattern, samples, sessionId]);

  const editing = parsers.some((p) => p.name === name.trim());

  const save = (): void => {
    setBusy(true);
    setSaveError(null);
    void api
      .saveParser(name.trim(), pattern)
      .then((r) => {
        setParsers(r.parsers);
        setSaveError(null);
      })
      .catch((e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const remove = (n: string): void => {
    setBusy(true);
    void api
      .removeParser(n)
      .then((r) => setParsers(r.parsers))
      .finally(() => setBusy(false));
  };

  const edit = (p: CustomParserSpec): void => {
    setName(p.name);
    setPattern(p.pattern);
    setSaveError(null);
  };

  const reset = (): void => {
    setName('');
    setPattern('');
    setSamples('');
    setSaveError(null);
  };

  const canSave = name.trim().length > 0 && pattern.trim().length > 0 && !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[680px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
          <h2 className="text-sm font-semibold text-gray-200">
            Custom parsers
            <span className="ml-2 text-xs font-normal text-gray-500">{parsers.length} defined</span>
          </h2>
          <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200" title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="border-b border-edge px-4 py-1.5 text-[11px] text-gray-500">
          A regex whose named groups become fields — <span className="font-mono text-gray-400">timestamp</span>,{' '}
          <span className="font-mono text-gray-400">level</span>, and <span className="font-mono text-gray-400">message</span> are
          metadata; the rest are searchable fields. Capture a number without its unit (
          <span className="font-mono text-gray-400">{'(?<dur>\\d+)ms'}</span>) so <span className="font-mono text-gray-400">dur:&gt;500</span>{' '}
          works. Saved parsers join auto-detection; reopen a log to apply.
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* existing parsers */}
          {parsers.length > 0 && (
            <div className="border-b border-edge">
              {parsers.map((p) => (
                <div key={p.name} className="group flex items-center gap-3 border-b border-edge/40 px-4 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-gray-200">{p.name}</div>
                    <div className="truncate font-mono text-[11px] text-gray-600" title={p.pattern}>
                      {p.pattern}
                    </div>
                  </div>
                  <button
                    onClick={() => edit(p)}
                    className="shrink-0 rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-gray-400 hover:text-gray-100"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove(p.name)}
                    disabled={busy}
                    className="shrink-0 rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-gray-400 hover:text-red-300 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* editor */}
          <div className="space-y-2.5 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-gray-400">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="myapp"
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-edge bg-surface-0 px-2 py-1 font-mono text-xs text-gray-100 outline-none focus:border-sky-600"
              />
              {(name || pattern || samples) && (
                <button onClick={reset} className="shrink-0 rounded px-2 py-1 text-xs text-gray-500 hover:text-gray-300">
                  New
                </button>
              )}
            </div>
            <div className="flex items-start gap-2">
              <span className="w-16 shrink-0 pt-1 text-xs text-gray-400">Pattern</span>
              <textarea
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder={PLACEHOLDER}
                spellCheck={false}
                rows={2}
                className="min-w-0 flex-1 resize-y rounded border border-edge bg-surface-0 px-2 py-1 font-mono text-xs text-gray-100 outline-none focus:border-sky-600"
              />
            </div>
            <div className="flex items-start gap-2">
              <span className="w-16 shrink-0 pt-1 text-xs text-gray-400">Samples</span>
              <textarea
                value={samples}
                onChange={(e) => setSamples(e.target.value)}
                placeholder={sessionId ? 'Testing against the open log — or paste lines here to test those instead' : 'Paste sample log lines to test against'}
                spellCheck={false}
                rows={2}
                className="min-w-0 flex-1 resize-y rounded border border-edge bg-surface-0 px-2 py-1 font-mono text-xs text-gray-100 outline-none focus:border-sky-600"
              />
            </div>

            {/* live tester output */}
            {testError && <div className="rounded border border-red-900/60 bg-red-950/30 px-2 py-1.5 text-xs text-red-400">{testError}</div>}
            {test && (
              <div className="rounded border border-edge bg-surface-0">
                <div className="border-b border-edge/60 px-2 py-1 text-[11px] text-gray-500">
                  Live test — <span className={test.matched === test.total ? 'text-emerald-400' : 'text-amber-400'}>{test.matched}/{test.total}</span>{' '}
                  lines matched
                </div>
                <div className="max-h-44 overflow-y-auto">
                  {test.results.map((r, i) => (
                    <div key={i} className="border-b border-edge/30 px-2 py-1 last:border-b-0">
                      <div className="flex items-start gap-1.5">
                        <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${r.matched ? 'bg-emerald-500' : 'bg-gray-600'}`} />
                        <span className="truncate font-mono text-[11px] text-gray-500" title={r.line}>
                          {r.line}
                        </span>
                      </div>
                      {r.matched && (
                        <div className="ml-3 mt-0.5 flex flex-wrap gap-1">
                          {r.level && <Chip k="level" v={r.level} meta />}
                          {r.ts && <Chip k="time" v={r.ts} meta />}
                          {Object.entries(r.fields)
                            .filter(([k]) => !META.has(k))
                            .map(([k, v]) => (
                              <Chip key={k} k={k} v={v} />
                            ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {saveError && <div className="text-xs text-red-400">{saveError}</div>}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-edge px-4 py-2 text-xs">
          <span className="text-gray-600">Stored in ~/.tracebox/config.json</span>
          <button
            onClick={save}
            disabled={!canSave}
            className="rounded-md border border-sky-700 bg-sky-800/60 px-3 py-1 text-gray-100 hover:bg-sky-700 disabled:opacity-50"
          >
            {editing ? 'Update parser' : 'Save parser'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Chip({ k, v, meta }: { k: string; v: string; meta?: boolean }) {
  return (
    <span
      className={`max-w-[14rem] truncate rounded px-1.5 py-0.5 font-mono text-[10px] ${
        meta ? 'bg-surface-2 text-gray-400' : 'bg-sky-950/60 text-sky-300'
      }`}
      title={`${k}=${v}`}
    >
      <span className="opacity-60">{k}=</span>
      {v}
    </span>
  );
}
