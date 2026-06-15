import { formatBytes, formatCount } from '../api';
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
  onLevelClick,
}: {
  status: SessionStatus;
  total: number;
  onLevelClick: (level: string) => void;
}) {
  const pct = status.fileSize > 0 ? Math.min(100, (status.bytesIndexed / status.fileSize) * 100) : 0;

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

      <span title={status.file} className="max-w-72 truncate text-gray-500">
        {status.file}
      </span>
      <span>{formatBytes(status.fileSize)}</span>
      <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase text-gray-500">
        {status.format}
      </span>

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
