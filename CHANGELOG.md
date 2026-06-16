# Changelog

All notable changes to TraceBox are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Group entries under a version heading using these categories, in this order:
`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. Put work in
progress under `## [Unreleased]`; on release, rename it to the new version with a
date and start a fresh `Unreleased` section.

## [Unreleased]

### Changed

- Redesigned the toolbar into two clearer rows: search (with history and syntax
  help) plus the primary Tail / Open / shortcuts / settings actions on top, and a
  grouped control strip below — panels (histogram, fields, patterns, bookmarks),
  view modes (group, highlight, wrap, columnar), display (timezone, order), and
  actions (refresh, export) — separated by dividers. Nothing was removed; the
  controls are just organized and labelled more clearly.

### Added

- Merged timeline: with two or more files open, the new "Timeline" tab shows
  every file's lines interleaved in timestamp order — each row tagged with its
  source — for correlating events across services. A Files menu picks which open
  files to include. Supports cross-file search/filter and highlight, a combined
  histogram (drag to jump to a time), a detail panel, context peek, bookmarks,
  word wrap, page/Home/End navigation, multi-line "+N" badges, and click-a-row's
  ↗ to open it in its own tab. Built on demand from the per-file indexes;
  Refresh rebuilds.
- Columnar view (toolbar toggle): render structured logs as a grid of chosen
  fields instead of raw lines — line number, time, and level as fixed columns
  plus any flattened fields you pick from the Columns menu, with a sticky header
  and horizontal scroll. The column selection is remembered per file.
- Word wrap (toolbar toggle / settings / Ctrl+W): long lines wrap instead of
  being truncated, with the row list re-measuring heights so scrolling stays
  smooth.
- Copy rows: the Export menu can copy the current view's rows (up to 10,000) to
  the clipboard as multi-line text, complementing the per-line/record copy in the
  detail panel and the full CSV/JSON export.
- Log clustering (toolbar "Patterns" panel): collapses near-identical lines into
  templates — variable tokens (numbers, ids, timestamps) masked to `<*>` — ranked
  by count, so the distinct shapes of a log are visible at a glance. Counts
  respect the active search; click a pattern to drill the view down to just that
  cluster (combinable with a text query), click again to clear. Stack-trace
  continuation lines are excluded so they don't pollute the patterns.
- Cycle file tabs with Ctrl+Tab / Ctrl+Shift+Tab (rebindable).
- Line-jump navigation (all rebindable): Page Down / Page Up move the selection
  by a configurable number of rows (default 100), Ctrl/Cmd + Page Down / Up move
  a bigger configurable amount (default 1000), and Home / End jump to the top /
  bottom of the list.
- Find next/previous match in highlight mode: F3 / Shift+F3 jump to and select
  the next / previous matching line (rebindable).
- Multi-line grouping (toolbar toggle, on by default): stack traces and wrapped
  messages fold into their parent log entry, so each logical event is one row
  with a "+N" badge; opening it shows the full multi-line record. Search treats
  a record as a unit — matching text inside a stack trace surfaces the parent
  entry once. Continuation lines are detected per format (timestamp/level for
  app logs, indentation and JVM markers otherwise).
- Settings panel (toolbar gear) consolidating display preferences: row order,
  timestamp timezone, default context-peek lines, and whether the histogram
  shows by default. Includes a shortcut to the keyboard-shortcuts editor.
- Keyboard shortcuts overlay (Ctrl/Cmd+/ or the toolbar keyboard button) listing
  every shortcut. Shortcuts are now rebindable: click one and press the new keys
  (Backspace unbinds, Esc cancels); per-shortcut and "reset all" restore the
  defaults. Bindings persist locally and are shared across tabs.

- Bookmarks: click the flag on any line to mark it (or press Ctrl/Cmd+B on the
  selected line); marks persist per file and are listed in a new toolbar menu.
  Press F2 / Shift+F2 to jump to the next / previous bookmark.
- Go to line: jump to any line number with Ctrl/Cmd+G (or from the bookmarks
  menu).
- Highlight without filtering: a toolbar toggle (Ctrl/Cmd+H) that marks the
  lines matching the active search in place — showing the whole file with hits
  flagged — instead of hiding the non-matching lines.
- Field breakdown (faceting): a new "Fields" sidebar (toolbar toggle) lists the
  structured fields detected in the file; expanding one shows its top values
  with counts and share bars for the current view. Counts respect the active
  search, so you can pivot a result set ("which `host`s? which `status`
  codes?"). Click a value to filter to it, or the − button to exclude it.
- Local time toggle: a toolbar button switches all timestamps between UTC and
  the host's local timezone (rows, detail panel, histogram, and context peek).
  The active zone is shown explicitly (e.g. `UTC`, `GMT+2`) so a timestamp is
  never ambiguous. The choice persists across files and sessions.

### Fixed

- Default context-peek window is 5 lines again (it had become 0 when the setting
  was unset, because the stored value parsed as 0).

## [1.2.0] - 2026-06-15

### Added

- Context around matches (grep -C): while a search filter is active, hover a
  result row and click "± context" to peek at the surrounding (unfiltered)
  lines. The window can be grown before/after, other hits in the window are
  marked, and clicking any line opens it in the full, unfiltered view.
- Inline query autocomplete: as you type, the search bar suggests field names,
  `level:` values, and boolean operators (`AND`/`OR`/`NOT`). Tab to complete,
  ↑/↓ to choose, Enter to run.
- Search history and saved searches: recent queries are remembered and a query
  can be saved under a name for one-click reuse, both available from the new
  history button in the toolbar. Stored locally and shared across tabs.

### Fixed

- Quoted field values now honor wildcards, so a value containing spaces can be
  matched, e.g. `message:"*request started*"`. Previously a quoted value was
  always treated as an exact match and the `*` was ignored.

## [1.1.0] - 2026-06-15

### Added

- "What's new" view that lists the changes and fixes in each release (generated
  from this changelog). It opens automatically once on the first launch after an
  update, and is always available from the toolbar and welcome screen.
- Automatic updates (desktop app): TraceBox checks GitHub releases on launch
  (and every 6 hours) and shows an in-app banner when a new version is
  available. The user opts in to the download, then installs it with one click
  ("Restart & update") — no manual re-download or reinstall. Powered by
  `electron-updater`.
- Manual refresh button to reload the active file and pick up appended lines
  on demand (without enabling tail follow).
- Global row order setting (oldest-first / newest-first) toggled from the
  toolbar; the choice persists across files and sessions. Tail follow tracks the
  live edge in either direction.

## [1.0.0] - 2026-06-15

### Added

- Initial release — a fast, fully offline log reader for multi-gigabyte files
  (modern rewrite of the Local Log Processor WPF app).
- Sparse line-offset index (one checkpoint per 64 lines) for random access to any
  line of multi-million-line files with a single seek.
- Full-text search backed by built-in `node:sqlite` FTS5 — no native modules.
- Kibana-style query language with a recursive-descent parser: `AND`/`OR`/`NOT`,
  parentheses, phrases, field equality, numeric/time comparisons, wildcards, and
  field-exists checks.
- Structured parsing with format auto-detection: JSON lines (nested fields
  flattened to dot-paths), timestamped app logs, Apache/nginx access logs,
  syslog, logfmt, Python logging, and a level/timestamp-sniffing raw fallback.
- Live tail (`tail -f`) with incremental indexing and search extension over
  appended lines.
- Persistent index cache fingerprinted by path + size + mtime; reopening an
  unchanged file is instant.
- Time histogram (stacked per-level volume) with drag-to-filter range selection.
- Multi-file tabs, detail panel with one-click "add as filter", match
  highlighting, level breakdown filters, and CSV/JSON export of filtered rows.
- React 19 + Vite 7 + Tailwind 4 UI with virtualized rows
  (`@tanstack/react-virtual`).
- Electron desktop app (Windows): NSIS installer, file associations and
  "Open with TraceBox" verbs for `.log`/`.txt`/`.jsonl`/`.ndjson`/`.out`,
  double-click / drag-and-drop / native picker open, single-instance tabs.
- 100% offline operation — the server binds to `127.0.0.1` only.

[Unreleased]: https://github.com/siposbnc/tracebox/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/siposbnc/tracebox/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/siposbnc/tracebox/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/siposbnc/tracebox/releases/tag/v1.0.0
