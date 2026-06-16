import { useEffect, useRef, useState } from 'react';
import { useBookmarks, toggleBookmark, clearBookmarks } from '../bookmarks';
import { useNotes } from '../notes';
import { formatChord } from '../keybindings';

/** Toolbar dropdown listing the current file's bookmarks and notes; click one to
 * jump, or export them all as a report. */
export default function BookmarksMenu({
  file,
  onJump,
  onGoToLine,
  onExportReport,
  bindings,
}: {
  file: string;
  onJump: (lineNo: number) => void;
  onGoToLine: () => void;
  onExportReport: () => void;
  bindings: Record<string, string>;
}) {
  const marks = useBookmarks(file);
  const notes = useNotes(file);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-sm ${
          open ? 'bg-surface-3 text-amber-300' : 'bg-surface-2 text-gray-400 hover:text-gray-100'
        }`}
        title="Bookmarks"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill={marks.length > 0 ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
          <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
        </svg>
        {marks.length > 0 && <span className="text-xs">{marks.length}</span>}
        {notes.length > 0 && <span className="text-xs text-amber-400" title={`${notes.length} note(s)`}>●</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border border-edge bg-surface-2 shadow-2xl">
          <button
            onClick={() => {
              setOpen(false);
              onGoToLine();
            }}
            className="flex w-full items-center justify-between border-b border-edge px-2 py-1.5 text-xs text-gray-300 hover:bg-surface-3"
          >
            <span>Go to line…</span>
            {bindings.goToLine && <span className="text-[10px] text-gray-500">{formatChord(bindings.goToLine)}</span>}
          </button>
          <div className="flex items-center justify-between border-b border-edge px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Bookmarks
            </span>
            {marks.length > 0 && (
              <button
                onClick={() => clearBookmarks(file)}
                className="text-[10px] text-gray-500 hover:text-gray-300"
              >
                Clear all
              </button>
            )}
          </div>
          <div className="max-h-[50vh] overflow-y-auto p-1">
            {marks.length === 0 ? (
              <div className="px-2 py-2 text-xs text-gray-600">
                No bookmarks yet. Click the flag on a line
                {bindings.toggleBookmark ? `, or press ${formatChord(bindings.toggleBookmark)} on a selected line` : ''}.
              </div>
            ) : (
              marks.map((lineNo) => (
                <div
                  key={lineNo}
                  className="group flex items-center gap-2 rounded px-1 hover:bg-surface-3"
                >
                  <button
                    onClick={() => {
                      onJump(lineNo);
                      setOpen(false);
                    }}
                    className="min-w-0 flex-1 py-1 text-left font-mono text-xs text-gray-300"
                  >
                    Line {(lineNo + 1).toLocaleString()}
                  </button>
                  <button
                    onClick={() => toggleBookmark(file, lineNo)}
                    className="shrink-0 rounded px-1 text-gray-600 opacity-0 hover:text-red-300 group-hover:opacity-100"
                    title="Remove bookmark"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
          {notes.length > 0 && (
            <>
              <div className="border-y border-edge px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Notes
              </div>
              <div className="max-h-[30vh] overflow-y-auto p-1">
                {notes.map((n) => (
                  <button
                    key={n.lineNo}
                    onClick={() => {
                      onJump(n.lineNo);
                      setOpen(false);
                    }}
                    className="flex w-full flex-col gap-0.5 rounded px-1.5 py-1 text-left hover:bg-surface-3"
                  >
                    <span className="font-mono text-[10px] text-amber-300/80">Line {(n.lineNo + 1).toLocaleString()}</span>
                    <span className="line-clamp-2 text-xs text-gray-300">{n.text}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <button
            onClick={() => {
              setOpen(false);
              onExportReport();
            }}
            disabled={marks.length === 0 && notes.length === 0}
            className="flex w-full items-center gap-2 border-t border-edge px-2 py-1.5 text-xs text-gray-300 hover:bg-surface-3 disabled:cursor-default disabled:text-gray-600 disabled:hover:bg-transparent"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M5 3h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M9 13h6M9 17h4" />
            </svg>
            Export report…
          </button>

          {marks.length > 0 && (bindings.nextBookmark || bindings.toggleBookmark) && (
            <div className="border-t border-edge/60 px-2 py-1 text-[10px] text-gray-600">
              {bindings.nextBookmark && `${formatChord(bindings.nextBookmark)} / ${formatChord(bindings.prevBookmark)} to cycle`}
              {bindings.nextBookmark && bindings.toggleBookmark && ' · '}
              {bindings.toggleBookmark && `${formatChord(bindings.toggleBookmark)} to toggle`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
