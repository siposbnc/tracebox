import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RecentFile } from '../types';

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Header dropdown listing recently-opened files, so a recent file can be
 * reopened without returning to the welcome screen. Recents are server-side;
 * the list is refetched each time the menu opens so it stays current. */
export default function RecentsMenu({
  onOpenPath,
}: {
  onOpenPath: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<RecentFile[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void api.recents().then(setRecents).catch(() => {});
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="relative self-center" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`mb-1.5 rounded-md px-2.5 py-1 text-sm ${
          open ? 'bg-surface-0 text-sky-300' : 'text-gray-400 hover:bg-surface-2 hover:text-gray-100'
        }`}
        title="Open a recent file"
      >
        🕘 Recent
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-80 rounded-lg border border-edge bg-surface-2 shadow-2xl">
          <div className="max-h-[50vh] overflow-y-auto p-1">
            {recents.length === 0 ? (
              <div className="px-2 py-2 text-xs text-gray-600">No recent files yet.</div>
            ) : (
              recents.slice(0, 12).map((r) => (
                <button
                  key={r.path}
                  onClick={() => {
                    onOpenPath(r.path);
                    setOpen(false);
                  }}
                  className="flex w-full min-w-0 flex-col rounded px-2 py-1.5 text-left hover:bg-surface-3"
                  title={r.path}
                >
                  <span className="truncate text-xs text-gray-200">{baseName(r.path)}</span>
                  <span className="truncate text-[10px] text-gray-500">{r.path}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
