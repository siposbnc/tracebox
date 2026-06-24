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

- **Columnar: the built-in columns are now first-class.** The line number, time,
  and level columns can be hidden (Columns menu → **Built-in columns**), dragged to
  reorder, and resized in the grid header, just like data columns — so you can drop
  the columns you don't need or move time/level wherever you want. The line-number
  column is now resizable too. Existing column layouts are migrated automatically.

### Fixed

- **Columnar word wrap.** Word wrap now applies in the columnar view too: cells
  wrap within their column and the row grows to fit, instead of always clipping.
- **Columnar time column no longer overlaps its divider.** A long timestamp is
  clipped to the column width (or wraps, with wrap on) instead of bleeding across
  the divider into the next column.
- **Columnar Δt is left-aligned.** The Δt column was right-aligned while every
  other column was left-aligned; it now lines up with the rest.
- **"What's new" renders inline markdown.** Bullet lead-ins and emphasis showed
  raw markdown (`**bold**`, `*italic*`); they now render as bold, italic, code,
  and links — not just `code` spans.

## [1.5.0] - 2026-06-24

### Added

- **Triage on open.** When a file finishes indexing, a "what's wrong" landing
  dashboard surfaces the level breakdown, the top log-pattern clusters among
  errors, activity spikes & gaps, and a slowest-field summary (p50/p95/max) —
  each finding clickable to drill straight into the matching view. Auto-opens by
  default (toggle in **Settings → Triage on open**) and reopens from the toolbar.
- **Δt column.** An optional column (**Settings → Δt column**) shows the time gap
  to the previous row, so stalls and latency jumps stand out inline — colour-graded
  (amber past 1 s / 5 s, red past a minute). It follows the active filter and order
  (the gap is to the previous *matching* row), in both the raw and columnar views.
- **Optional level accent bars.** The small colored bar before WARN/ERROR/FATAL
  rows in the raw view can be switched off in **Settings → Level accent bars**, so
  every row lines up at the same position regardless of level. On by default.
- **Live filtered tail.** Tailing now keeps *any* active query applied as the file
  grows — including whole-line `/regex/`, ad-hoc capture filters (`dur:>500`), and
  regex mode, which previously froze as a snapshot while tailing. Appended lines
  are verified against the filter and only the matches stream into the view
  (`tail -f | grep`). Plain field/term filters already did this; now every query
  type does.
- **Redaction for sharing.** A toolbar toggle (**Ctrl/Cmd+Shift+R**, rebindable, or
  **Settings → Redaction**) masks sensitive values — emails, IPv4/IPv6, JWTs, `Bearer`/`key=secret` pairs,
  Luhn-checked card numbers, and long opaque tokens — across the view (so
  screenshots are masked too), the Markdown/HTML report, copy-to-clipboard, and
  the CSV/JSON export. Each built-in category can be switched off and you can add
  your own regex patterns, with a live preview. Search and all analysis keep
  running on the real, unmasked data — only what's shown or exported is masked.
- **Filter breadcrumb.** The active query shows as a funnel of removable chips
  beneath the search bar — the whole-file count, then each top-level clause with
  the running match count after it (`194,917 → level:error 24,205 → connection
  4,832`). Pop any clause with × to widen the search, or **Clear all**. Counts
  follow the current grouping and never disturb the active result set; a
  top-level `OR` query stays a single chip.
- **Ad-hoc capture fields.** Define a throwaway named-regex capture (e.g.
  `(?<dur>\d+)ms`) from the columnar column picker — with a live preview of what
  it extracts — and immediately use it as a column, **filter** on it in the query
  language (`dur:>500`, `dur:*`, `dur:~…`), and **break it down** in the field
  panel. Captures are evaluated against the raw line text (reusing the whole-line
  regex path), so they work on any already-indexed file without committing a full
  custom parser.
- **Appearance settings: themes and font size.** Settings → Appearance adds a
  **Theme** choice — Dark (the default), **Light**, and **High contrast** — and a
  **Font size** for log content (S / M / L / XL), which scales the rows, columnar
  cells, context peek, and value viewer together. Both persist and are applied
  before the first paint, so there's no flash on launch.
- **Hotkey for context peek.** Press **C** (rebindable in Settings → Shortcuts)
  to open the "grep -C" surrounding-lines peek for the selected line, in both the
  single-file and merged timeline views.
- **Open a field value in the visualizer.** Hover a value in the detail panel
  (flat or JSON view) and click the magnifier to open it in a large reader modal
  — room for long values like stack traces, payloads, or SQL. The reader has
  **Copy** and an in-text **search** that highlights every match with
  next/previous navigation (Enter / Shift+Enter, or the global next/previous-match
  hotkeys — F3 / Shift+F3 by default).

### Changed

- **Clearer columnar grid.** The columnar view now draws visible dividers between
  every column, shows a grip handle on each column header (with a drop-position
  indicator while dragging), and a wider, highlight-on-hover resize handle on the
  column edge — so reordering and resizing columns are easy to find and do.
- **Settings panel, reorganized.** The growing flat list is now grouped into
  labeled cards — **Appearance**, **Log display**, **Navigation**, and **Manage**
  — and the sub-panel entry points (shortcuts, parsers, redaction, MCP, cache) are
  full-row links instead of right-aligned buttons. The panel scrolls if it
  outgrows the window.
- **Detail panel: one structured view, not two.** The flattened **Fields** table
  and the JSON tree no longer show the same data side by side. A **Flat / JSON**
  toggle (remembered across lines) switches between them, and JSON is only offered
  when the raw line actually is JSON. The verbatim line/record stays below it.

### Fixed

- **Columnar: a column can be reordered to the rightmost position.** Dropping a
  column on the last one previously always inserted it *before* the target, so the
  final slot was unreachable; the drop side now follows the drag direction.
- **Find next/previous match works from the search bar.** The match-navigation
  hotkeys (F3 / Shift+F3 by default, in highlight mode) now fire while the search
  input is focused, not only when the row list has focus — so you can type a query
  and jump straight through its matches. They yield to an open modal (e.g. the
  value viewer, which has its own match navigation).
- **Search autocomplete matches nested field names anywhere.** Typing `trace` now
  suggests `error.stack_trace`, not just fields that *start* with the text. Matches
  are ranked: whole-field prefixes first, then segment-boundary matches (after a
  `.`/`_`/`-`), then mid-string.
- **Escape now closes one layer at a time.** With several overlays open (e.g. the
  context peek over the detail panel, or the value visualizer over both), Escape
  dismisses the top-most floating window first and the docked panel last, instead
  of collapsing everything at once.

## [1.4.0] - 2026-06-22

### Added

- **Multi-row selection.** Shift+click a row, or Shift+Arrow, to select a span of
  lines; the status bar shows the count and **Copy** grabs just the selection
  (instead of the whole filtered view). Plain click/arrow clears it. **Ctrl/Cmd+C**
  runs the same "copy rows to clipboard" as the Export menu — the selection if any,
  else the whole view — and shows the same "Copied N rows" note. (It defers to the
  browser when you have a text selection, so copying a snippet still works.)
- **Columnar view is now a real table.** Drag a column's right edge to **resize**
  it and drag its header to **reorder** — both persisted per file — and **click a
  cell to filter** the query to that `field:value`. The column picker lists fields
  A→Z with a filter box.
- **Whole-line `/regex/` in the query language.** A bare `/pattern/` term matches
  the whole line and **composes** with everything else — `level:error AND
  /timeout\d+/ AND status:>=500`. It's evaluated in two phases: the surrounding
  field/term filters gather candidate lines from the index first, so the regex
  only scans those lines instead of the whole file (the more selective your other
  filters, the less it reads). Case-insensitive by default, like the rest of the
  language; `AND`/`OR`/`NOT`, grouping, and record grouping all work. This is the
  composable counterpart to the standalone whole-file regex search toggle.
- **Pick the parser.** The format chip in the status bar now shows the parser in
  use and opens a menu to **override it** — handy when a built-in format wins over
  a user-defined one, or you want to force `raw`. Choosing a parser re-indexes the
  file with it; "auto-detect" restores detection. The menu lists the current custom
  parsers each time it opens, so one added meanwhile (e.g. via MCP) is selectable
  right away — no reopen needed.
- **Live rotation following.** Tailing a rotation group is no longer a snapshot:
  it follows the live (newest) member, picking up appends to `app.log` as they
  happen, and continues seamlessly across a roll (logrotate `copytruncate`, or a
  rename + recreate at the same path) — the already-indexed lines stay put while
  new lines stream in. The newly-written bytes are folded into the concatenated
  stream, so search, histogram, and watch rules all keep working over the group.
- **Histogram interactions.** The time-volume histogram is now a control surface:
  a **clear control** for the drag-selected time range (also drawn as a persistent
  band so you can see what's filtered), and a **selectable bucket resolution**
  (50/100/200/400) to trade detail for breadth.
- **Regular-expression matching inside the query language**: `field:~pattern`
  matches a field value against a regex (case-insensitive), so it composes with
  the rest of a query — `level:error AND msg:~"time(d)? out" AND status:>=500`.
  It evaluates against the index (no full-file scan), unlike the whole-line regex
  search toggle. Quote the pattern to include spaces, parentheses, or quotes.
- **User-defined parsers** — teach TraceBox a proprietary log format: a named
  regular expression whose capture groups become structured fields (`timestamp`,
  `level`/`level2`, and `message` are treated as record metadata). Custom parsers
  are persisted in `~/.tracebox/config.json` and join format auto-detection
  (preferred over the built-ins). Editing a parser re-indexes affected
  files so their fields are re-extracted. Capture a number without its unit
  (`(?<duration>\d+)ms`) to make it numeric-comparable (`duration:>5000`). Manage
  them in **Settings → Custom parsers**, with a **live tester** that dry-runs the
  regex against the open log (or pasted lines) and shows the extracted fields
  before you save. Also drivable from the MCP server with `test_parser`,
  `add_parser`, `remove_parser`, and `list_parsers`.
- **MCP server** — drive TraceBox from AI agents over the Model Context Protocol
  (`npm run mcp`, a stdio server). An agent opens and indexes a log, then searches
  and pages with the full query language and pulls aggregates (stats, histogram,
  clusters, field facets) — returning only the matching lines and summaries
  instead of streaming a multi-gigabyte file through its context window. Tools:
  `open_log`, `list_sessions`, `close_log`, `search`, `get_lines`, `get_context`,
  `get_record`, `fields`, `facet`, `stats`, `histogram`, `clusters`, `table`,
  `build_report`, plus `test_parser`/`add_parser`/`remove_parser`/`list_parsers`
  for user-defined formats. `table` is like `search` but projects only the fields
  you ask for as a compact table (column names once, then rows as value arrays),
  so an agent doesn't have to post-process large result sets. `build_report` is the
  deliverable step: the agent supplies a title, summary, and sections that cite
  evidence by line number, and TraceBox fills each citation with the **real indexed
  line** (timestamp, level, text) so the report quotes logs verbatim rather than
  paraphrasing them — rendered as **Markdown or HTML** and written to a file when
  `savePath` is given. The aggregates (`facet`, `stats`, `histogram`, `clusters`) take an
  optional `query` to scope themselves in a single call — pass `""` for the whole
  file or omit it to reuse the active search — so an agent need not run a separate
  `search` first; `histogram` also takes `maxBuckets` to keep its output compact.
  It reuses the same session/query engine as the UI and is hand-rolled with no SDK
  and no runtime dependencies, holding no network sockets of its own — the offline,
  zero-dependency guarantees are preserved. The server is **opt-in and off by
  default**: it refuses to start until enabled in **Settings → MCP server**, which
  then shows the command to register it. The desktop build bundles it and launches
  it through the app executable (`ELECTRON_RUN_AS_NODE`) on demand, so an install
  never exposes the toolkit until you turn it on.
- **Watch rules** turn live tailing into light monitoring. Define per-file alerts
  that fire as new lines arrive: a **match** rule on any query (e.g.
  `level:error AND timeout`), or a **rate** rule that fires when matches cross a
  threshold within a sliding window (e.g. "20 errors in 60s"). A new bell button
  on the toolbar opens the rules panel, where you add/enable rules and review
  recent alerts (click one to jump to the matching line). Triggers surface as
  in-app toasts and a per-tab badge — and, in the desktop app, as native OS
  notifications you can opt into per rule. Rules are evaluated by the backend for
  every tailing file, including background tabs, and are saved per file so they
  come back when you reopen it.
- Settings are now reachable without a file open — from a gear button on the
  welcome screen and in the top bar. The settings panel moved out of the per-file
  toolbar to this single global location.
- A **Tail all** button on the merged timeline toggles live tailing for every
  file in the timeline at once. It reads "on" only when all of them are tailing;
  with mixed states it shows off, and clicking it enables tailing on all of them.
- Each open file's tab now shows a blinking green dot while that file is tailing,
  so you can tell at a glance which sources are following live output.
- Clear feedback while a file is opening and indexing. Selecting a file now adds a
  **pending tab with a spinner** immediately (and a loading screen for the very
  first file) instead of leaving you staring at an unchanged tab bar while the
  index spins up, and the row list shows a spinning "Indexing the file…" state
  until the first lines are read — instead of a blank area or a misleading
  "No matching log lines" message.

### Changed

- **Tail now pauses a command/stdin source.** Turning tail off on a `tracebox --
  <command>` (or stdin) session pauses reading its output — the producer is
  back-pressured and the view stops growing — and turning tail back on resumes
  from where it left off and drains what buffered. Previously a command kept
  streaming into the index regardless of the tail toggle.
- **User-defined parsers now take precedence over built-ins.** If any of your
  custom parsers parses a file well enough, it wins detection outright — even over
  a built-in format that would match more lines — because you defined it on purpose.
  (Previously a higher-scoring built-in could win.) You can still override the
  choice from the status-bar parser picker.
- Reports now **render Markdown in notes** in the HTML output — bold, lists, links,
  and inline code show formatted instead of literal. Applies to the app's HTML
  report export and the MCP `build_report` HTML format (its summary/section prose).
- The rotated-files offer now **names the files** it found (e.g. "Found 2 rotated
  files alongside this log: app.log.1, app.log.2") so you can decide by name before
  opening the group as one stream.
- The merged timeline is now **live**: while its files are tailing (or are
  command/capture sources), appended lines fold into the timeline as they arrive
  and slot into their place in time order — no manual Refresh needed. The view
  sticks to the live edge when you're already scrolled there, an active search
  keeps matching new lines, and the histogram updates as data streams in.

### Fixed

- Config changes made by the **MCP server** (e.g. `add_parser`) are now reflected
  in the app without a restart — the server re-reads `config.json` when it changes
  on disk instead of caching it for the process lifetime, so a parser added by an
  agent shows up the next time **Settings → Custom parsers** is opened.
- Clicking a level in the status bar now **narrows the current query** instead of
  replacing it: the clicked `level:` filter is appended to whatever you've already
  searched, and an existing level clause is updated in place rather than stacked.
- Dragging a time range on the histogram now **updates the existing timestamp
  filter** in place instead of appending another, so repeatedly narrowing the
  selection no longer stacks `timestamp:` clauses in the query.
- Running a search now filters the row list immediately. The list previously kept
  showing unfiltered rows until you toggled Highlight matches on and off again:
  the row blocks loaded before the search were only being invalidated as if data
  had been appended to the tail, so the stale unfiltered rows lingered. Full
  data-set changes (search, grouping, refresh) now discard every loaded block.
- Reopening a file whose contents changed since it was last indexed no longer
  fails with "table templates already exists". The index rebuild now drops the
  `templates` table along with the others before recreating the schema. This
  most often hit regenerated/live test logs, which change between every run.
- A file tab now follows the live edge whenever its tail mode is on — including
  when tailing was enabled from the merged timeline's **Tail all** — instead of
  only when toggled from that tab's own Tail button. Appended lines were being
  indexed (the histogram updated) but the row list stayed put.
- Tailing in **newest-first** order now keeps the view live. Appended lines were
  indexed and the histogram and counts updated, but the row list froze on the
  newest rows. In newest-first order an appended line shifts every display
  position, so the whole loaded set is stale — the tail refresh was only
  discarding the last block (correct for oldest-first), leaving the visible
  newest rows cached. It now drops the full set in newest-first order.
- Command & pipe sources: open the live output of a command instead of a file.
  A **Run a command** button on the welcome screen and in the tab bar opens a prompt
  (e.g. `docker logs -f web`, `journalctl -f`, `kubectl logs -f pod`) — TraceBox runs
  it through your shell, spools its output to a capture, and indexes and follows it
  exactly like a tailed log (search, histogram, clustering, fields all work live).
  stderr is captured alongside stdout (toggleable). A **Stop** control in the status
  bar freezes the captured data while keeping it searchable; it also freezes
  automatically when the process exits.

## [1.3.1] - 2026-06-16

### Removed

- macOS desktop build. The release pipeline now builds **Windows** (primary) and
  **Linux** (extra) only — the macOS job was failing CI and isn't a supported
  target.

## [1.3.0] - 2026-06-16

### Added

- Right arrow opens/closes the detail panel for the selected line (rebindable).
  Selection (row highlight, ↑/↓ navigation) is now independent of the panel, so
  you can close it without losing your place and reopen it in context.

- Saved workspaces: a "Workspaces" menu in the header saves the open files and each
  file's active search as a named workspace, reopenable in one click (restores the
  files and re-applies their searches). Persisted locally; available even on a fresh
  launch with no files open.
- Cluster correlation ("Concentrated in"): with a search active, the summary panel
  surfaces the field=value pairs the result set concentrates in and that are
  over-represented vs the whole file (e.g. "host=web-03 · 80% · 3.4×"). Click one
  to refine the filter.
- Gap & spike detection on the histogram: unusual volume bursts are marked with a
  red caret (click to zoom to that range) and notable silences are shown as
  hatched bands, with a summary in the histogram footer. Detection is robust
  (median + MAD with a noise gate) so flat or sparse series stay quiet.
- Line notes & report export: add a free-text note to any line from the detail
  panel (persisted per file, like bookmarks). The bookmarks menu lists noted lines
  and gains **Export report…**, which gathers the bookmarked and noted lines into a
  shareable report — copy as Markdown, or download as Markdown / standalone HTML —
  for pasting into an incident ticket.
- Field breakdown panel: a filter box to search the field list by name, and a
  sort toggle (A–Z / by count). Fields are now ordered alphabetically by default.
- Numeric / range faceting: for fields with numeric values, the field breakdown
  panel gains a **Range** view — min / median / average / p95 / max plus a
  clickable distribution histogram. Clicking a bar filters the search to that
  value range. High-cardinality numeric fields (where a value list is useless)
  open in this view automatically. Respects the active search.
- JSON tree in the detail panel: when a line is a JSON object/array, the detail
  panel shows a collapsible, syntax-highlighted tree (Tree/Raw toggle, "Copy JSON"
  pretty-prints). Each leaf has a "+filter" that builds a query clause using the
  same dot/`[i]` path the field index uses, so it resolves against the data.
- Compressed logs: `.gz` files open transparently — TraceBox decompresses once to
  a cached temp (recognised by extension or gzip magic bytes) and indexes that, so
  reopening an unchanged archive reuses both the decompressed copy and its index.
- Rotation-aware open: when you open a log that has rotated siblings
  (`app.log` + `app.log.1` + `app.log.2.gz`, or dateext names), TraceBox offers to
  open the whole group as one time-ordered stream — members are concatenated
  oldest→newest (decompressing `.gz` parts) and indexed as a single file. The tab
  shows a `+N` badge for the extra files.
- macOS and Linux desktop builds: the release workflow now builds Windows (NSIS),
  macOS (dmg + zip), and Linux (AppImage) on an OS matrix and publishes them to
  one GitHub release. `npm run dist:mac` / `dist:linux` build locally on the
  respective OS. macOS/Linux builds are unsigned unless signing secrets are set.
- Summary panel (toolbar): metrics for the current view — total lines, time span,
  average and peak lines/min, the level breakdown with percentages, and the top
  structured fields with their leading values. Respects the active search.
- Regex search: a toolbar toggle (.*) switches the search box to regular-
  expression mode — lines are matched against the pattern (case-insensitive) and
  the matches are highlighted in place. Works with grouping (a match inside a
  stack trace surfaces its record), highlight mode, faceting, and clustering.
  Being a post-filter it scans the file rather than using the index, so it's
  slower than the query language on very large files, and the result set is a
  snapshot while tailing (re-run to refresh).
- Index cache management (Settings → Manage cache): see the on-disk index cache
  with per-file sizes, line counts, and total, and evict entries individually or
  clear all unused with one click. Indexes for currently-open files are flagged
  and protected; everything else re-indexes on next open. The cache folder is
  configurable, and stale entries are auto-cleared after a configurable number
  of days unused (default 7; 0 disables) — checked at launch and every 6 hours.

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

### Changed

- Redesigned the toolbar into two clearer rows: search (with history and syntax
  help) plus the primary Tail / Open / shortcuts / settings actions on top, and a
  grouped control strip below — panels (histogram, fields, patterns, bookmarks),
  view modes (group, highlight, wrap, columnar), display (timezone, order), and
  actions (refresh, export) — separated by dividers. Nothing was removed; the
  controls are just organized and labelled more clearly.
- Client state (workspaces, bookmarks, notes, saved searches, settings, column
  layouts, keybindings) is now stored on disk by the backend
  (`~/.tracebox/state.json`) instead of browser localStorage. localStorage is keyed
  by the window's origin, so the desktop app — whose loopback port can vary between
  launches — would reset all of it; disk-backed storage is stable regardless of
  port. Existing localStorage state is migrated automatically on first run. (The
  desktop backend also prefers a stable port now, with an ephemeral fallback.)

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
