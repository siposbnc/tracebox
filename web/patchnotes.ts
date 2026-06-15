// AUTO-GENERATED from CHANGELOG.md by scripts/gen-patchnotes.mjs — do not edit.
import type { PatchNote } from './types';

export const patchNotes: PatchNote[] = [
  {
    "version": "1.0.0",
    "date": "2026-06-15",
    "sections": [
      {
        "title": "Added",
        "items": [
          "Initial release — a fast, fully offline log reader for multi-gigabyte files (modern rewrite of the Local Log Processor WPF app).",
          "Sparse line-offset index (one checkpoint per 64 lines) for random access to any line of multi-million-line files with a single seek.",
          "Full-text search backed by built-in `node:sqlite` FTS5 — no native modules.",
          "Kibana-style query language with a recursive-descent parser: `AND`/`OR`/`NOT`, parentheses, phrases, field equality, numeric/time comparisons, wildcards, and field-exists checks.",
          "Structured parsing with format auto-detection: JSON lines (nested fields flattened to dot-paths), timestamped app logs, Apache/nginx access logs, syslog, logfmt, Python logging, and a level/timestamp-sniffing raw fallback.",
          "Live tail (`tail -f`) with incremental indexing and search extension over appended lines.",
          "Persistent index cache fingerprinted by path + size + mtime; reopening an unchanged file is instant.",
          "Time histogram (stacked per-level volume) with drag-to-filter range selection.",
          "Multi-file tabs, detail panel with one-click \"add as filter\", match highlighting, level breakdown filters, and CSV/JSON export of filtered rows.",
          "React 19 + Vite 7 + Tailwind 4 UI with virtualized rows (`@tanstack/react-virtual`).",
          "Electron desktop app (Windows): NSIS installer, file associations and \"Open with TraceBox\" verbs for `.log`/`.txt`/`.jsonl`/`.ndjson`/`.out`, double-click / drag-and-drop / native picker open, single-instance tabs.",
          "100% offline operation — the server binds to `127.0.0.1` only."
        ]
      }
    ]
  }
];
