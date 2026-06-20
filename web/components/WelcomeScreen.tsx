import { useEffect, useState } from 'react';
import { api, formatBytes } from '../api';
import type { RecentFile } from '../types';
import { Logo } from './Logo';

export default function WelcomeScreen({
  onOpen,
  onOpenPath,
  onRunCommand,
  onWhatsNew,
  onSettings,
}: {
  onOpen: () => void;
  onOpenPath: (path: string) => Promise<void>;
  onRunCommand: () => void;
  onWhatsNew: () => void;
  onSettings: () => void;
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
        <button
          onClick={onSettings}
          className="flex items-center gap-2 rounded-xl border border-edge bg-surface-1 px-4 py-2.5 text-sm font-medium text-gray-300 hover:bg-surface-2 hover:text-gray-100"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Settings
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
