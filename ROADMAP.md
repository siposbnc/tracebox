# Roadmap

Possible future directions for TraceBox, roughly ordered by expected value within
each group. Nothing here is committed — it's a backlog to pull from.

This file lists only what's **left to build**. For everything already shipped, see
`CHANGELOG.md` — the original backlog (search, navigation, reading, analysis,
merged timeline, desktop builds, compressed/rotation ingest, gap/spike detection,
cluster correlation, saved workspaces, notes & report export, JSON tree, numeric
faceting, …) is largely done.

When picking up an item, keep the core constraints in mind: `server/` stays
zero-dependency and `127.0.0.1`-only, and the design has to hold up on
multi-gigabyte files (stream, page, and index — never load the whole file). The
desktop app is the primary target.

## Ingest — meet logs where they actually live

- **Live rotation following.** Rotation-aware open is a snapshot today; follow the
  rotation as it happens (new `app.log` after a roll) the way single-file tail does.
- **More archive formats.** Extend transparent decompression beyond `.gz` to
  `.zip` / `.bz2` / `.xz`, and support opening a whole `.zip` of logs.
- **Pipe / command sources.** Read from stdin or `tracebox -- <command>` to view a
  live process (`docker logs`, `journalctl`, `kubectl logs`) with the full toolset,
  still fully offline.

## Live — turn tailing into light monitoring

- **Live merged timeline.** The merged view is a snapshot today; make it follow
  appended lines like the single-file tail does.
- **Watch rules.** While tailing, flag (or fire a desktop notification) when a
  pattern matches or a level/rate threshold is crossed — e.g. "ping me if ERRORs
  exceed N/min." Makes TraceBox a lightweight, offline log monitor.

## Insight — answer "what's going on" faster

- **Numeric field trends.** Chart a numeric field over time (`duration_ms`,
  response bytes) with p50/p95, not just line volume. Builds on the histogram +
  stats code; turns the tool into a mini offline observability view.

## Workflow — keep an investigation

- **Richer workspaces.** Saved workspaces capture the open files and their searches
  today; also persist the column layout and open-panel state so a workspace
  restores the full view, not just the filters.

## AI access — let agents drive TraceBox

- **MCP server.** Expose TraceBox's index and query engine over the Model Context
  Protocol so AI tools (Claude, IDE agents) can investigate logs efficiently
  instead of `grep`-ing raw files into their context. Tools would cover the things
  the UI already does well: open/attach a source, run a query (the full language —
  fields, levels, time ranges, clustering), fetch a page or a record's context,
  pull the histogram/stats and gap/spike summary, and list detected fields. The
  point is that an agent searches and pages like the UI does — returning only the
  matching lines and aggregates — rather than streaming a multi-gigabyte file
  through a context window.
- **Stays offline and zero-dependency.** Reuse the existing session/query layer;
  the server keeps the `127.0.0.1`-only, no-runtime-deps guarantees (a hand-rolled
  MCP endpoint over the current HTTP/SSE plumbing, not an added SDK). Built for the
  big-file design — every tool streams, pages, and indexes; none load the whole
  file.

## Refine what's already there

Often higher-value-per-effort than net-new features:

- **Inline expand/collapse for grouped records.** Expand a stack trace in place in
  the row list (today the full record only shows in the detail panel). The most
  natural missing half of multi-line grouping; needs dynamic row measurement.
- **Regex inside the query language.** Allow `level:error AND /timeout\d+/` so a
  regex composes with field filters — which also lets the field filter *narrow*
  the lines the regex has to scan, instead of regex being a whole-file mode.
- **Columnar view as a real table.** Sortable, resizable, reorderable columns;
  click a cell to filter to that value; remember widths per file.
- **Histogram interactions.** Click a level in the legend to filter, a clear/reset
  for the drag range, and a selectable bucket resolution.
- **Range row selection.** Shift-click / Shift+Arrow to select a span of rows for
  copy/export (today copy is all-or-the-filtered-set; there's no arbitrary
  multi-row selection).
- **Wider format coverage.** CEF, more key=value/`:` delimiter variants, pretty-
  printed (multi-line) JSON, and additional timestamp shapes in auto-detection.

## Customization

- **User-defined parsers.** Let users describe a proprietary format (a regex +
  field mapping, with a live tester) and persist it, extending auto-detection
  beyond the built-in formats.
- **Appearance.** A light / high-contrast theme and adjustable font size; the UI is
  dark-only today.

## Performance & release

- **Regex FTS-narrowing.** When a regex has a mandatory literal token, seed
  candidates from FTS and regex-verify only those, instead of scanning the whole
  file.
- **Windows code signing.** Ship a signed installer so SmartScreen stops warning on
  first run (the signing plumbing is already env-var driven; see `SIGNING.md`).
