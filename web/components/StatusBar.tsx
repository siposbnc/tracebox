import { useEffect, useRef, useState } from 'react';
import { api, formatBytes, formatCount } from '../api';
import type { SessionStatus } from '../types';

const LEVEL_DOT: Record<string, string> = {
  TRACE: 'bg-slate-500',
  DEBUG: 'bg-slate-400',
  INFO: 'bg-sky-500',
  WARN: 'bg-amber-500',
  ERROR: 'bg-red-500',
  FATAL: 'bg-fuchsia-500',
};

const LEVEL_ORDER = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

export default function StatusBar({
  status,
  total,
  selectedCount,
  onLevelClick,
  onSelectParser,
  onStop,
}: {
  status: SessionStatus;
  total: number;
  /** Rows in the active multi-row selection (0 when none). */
  selectedCount: number;
  onLevelClick: (level: string) => void;
  /** Force a parser (re-indexes), or null to return to auto-detection. */
  onSelectParser: (name: string | null) => void;
  onStop: () => void;
}) {
  const pct = status.fileSize > 0 ? Math.min(100, (status.bytesIndexed / status.fileSize) * 100) : 0;
  const capture = status.capture;

  return (
    <div className="flex h-7 items-center gap-4 border-t border-edge bg-surface-1 px-3 text-[11px] text-gray-400">
      <div className="flex items-center gap-2">
        {status.phase === 'indexing' && (
          <>
            <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-sky-500 transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-sky-300">indexing {pct.toFixed(0)}%</span>
          </>
        )}
        {status.phase === 'finalizing' && (
          <span className="animate-pulse-subtle text-sky-300">building search index…</span>
        )}
        {status.phase === 'ready' && (
          <span className="flex items-center gap-1 text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            ready{status.reusedIndex ? ' · index reused' : ''}
          </span>
        )}
        {status.phase === 'error' && <span className="text-red-400">error: {status.error}</span>}
      </div>

      {capture ? (
        <span title={capture.command} className="flex max-w-72 items-center gap-1.5 truncate text-gray-500">
          <span className="text-gray-600">▸</span>
          <span className="truncate font-mono text-gray-400">{capture.command}</span>
        </span>
      ) : (
        <span title={status.file} className="max-w-72 truncate text-gray-500">
          {status.file}
        </span>
      )}

      {capture &&
        (capture.state === 'running' ? (
          <span className="flex items-center gap-1.5">
            <span className="flex items-center gap-1 text-sky-300">
              <span className="h-1.5 w-1.5 animate-pulse-subtle rounded-full bg-sky-400" />
              capturing
            </span>
            <button
              onClick={onStop}
              className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-gray-300 hover:bg-surface-3 hover:text-white"
              title="Stop the command and freeze the captured data"
            >
              ◼ Stop
            </button>
          </span>
        ) : capture.state === 'failed' ? (
          <span className="text-red-400" title={capture.error ?? undefined}>
            ⚠ failed{capture.error ? `: ${capture.error}` : ''}
          </span>
        ) : (
          <span className="text-gray-500">
            ◼ stopped{capture.exitCode !== null ? ` · exit ${capture.exitCode}` : ''}
          </span>
        ))}

      <span>{formatBytes(status.fileSize)}</span>
      <ParserPicker status={status} onSelect={onSelectParser} />

      <div className="flex-1" />

      <div className="flex items-center gap-2.5">
        {LEVEL_ORDER.filter((lv) => status.levelCounts[lv]).map((lv) => (
          <button
            key={lv}
            onClick={() => onLevelClick(lv)}
            className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-2"
            title={`Filter level:${lv}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${LEVEL_DOT[lv]}`} />
            <span>
              {lv} {formatCount(status.levelCounts[lv])}
            </span>
          </button>
        ))}
      </div>

      {selectedCount > 1 && (
        <span className="rounded bg-sky-950 px-1.5 py-0.5 text-sky-300" title="Rows selected — Copy grabs just these">
          {formatCount(selectedCount)} selected
        </span>
      )}

      <span className="font-medium text-gray-300">
        {status.search ? (
          <>
            {formatCount(total)} <span className="text-gray-500">of</span> {formatCount(status.lineCount)} lines
          </>
        ) : (
          <>{formatCount(status.lineCount)} lines</>
        )}
      </span>
    </div>
  );
}

/** The format chip, doubling as a menu to override the auto-detected parser. */
function ParserPicker({
  status,
  onSelect,
}: {
  status: SessionStatus;
  onSelect: (name: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [parsers, setParsers] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const ready = status.phase === 'ready';

  useEffect(() => {
    if (!open) return;
    // refresh the list every time the menu opens, so a parser added since the file
    // was opened (e.g. via the MCP server) appears without reloading the app
    void api.sessionParsers(status.id).then((r) => setParsers(r.available)).catch(() => {});
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, status.id]);

  const choose = (name: string | null): void => {
    setOpen(false);
    onSelect(name);
  };
  const itemCls = (active: boolean): string =>
    `flex w-full items-center justify-between gap-2 px-2 py-1 text-left font-mono text-[11px] ${
      active ? 'text-sky-300' : 'text-gray-300 hover:bg-surface-3'
    }`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => ready && setOpen((v) => !v)}
        disabled={!ready}
        className={`flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase ${
          ready ? 'text-gray-400 hover:bg-surface-3 hover:text-gray-200' : 'text-gray-600'
        }`}
        title={
          status.parserForced
            ? `Parser: ${status.format} (manually selected) — click to change`
            : `Parser: ${status.format} (auto-detected) — click to override`
        }
      >
        {status.format}
        {status.parserForced && <span className="text-sky-400" title="Manually selected">●</span>}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 max-h-72 w-44 overflow-y-auto rounded-lg border border-edge bg-surface-2 py-1 shadow-2xl">
          <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-gray-500">Parser</div>
          <button onClick={() => choose(null)} className={itemCls(!status.parserForced)}>
            <span className="lowercase">auto-detect</span>
            {!status.parserForced && <span>✓</span>}
          </button>
          <div className="my-1 border-t border-edge/60" />
          {parsers.map((name) => {
            const active = status.parserForced && status.format === name;
            return (
              <button key={name} onClick={() => choose(name)} className={itemCls(active)}>
                <span>{name}</span>
                {active && <span>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
