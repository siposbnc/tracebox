import { useEffect, useState } from 'react';
import { api } from '../api';
import { getBookmarks } from '../bookmarks';
import { getNotes } from '../notes';
import { useEscapeKey } from '../escStack';
import { useRedactor } from '../redaction';
import { buildMarkdown, buildHtml, type ReportEntry, type ReportMeta } from '../report';

const MAX_ENTRIES = 1000;

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function download(name: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Collects the current file's annotations (bookmarked and/or noted lines), fetches
 * their content, and renders a Markdown/HTML report to copy or download.
 */
export default function ReportDialog({
  sessionId,
  file,
  query,
  lineCount,
  onClose,
}: {
  sessionId: string;
  file: string;
  query: string | null;
  lineCount: number;
  onClose: () => void;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [entries, setEntries] = useState<ReportEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEscapeKey(onClose, 'modal');
  const { redact } = useRedactor();

  useEffect(() => {
    let cancelled = false;
    const bookmarks = new Set(getBookmarks(file));
    const notes = getNotes(file);
    const noteMap = new Map(notes.map((n) => [n.lineNo, n.text]));
    const all = [...new Set([...bookmarks, ...notes.map((n) => n.lineNo)])].sort((a, b) => a - b);
    const lines = all.slice(0, MAX_ENTRIES);

    void Promise.all(
      lines.map(async (lineNo): Promise<ReportEntry> => {
        const d = await api.detail(sessionId, lineNo).catch(() => null);
        return {
          lineNo,
          bookmarked: bookmarks.has(lineNo),
          note: noteMap.get(lineNo) ?? '',
          text: redact(d?.record?.text ?? d?.raw ?? ''),
          ts: d?.ts ?? null,
          level: d?.level ?? null,
        };
      }),
    )
      .then((built) => {
        if (cancelled) return;
        const meta: ReportMeta = { file, lineCount, query: query ? redact(query) : query, generatedAt: Date.now() };
        setEntries(built);
        setTruncated(all.length > lines.length);
        setMarkdown(buildMarkdown(meta, built));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, file, query, lineCount, redact]);

  const meta = (): ReportMeta => ({ file, lineCount, query: query ? redact(query) : query, generatedAt: Date.now() });
  const empty = markdown !== null && entries.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[760px] max-w-full flex-col rounded-xl border border-edge bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
          <div className="text-sm font-semibold text-gray-200">
            Export report
            {markdown !== null && !empty && (
              <span className="ml-2 text-xs font-normal text-gray-500">
                {entries.length} annotation{entries.length === 1 ? '' : 's'}
                {truncated && ` (capped at ${MAX_ENTRIES})`}
              </span>
            )}
          </div>
          <button onClick={onClose} className="rounded px-1.5 text-gray-500 hover:bg-surface-2 hover:text-gray-200" title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {error && <div className="text-sm text-red-400">{error}</div>}
          {!markdown && !error && <div className="animate-pulse-subtle text-sm text-gray-500">Gathering annotations…</div>}
          {empty && (
            <div className="text-sm text-gray-500">
              No annotations yet. Bookmark lines (the flag), or add a note from the detail panel, then export.
            </div>
          )}
          {markdown !== null && !empty && (
            <pre className="whitespace-pre-wrap break-words rounded-md border border-edge bg-surface-0 p-3 font-mono text-xs leading-5 text-gray-300">
              {markdown}
            </pre>
          )}
        </div>

        {markdown !== null && !empty && (
          <div className="flex items-center justify-end gap-2 border-t border-edge px-4 py-2.5">
            <button
              onClick={() => {
                void navigator.clipboard.writeText(markdown);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded-lg bg-sky-700/70 px-3 py-1.5 text-sm font-medium text-sky-50 hover:bg-sky-600/70"
            >
              {copied ? 'Copied ✓' : 'Copy Markdown'}
            </button>
            <button
              onClick={() => download(`${baseName(file)}-report.md`, 'text/markdown', markdown)}
              className="rounded-lg border border-edge bg-surface-2 px-3 py-1.5 text-sm text-gray-300 hover:text-gray-100"
            >
              Download .md
            </button>
            <button
              onClick={() => download(`${baseName(file)}-report.html`, 'text/html', buildHtml(meta(), entries))}
              className="rounded-lg border border-edge bg-surface-2 px-3 py-1.5 text-sm text-gray-300 hover:text-gray-100"
            >
              Download .html
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
