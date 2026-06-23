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

- **More archive formats.** Extend transparent decompression beyond `.gz` to
  `.zip` / `.bz2` / `.xz`, and support opening a whole `.zip` of logs.
- **Pipe / command sources.** Read from stdin or `tracebox -- <command>` to view a
  live process (`docker logs`, `journalctl`, `kubectl logs`) with the full toolset,
  still fully offline.

## Insight — answer "what's going on" faster

- **Numeric field trends.** Chart a numeric field over time (`duration_ms`,
  response bytes) with p50/p95, not just line volume. Builds on the histogram +
  stats code; turns the tool into a mini offline observability view.
- **Facet-over-time heatmap.** A 2-D grid — a field's values (status, service,
  level) down one axis, time across the other, each cell shaded by count — so you
  can see *which* value started spiking *when*. Fuses the histogram and faceting
  code; bucket on the server so it holds up on big files.

## Workflow — keep an investigation

- **Richer workspaces.** Saved workspaces capture the open files and their searches
  today; also persist the column layout and open-panel state so a workspace
  restores the full view, not just the filters.

## AI access — let agents drive TraceBox

The MCP server has shipped (`npm run mcp`; see `README.md`). Possible extensions:

- **More transports.** The server speaks MCP over stdio today; add the Streamable
  HTTP transport on the existing `127.0.0.1` HTTP server so a running TraceBox
  instance can be attached to as well, sharing its already-open sessions with the
  desktop UI.
- **Richer tools.** Surface gap/spike detection, numeric-field trends, and
  cross-file (merged-timeline) search as tools, mirroring the UI's analysis views.

## Refine what's already there

Often higher-value-per-effort than net-new features:

- **Inline expand/collapse for grouped records.** Expand a stack trace in place in
  the row list (today the full record only shows in the detail panel). The most
  natural missing half of multi-line grouping; needs dynamic row measurement.
- **Sortable columns in the columnar view.** Resizable + reorderable columns,
  per-file widths, and click-a-cell-to-filter have shipped; sorting by a column
  remains. Sorting needs the backend to ORDER BY a field (materialize results in
  that order) rather than by line number, so paging stays O(1).
- **Wider format coverage.** CEF, more key=value/`:` delimiter variants, pretty-
  printed (multi-line) JSON, and additional timestamp shapes in auto-detection.

## Performance & release

- **Regex FTS-narrowing by a literal token.** Whole-line `/regex/` already lets
  the surrounding field/term filters narrow the candidate lines it scans (a
  superset gathered from the index, then regex-verified). The remaining win is
  seeding candidates from the regex's *own* mandatory literal — but the default
  FTS tokenizer matches whole tokens, so a substring literal isn't a sound
  superset (it can miss `Xtimeout9`). Doing this correctly needs a trigram /
  substring index (a second FTS5 table, larger on disk) to gate on.
- **Windows code signing.** Ship a signed installer so SmartScreen stops warning on
  first run (the signing plumbing is already env-var driven; see `SIGNING.md`).
