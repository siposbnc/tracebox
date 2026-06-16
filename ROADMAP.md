# Roadmap

Possible future directions for TraceBox, roughly ordered by expected value within
each group. Nothing here is committed — it's a backlog to pull from. See
`CHANGELOG.md` for what has actually shipped.

When picking up an item, keep the core constraints in mind: `server/` stays
zero-dependency and `127.0.0.1`-only, and the design has to hold up on
multi-gigabyte files (stream, page, and index — never load the whole file).

## Shipped

The original backlog is essentially complete. Delivered so far (see `CHANGELOG.md`):

- **Search** — Kibana-style query language, full-text (FTS5), field/numeric/time
  comparisons, wildcards; inline autocomplete; history & saved searches; regex
  mode; highlight-without-filter.
- **Navigation** — bookmarks, go-to-line, page/Home/End jumps, find-next, tab
  cycling; fully rebindable keyboard shortcuts with a shortcuts overlay.
- **Reading** — multi-line/stack-trace grouping, word wrap, context peek, columnar
  view for structured logs, copy rows.
- **Analysis** — time histogram, field faceting, log clustering (patterns), a
  summary/stats panel, and a time-ordered **merged timeline** across files (with
  its own search/highlight/detail).
- **Platform & polish** — Windows / macOS / Linux desktop builds with auto-update,
  a settings panel, local/UTC timezone toggle, a two-row toolbar, and index-cache
  management (view/evict, configurable folder, auto-clear of stale caches).
- **Ingest** — transparent `.gz` open (decompress-once to a cached temp) and
  rotation-aware open (concatenate `app.log` + `app.log.1` + `app.log.2.gz` into one
  time-ordered stream, indexed as a single file).

## Ideas (forward-looking)

### Ingest — meet logs where they actually live

- **Live rotation following.** Rotation-aware open is a snapshot today; follow the
  rotation as it happens (new `app.log` after a roll) the way single-file tail does.
- **More archive formats.** Extend transparent decompression beyond `.gz` to
  `.zip` / `.bz2` / `.xz`, and support opening a whole `.zip` of logs.
- **Pipe / command sources.** Read from stdin or `tracebox -- <command>` to view a
  live process (`docker logs`, `journalctl`, `kubectl logs`) with the full toolset,
  still fully offline.

### Live — turn tailing into light monitoring

- **Live merged timeline.** The merged view is a snapshot today; make it follow
  appended lines like the single-file tail does.
- **Watch rules.** While tailing, flag (or fire a desktop notification) when a
  pattern matches or a level/rate threshold is crossed — e.g. "ping me if ERRORs
  exceed N/min." Makes TraceBox a lightweight, offline log monitor.

### Insight — answer "what's going on" faster

- **Numeric field trends.** Chart a numeric field over time (`duration_ms`,
  response bytes) with p50/p95, not just line volume. Builds on the histogram +
  stats code; turns the tool into a mini offline observability view.
- ~~**Gap & spike detection.**~~ *Shipped* — volume spikes and notable silences
  marked on the histogram.
- ~~**Cluster correlation.**~~ *Shipped* — the summary panel surfaces the fields a
  filtered result set concentrates in, with over-representation (lift).

### Workflow — keep an investigation

- **Saved workspaces.** Persist the open files, active searches, column layout, and
  panel state as a named workspace, reopenable in one click. Debugging the same
  system repeatedly is the norm.
- ~~**Notes & report export.**~~ *Shipped* — per-line notes plus a
  bookmarks/notes report exported as Markdown or standalone HTML.

### Refine what's already there

Often higher-value-per-effort than net-new features:

- **Inline expand/collapse for grouped records.** Expand a stack trace in place in
  the row list (today the full record only shows in the detail panel). The most
  natural missing half of multi-line grouping; needs dynamic row measurement.
- **Regex inside the query language.** Allow `level:error AND /timeout\d+/` so a
  regex composes with field filters — which also lets the field filter *narrow*
  the lines the regex has to scan, instead of regex being a whole-file mode.
- **Columnar view as a real table.** Sortable, resizable, reorderable columns;
  click a cell to filter to that value; remember widths per file.
- **JSON tree in the detail panel.** A collapsible, syntax-highlighted tree for
  JSON lines alongside the flattened `dot.path` fields.
- **Numeric / range faceting.** For numeric fields (`status`, `duration_ms`), show
  value ranges and a small distribution, not just the exact top values.
- **Histogram interactions.** Click a level in the legend to filter, a clear/reset
  for the drag range, and a selectable bucket resolution.
- **Range row selection.** Shift-click / Shift+Arrow to select a span of rows for
  copy/export (today copy is all-or-the-filtered-set; there's no arbitrary
  multi-row selection).
- **Wider format coverage.** CEF, more key=value/`:` delimiter variants, pretty-
  printed (multi-line) JSON, and additional timestamp shapes in auto-detection.

### Customization

- **User-defined parsers.** Let users describe a proprietary format (a regex +
  field mapping, with a live tester) and persist it, extending auto-detection
  beyond the built-in formats.
- **Appearance.** A light / high-contrast theme and adjustable font size; the UI is
  dark-only today.

### Performance & release

- **Regex FTS-narrowing.** When a regex has a mandatory literal token, seed
  candidates from FTS and regex-verify only those, instead of scanning the whole
  file.
- **macOS notarization & signing.** Complete the release story so macOS auto-update
  works and Gatekeeper stops warning.
