import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatBytes } from '../api';
import { useEscapeKey } from '../escStack';
import type { BrowseResult, RecentFile } from '../types';

export default function OpenFileDialog({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (path: string) => Promise<void>;
}) {
  const [roots, setRoots] = useState<string[]>([]);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [recents, setRecents] = useState<RecentFile[]>([]);
  const [pathInput, setPathInput] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  const navigate = useCallback(async (dir: string) => {
    setError(null);
    try {
      const result = await api.browse(dir);
      setBrowse(result);
      setPathInput(result.path);
      setFilter('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void api.roots().then((r) => {
      setRoots(r.roots);
      void navigate(r.home);
    });
    void api.recents().then(setRecents).catch(() => {});
  }, [navigate]);

  useEscapeKey(onClose, 'modal');

  const openFile = useCallback(
    async (file: string) => {
      setOpening(true);
      setError(null);
      try {
        await onOpen(file);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setOpening(false);
      }
    },
    [onOpen],
  );

  const submitPath = useCallback(async () => {
    const p = pathInput.trim();
    if (!p) return;
    // if it points at a file, open it; otherwise browse into it
    try {
      const result = await api.browse(p);
      setBrowse(result);
      setFilter('');
    } catch {
      await openFile(p);
    }
  }, [pathInput, openFile]);

  const entries = (browse?.entries ?? []).filter(
    (e) => filter === '' || e.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-[640px] max-h-[90vh] w-[860px] max-w-[95vw] flex-col overflow-hidden rounded-xl border border-edge bg-surface-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-200">Open log file</h2>
          <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200">
            ×
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
          {roots.map((root) => (
            <button
              key={root}
              onClick={() => void navigate(root)}
              className={`rounded-md border border-edge px-2 py-1 font-mono text-xs ${
                browse?.path.toLowerCase().startsWith(root.toLowerCase())
                  ? 'bg-surface-3 text-sky-300'
                  : 'bg-surface-2 text-gray-400 hover:text-gray-100'
              }`}
            >
              {root.replace(/\\$/, '')}
            </button>
          ))}
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitPath();
            }}
            placeholder="Type or paste a path…"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-edge bg-surface-0 px-2.5 py-1 font-mono text-xs text-gray-200 outline-none focus:border-sky-600"
          />
          <button
            onClick={() => void submitPath()}
            className="rounded-md bg-sky-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-600"
          >
            Go
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-edge/60 px-4 py-1.5">
              <button
                onClick={() => browse?.parent && void navigate(browse.parent)}
                disabled={!browse?.parent}
                className="rounded border border-edge bg-surface-2 px-2 py-0.5 text-xs text-gray-400 hover:text-gray-100 disabled:opacity-40"
              >
                ↑ Up
              </button>
              <input
                ref={filterRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                className="w-44 rounded-md border border-edge bg-surface-0 px-2 py-0.5 text-xs text-gray-200 outline-none focus:border-sky-600"
              />
              <span className="truncate font-mono text-[11px] text-gray-600">{browse?.path}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {error && <div className="px-4 py-3 text-sm text-red-400">{error}</div>}
              {entries.map((e) => (
                <button
                  key={e.path}
                  onClick={() => (e.dir ? void navigate(e.path) : void openFile(e.path))}
                  disabled={opening}
                  className="flex w-full items-center gap-2.5 border-b border-edge/30 px-4 py-1.5 text-left hover:bg-surface-2 disabled:opacity-60"
                >
                  <span className="w-4 text-center text-xs">{e.dir ? '📁' : '📄'}</span>
                  <span className={`min-w-0 flex-1 truncate text-sm ${e.dir ? 'text-gray-300' : 'text-gray-200'}`}>
                    {e.name}
                  </span>
                  {!e.dir && <span className="shrink-0 text-xs text-gray-600">{formatBytes(e.size)}</span>}
                </button>
              ))}
              {browse && entries.length === 0 && !error && (
                <div className="px-4 py-6 text-center text-sm text-gray-600">Empty folder</div>
              )}
            </div>
          </div>

          {recents.length > 0 && (
            <div className="w-64 shrink-0 overflow-y-auto border-l border-edge bg-surface-0/40 p-3">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Recent</h3>
              {recents.map((r) => (
                <button
                  key={r.path}
                  onClick={() => void openFile(r.path)}
                  disabled={opening}
                  className="mb-1 w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-xs text-gray-400 hover:bg-surface-2 hover:text-gray-200"
                  title={r.path}
                >
                  {r.path.split(/[\\/]/).pop()}
                  <span className="block truncate text-[10px] text-gray-600">{r.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {opening && (
          <div className="border-t border-edge px-4 py-2 text-xs text-sky-300">
            <span className="animate-pulse-subtle">Opening file…</span>
          </div>
        )}
      </div>
    </div>
  );
}
