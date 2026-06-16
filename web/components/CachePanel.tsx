import { useCallback, useEffect, useState } from 'react';
import { api, formatBytes, formatCount } from '../api';
import type { CacheInfo, ConfigInfo } from '../types';

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

/** View and evict the on-disk index cache, and configure its location/retention. */
export default function CachePanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<CacheInfo | null>(null);
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);
  const [dirInput, setDirInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void api
      .cache()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    void api.config().then((c) => {
      setCfg(c);
      setDirInput(c.config.cacheDir);
    });
  }, []);

  useEffect(() => {
    load();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [load, onClose]);

  const saveDir = (dir: string): void => {
    setBusy(true);
    setError(null);
    void api
      .setConfig({ cacheDir: dir })
      .then((c) => {
        setCfg(c);
        setDirInput(c.config.cacheDir);
        load();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const saveRetention = (days: number): void => {
    void api.setConfig({ cacheRetentionDays: days }).then(setCfg);
  };

  const evict = (name: string): void => {
    setBusy(true);
    void api
      .evictCache(name)
      .then(load)
      .finally(() => setBusy(false));
  };

  const clearAll = (): void => {
    setBusy(true);
    void api
      .clearCache()
      .then(load)
      .finally(() => setBusy(false));
  };

  const evictable = data ? data.entries.filter((e) => !e.inUse).length : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
          <h2 className="text-sm font-semibold text-gray-200">
            Index cache
            {data && (
              <span className="ml-2 text-xs font-normal text-gray-500">
                {formatBytes(data.totalSize)} · {data.entries.length} files
              </span>
            )}
          </h2>
          <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200" title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="border-b border-edge px-4 py-1.5 text-[11px] text-gray-500">
          Cached so reopening an unchanged file is instant. Safe to evict — files re-index on next open. Open files can't be evicted.
        </div>

        {cfg && (
          <div className="space-y-2 border-b border-edge px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-gray-400">Cache folder</span>
              <input
                value={dirInput}
                onChange={(e) => setDirInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveDir(dirInput);
                }}
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-edge bg-surface-0 px-2 py-1 font-mono text-xs text-gray-100 outline-none focus:border-sky-600"
              />
              <button
                onClick={() => saveDir(dirInput)}
                disabled={busy || dirInput.trim() === cfg.config.cacheDir}
                className="shrink-0 rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-gray-300 hover:text-gray-100 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => saveDir(cfg.defaultCacheDir)}
                disabled={busy || cfg.config.cacheDir === cfg.defaultCacheDir}
                title={`Reset to ${cfg.defaultCacheDir}`}
                className="shrink-0 rounded px-1.5 py-1 text-xs text-gray-500 hover:text-gray-300 disabled:opacity-30"
              >
                Default
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-gray-400">Auto-clear</span>
              <span className="text-xs text-gray-500">unused for</span>
              <input
                type="number"
                min={0}
                value={cfg.config.cacheRetentionDays}
                onChange={(e) => saveRetention(Math.max(0, Number(e.target.value)))}
                className="w-16 rounded border border-edge bg-surface-0 px-2 py-1 text-right font-mono text-xs text-gray-100 outline-none focus:border-sky-600"
              />
              <span className="text-xs text-gray-500">days (0 = never)</span>
            </div>
            <div className="text-[11px] text-gray-600">
              Changing the folder applies to files opened from now on; existing caches stay where they are.
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && <div className="px-4 py-3 text-sm text-red-400">{error}</div>}
          {data && data.entries.length === 0 && !error && (
            <div className="px-4 py-6 text-center text-sm text-gray-500">The index cache is empty.</div>
          )}
          {data?.entries.map((e) => (
            <div key={e.name} className="group flex items-center gap-3 border-b border-edge/40 px-4 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-gray-200" title={e.path}>
                  {baseName(e.path)}
                </div>
                <div className="truncate text-[11px] text-gray-600" title={e.path}>
                  {e.path}
                </div>
              </div>
              <div className="shrink-0 text-right text-[11px] text-gray-500">
                <div className="font-mono text-gray-400">{formatBytes(e.size)}</div>
                {e.lineCount > 0 && <div>{formatCount(e.lineCount)} lines</div>}
              </div>
              {e.inUse ? (
                <span className="w-16 shrink-0 text-center text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                  open
                </span>
              ) : (
                <button
                  onClick={() => evict(e.name)}
                  disabled={busy}
                  className="w-16 shrink-0 rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-gray-400 hover:text-red-300 disabled:opacity-50"
                >
                  Evict
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-edge px-4 py-2 text-xs text-gray-500">
          <span>{evictable} evictable</span>
          <button
            onClick={clearAll}
            disabled={busy || evictable === 0}
            className="rounded-md border border-edge bg-surface-2 px-3 py-1 text-gray-300 hover:text-red-300 disabled:opacity-50"
          >
            Clear all unused
          </button>
        </div>
      </div>
    </div>
  );
}
