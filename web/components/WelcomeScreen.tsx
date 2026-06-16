import { useEffect, useState } from 'react';
import { api, formatBytes } from '../api';
import type { RecentFile } from '../types';
import { Logo } from './Logo';

export default function WelcomeScreen({
  onOpen,
  onOpenPath,
  onRunCommand,
  onWhatsNew,
}: {
  onOpen: () => void;
  onOpenPath: (path: string) => Promise<void>;
  onRunCommand: () => void;
  onWhatsNew: () => void;
}) {
  const [recents, setRecents] = useState<RecentFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.recents().then(setRecents).catch(() => {});
  }, []);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-surface-0">
      <div className="flex items-center gap-3">
        <Logo className="h-12 w-12" />
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-100">TraceBox</h1>
          <p className="text-sm text-gray-500">Fast offline log reader for huge files</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onOpen}
          className="rounded-xl bg-sky-700 px-6 py-2.5 font-medium text-white shadow-lg shadow-sky-950 hover:bg-sky-600"
        >
          Open a log file…
        </button>
        <button
          onClick={onRunCommand}
          className="rounded-xl border border-edge bg-surface-1 px-4 py-2.5 text-sm font-medium text-gray-300 hover:bg-surface-2 hover:text-gray-100"
        >
          ▸ Run a command…
        </button>
        <button
          onClick={onWhatsNew}
          className="rounded-xl border border-edge bg-surface-1 px-4 py-2.5 text-sm font-medium text-gray-300 hover:bg-surface-2 hover:text-gray-100"
        >
          ✨ What's new
        </button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      {recents.length > 0 && (
        <div className="w-[480px] max-w-[90vw]">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Recent files</h2>
          <div className="overflow-hidden rounded-xl border border-edge">
            {recents.slice(0, 8).map((r) => (
              <button
                key={r.path}
                onClick={() =>
                  void onOpenPath(r.path).catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : String(err)),
                  )
                }
                className="flex w-full items-center justify-between gap-3 border-b border-edge/50 bg-surface-1 px-4 py-2.5 text-left last:border-0 hover:bg-surface-2"
              >
                <span className="truncate font-mono text-sm text-gray-300">{r.path}</span>
                <span className="shrink-0 text-xs text-gray-600">{new Date(r.openedAt).toLocaleDateString()}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="max-w-md text-center text-xs leading-5 text-gray-600">
        Files are indexed locally with SQLite FTS5 — nothing leaves your machine. Multi-gigabyte files
        stream in the background and stay searchable while indexing.
      </p>
    </div>
  );
}
