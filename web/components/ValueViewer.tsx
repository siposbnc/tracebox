import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useEscapeKey } from '../escStack';
import { matchCommand } from '../keybindings';

/**
 * Magnifier button shown on hover next to a field value; opens it in the
 * {@link ValueViewer}. Relies on a `group`/`group-hover` ancestor for reveal.
 */
export function ViewButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Open in visualizer"
      className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-gray-500 opacity-0 transition-opacity hover:text-sky-300 group-hover:opacity-100"
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="7" cy="7" r="4.5" />
        <line x1="10.5" y1="10.5" x2="14.5" y2="14.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/**
 * Full-screen reader for a single field value. Opened from the detail panel's
 * per-value magnifier, it gives long values (stack traces, payloads, SQL) room
 * to breathe, with in-text search highlighting + match navigation and copy.
 */
export default function ValueViewer({
  label,
  value,
  onClose,
}: {
  /** The field key or JSON path the value came from. */
  label: string;
  value: string;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState(0);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const markRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEscapeKey(onClose, 'modal');

  // case-insensitive literal search; reset the active match whenever it changes
  const regex = useMemo(() => {
    const term = search.trim();
    if (!term) return null;
    try {
      return new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    } catch {
      return null;
    }
  }, [search]);

  // split the value into alternating [text, match, text, match, …] segments
  const segments = useMemo(() => (regex ? value.split(regex) : [value]), [regex, value]);
  const matchCount = regex ? (segments.length - 1) / 2 : 0;

  useEffect(() => {
    setCurrent(0);
  }, [search]);

  // keep the active match scrolled into view
  useLayoutEffect(() => {
    if (matchCount > 0) markRefs.current[current]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [current, matchCount, segments]);

  const step = useCallback(
    (delta: number): void => {
      if (matchCount === 0) return;
      setCurrent((c) => (c + delta + matchCount) % matchCount);
    },
    [matchCount],
  );

  // the global next/previous-match hotkeys (F3 / Shift+F3 by default) drive the
  // viewer's search too, alongside the local Enter / Shift+Enter
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const cmd = matchCommand(e);
      if (cmd === 'nextMatch') {
        e.preventDefault();
        step(1);
      } else if (cmd === 'prevMatch') {
        e.preventDefault();
        step(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const copy = (): void => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  // render the segments, wrapping every other one in a highlight mark
  markRefs.current = [];
  const body = segments.map((part, i) => {
    if (i % 2 === 0) return part;
    const matchIndex = (i - 1) / 2;
    const active = matchIndex === current;
    return (
      <mark
        key={i}
        ref={(el) => {
          markRefs.current[matchIndex] = el;
        }}
        className={active ? 'bg-amber-400 text-black' : 'bg-amber-400/30 text-amber-100'}
      >
        {part}
      </mark>
    );
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[1000px] max-w-[95vw] flex-col overflow-hidden rounded-xl border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm font-semibold text-sky-300" title={label}>
              {label}
            </div>
            <div className="text-[11px] text-gray-500">{value.length.toLocaleString()} characters</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={copy}
              className="rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-gray-300 hover:text-gray-100"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={onClose}
              className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
              // clear the search first; let an empty-search Escape bubble to the
              // stack so it closes the viewer
              if (e.key === 'Escape' && search) {
                e.stopPropagation();
                setSearch('');
              }
            }}
            placeholder="Search in value…"
            autoComplete="off"
            spellCheck={false}
            className="w-64 rounded border border-edge bg-surface-0 px-2 py-1 text-xs text-gray-100 outline-none focus:border-sky-600"
          />
          {search && (
            <>
              <span className="text-xs tabular-nums text-gray-500">
                {matchCount > 0 ? `${current + 1} / ${matchCount.toLocaleString()}` : 'No matches'}
              </span>
              <button
                onClick={() => step(-1)}
                disabled={matchCount === 0}
                className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 text-xs text-gray-400 hover:text-gray-100 disabled:opacity-40"
                title="Previous match (Shift+Enter)"
              >
                ↑
              </button>
              <button
                onClick={() => step(1)}
                disabled={matchCount === 0}
                className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 text-xs text-gray-400 hover:text-gray-100 disabled:opacity-40"
                title="Next match (Enter)"
              >
                ↓
              </button>
            </>
          )}
        </div>

        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-surface-0 p-4 font-mono text-[13px] leading-6 text-gray-200">
          {body}
        </pre>
      </div>
    </div>
  );
}
