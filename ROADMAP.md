# Roadmap

Possible future improvements for TraceBox, roughly grouped and ordered by
expected value. Nothing here is committed — it's a backlog to pull from. See
`CHANGELOG.md` for what has actually shipped.

When picking up an item, keep the core constraints in mind: `server/` stays
zero-dependency and `127.0.0.1`-only, and the design has to hold up on
multi-gigabyte files (stream, page, and index — never load the whole file).

## Recently done

- **Context around matches (grep -C).** Peek at the unfiltered lines surrounding
  a search hit and jump into the full view. _(In `Unreleased`.)_
- **Inline query autocomplete.** Field names, `level:` values, and boolean
  operators suggested as you type. _(In `Unreleased`.)_
- **Search history + saved searches.** Recent queries remembered; named queries
  pinned for reuse. _(In `Unreleased`.)_

## High value (do next)

- **Compressed file support (`.gz` / `.zip`).** Logs are very often rotated and
  gzipped; the reader currently streams raw bytes, so a `.gz` opens as garbage.
  Add transparent decompression on open. The hard part is the line-offset index:
  either decompress to a temp file once, or index over the decompressed stream
  and store the mapping. Keep it offline and dependency-free (`node:zlib`).
- **Field faceting / value breakdown.** Top values + counts per field
  (`SELECT value, COUNT(*) ... GROUP BY value`) for the current result set —
  turns a log into something you can pivot on ("which `status` codes? which
  `host`s?"). The `fields` table and result set already exist.
- **Local timezone toggle.** Everything is rendered in UTC (`formatTs` →
  `toISOString`). Add a global toggle (like row order) for local time, with the
  zone shown explicitly so it's never ambiguous.

## Search & navigation

- **Highlight-without-filter.** Mark matching lines in place without hiding the
  rest — complements context-around-matches for scanning.
- **Bookmarks / go-to-line.** Mark lines and jump between them; a "go to line N"
  affordance.
- **Regex search.** A regex mode alongside the current query language (likely a
  post-filter over candidate lines, since FTS5 can't do arbitrary regex).
- **Word-wrap toggle & better copy.** Optional wrapping for long lines and
  multi-line copy of the selected/filtered rows.

## Analysis

- **Multi-file merged timeline.** One time-ordered view across several open
  files (e.g. correlating services). Needs a merge over per-file indexes.
- **Stats panel.** Rate over time, error counts, top talkers — summary metrics
  for the current view, building on the histogram/aggregation code.
- **Log clustering / pattern grouping.** Collapse near-identical lines into
  templates with counts (Drain-style) to surface what's actually happening.
- **Columnar JSON view.** For JSON logs, a configurable column table over the
  flattened fields instead of raw-line rendering.

## Platform & polish

- **macOS / Linux builds.** Currently Windows-only (NSIS). electron-builder can
  target dmg/AppImage; auto-update would extend to those channels too.
- **Settings panel.** A single place for order, timezone, theme, context
  defaults, etc. (several settings are currently ad-hoc toggles).
- **Index cache management UI.** Show and clear the on-disk index cache
  (`%TEMP%/tracebox-index`); show per-file index size and let users evict.
