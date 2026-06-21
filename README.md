# TraceBox

TraceBox is a fast, fully offline log reader with complex search capabilities, built to handle
multi-gigabyte files comfortably. It is the modern rewrite of the Local Log Processor (LLP)
WPF application, re-imagined as a local web app with a Node.js backend.

**Note: This project is 100% AI-coded.**

## Highlights

- **Huge files, instantly browsable** — files are scanned with a sparse line-offset index
  (one checkpoint per 64 lines), so any of millions of lines is readable with a single seek.
  A 1 GB / 10M-line file costs the server well under 200 MB of RAM.
- **Real full-text search engine** — lines are indexed into SQLite **FTS5** (built into Node.js,
  zero native dependencies). Typical queries over 10M lines answer in milliseconds.
- **Kibana-style query language** with a proper recursive-descent parser:
  `AND` / `OR` / `NOT`, parentheses, phrases, field filters, comparisons, wildcards.
- **Structured parsing with format auto-detection** — JSON lines (nested fields flattened to
  `dot.paths`), classic timestamped app logs, Apache/nginx access logs, syslog, logfmt,
  Python logging, plus a raw fallback that still sniffs levels and timestamps. **User-defined
  parsers** extend detection to proprietary formats: a named regex whose capture groups become
  fields (`timestamp`/`level`/`message` are treated as metadata).
- **Live tail (`tail -f`)** — appended lines are indexed incrementally and an active search
  keeps extending over them; unterminated trailing lines are handled correctly. A **manual
  refresh** button reloads the file on demand, and rows can be ordered **oldest- or
  newest-first** via a global toggle.
- **Watch rules** — light monitoring on top of tailing: get alerted when new lines match a
  query, or when matches cross a rate threshold (e.g. "20 errors in 60s"). Alerts show as
  in-app toasts with a per-tab badge and, in the desktop app, native OS notifications. Rules
  are saved per file and evaluated for every tailing source, including background tabs.
- **Compressed & rotated logs** — `.gz` files open transparently (decompressed once to a cached
  temp), and a rotation group (`app.log` + `app.log.1` + `app.log.2.gz`, or dateext names) can be
  opened as one time-ordered stream — members are concatenated oldest→newest and indexed as a
  single file.
- **Persistent index cache** — reopening an unchanged file is instant (the index is fingerprinted
  by path + size + mtime and reused).
- **Time histogram** — stacked per-level volume over time; drag a range to filter.
- **Multi-file tabs**, a detail panel with extracted fields (one-click "add as filter"),
  match highlighting, level breakdown with one-click filters, CSV / JSON export of filtered rows.
- **100% offline** — the server binds to `127.0.0.1` only; nothing ever leaves your machine.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 24 (TypeScript run natively via type stripping) |
| Indexing | `node:sqlite` (built-in SQLite with FTS5) — no native modules, no dependencies |
| Backend | Zero-dependency HTTP server, Server-Sent Events for progress/tail |
| Frontend | React 19 + TypeScript + Vite 7 + Tailwind CSS 4 |
| Virtualization | `@tanstack/react-virtual` (smooth scrolling over millions of rows) |

## Desktop app (Windows, Linux)

TraceBox ships as a standalone desktop application built with **Electron**. The same
backend and UI run inside a native window — no browser, no localhost URL to manage.

```powershell
cd tracebox
npm install
npm run app      # build everything and launch the desktop app
```

To produce distributable installers (each must be built on its own OS):

```powershell
npm run dist        # Windows → release\TraceBox Setup x.y.z.exe  (NSIS installer)
npm run dist:dir    # Windows → release\win-unpacked\TraceBox.exe (portable, unpacked)
npm run dist:linux  # Linux   → release/TraceBox-x.y.z.AppImage
```

Windows is the primary target; Linux is a best-effort extra. The
[release workflow](.github/workflows/release.yml) builds both on tag push via an OS
matrix and publishes them to one GitHub release. Builds are unsigned unless signing
secrets are configured.

The installer:

- adds a Start-menu / desktop entry and a double-clickable `TraceBox.exe`;
- registers **"Open with TraceBox"** in the Explorer right-click menu for
  `.log`, `.txt`, `.jsonl`, `.ndjson`, and `.out` files (without hijacking the
  default association for those types);
- supports launching by **double-clicking a log file**, **dragging a file onto
  the window**, and a **native file picker**.

Opening a file while TraceBox is already running reuses the existing window and
adds the file as a new tab (single-instance).

### How the desktop shell works

The unchanged TraceBox HTTP backend (`server/`) runs in an Electron
`utilityProcess` on an ephemeral `127.0.0.1` port; the window loads the UI from
it. File paths from the OS — CLI arguments, "Open with", second instances, and
drag-and-drop — are forwarded to the renderer, which opens them through the
normal HTTP API. The backend is bundled to a single `dist-electron/server.cjs`
by esbuild at package time. Nothing in `server/` or `web/` is desktop-specific;
the shell lives entirely in `electron/`.

### Automatic updates

The desktop app updates itself. On launch (and every 6 hours) it checks the
GitHub releases for a newer version and shows an in-app banner when one is
available. The user clicks **Download update**, and once it finishes a one-click
**Restart & update** installs it — users never re-download or reinstall manually.
This is wired through `electron-updater` and the `publish`
config in `electron-builder.yml`; each release built by the
[release workflow](.github/workflows/release.yml) ships the `latest.yml` and
blockmap that the updater needs.

Notes:

- Auto-update only runs in the packaged (installed) app, not in development.
- A user must already be on a build that contains the updater for it to take
  effect; the first such release is installed manually, and every release after
  it updates automatically.
- Keep signing consistent across releases — see `SIGNING.md`.

## Running as a local web app

TraceBox also runs as a plain local web server (useful for headless or remote use).
Requires [Node.js 24+](https://nodejs.org).

```powershell
cd tracebox
npm install
npm run build     # build the web UI (one time, and after UI changes)
npm start         # starts the server on http://127.0.0.1:7077 and opens the browser
```

Optional:

```powershell
npm start -- --port 8080          # different port
npm start -- C:\logs\app.log      # open a file immediately
npm start -- --no-open            # don't launch the browser
npm run dev                       # development: vite dev server + auto-restarting API
npm test                          # backend test suite
node scripts/genlog.mjs big.log 1gb app   # generate a synthetic test log (app|json|access)
```

## MCP server (let AI agents drive TraceBox)

TraceBox ships an [MCP](https://modelcontextprotocol.io) server so AI tools (Claude,
IDE agents) can investigate logs through the same index and query engine the UI uses —
searching and paging over a multi-gigabyte file instead of streaming it into a context
window. It's a stdio server, hand-rolled with **no SDK and no runtime dependencies**,
and opens no network sockets of its own, so the offline guarantee holds.

**It's opt-in and off by default** — the server refuses to start until you enable it,
so a packaged install never exposes the toolkit until you ask. Turn it on in
**Settings → MCP server**, which then shows the exact command to register.

From a source checkout:

```powershell
npm run mcp            # start on stdio (node server/mcp-main.ts --allow)
claude mcp add tracebox -- node D:\path\to\tracebox\server\mcp-main.ts --allow
```

In the **desktop app**, enable it in Settings → MCP server and copy the generated
command — it launches the bundled server through the app executable
(`ELECTRON_RUN_AS_NODE`), still gated on the opt-in toggle.

Tools:

| Tool | Purpose |
|---|---|
| `open_log` | Index a file (or rotation group); returns a session id, format, counts, levels, fields |
| `list_sessions` / `close_log` | Manage open sessions |
| `search` | Run the query language (below); returns a page of matching rows + the total |
| `get_lines` | Read a raw line range by number (browse / tail), ignoring any active search |
| `get_context` | Surrounding lines for a hit (like `grep -C`), with matches flagged |
| `get_record` | One line's parsed fields and full multi-line record |
| `fields` | Detected structured fields with counts |
| `facet` | Value breakdown for a field over the current view |
| `stats` / `histogram` / `clusters` | Summary metrics, time-volume histogram, and top log patterns |
| `test_parser` / `add_parser` / `remove_parser` / `list_parsers` | Build, save, and manage user-defined parsers |

An agent typically calls `open_log`, then `search`/`stats`/`clusters` to narrow down,
then `get_context`/`get_record` to read the relevant lines — returning only matching
lines and aggregates. Line numbers are 0-based. `stats`, `histogram`, `facet`, and
`clusters` take an optional `query` to scope themselves in one call (pass `""` for the
whole file); omit it and they reuse the active `search` (which scopes the view until you
search again). If a log's fields aren't extracted, `test_parser` dry-runs a regex and
`add_parser` saves it so a reopen indexes the format.

## Query language

| Query | Meaning |
|---|---|
| `error timeout` | lines containing both terms (implicit AND, prefix match) |
| `"connection failed"` | exact phrase |
| `level:error` | field equality (case-insensitive; level names are normalized — `warning` ⇒ `WARN`) |
| `status:>=500` | numeric comparison (`>` `>=` `<` `<=` on any extracted field) |
| `timestamp:>2024-01-31` | time comparison; equality respects input precision (`timestamp:2024-01-31` = that whole day) |
| `path:/api/*` | wildcard match |
| `user:*` | field exists |
| `NOT database`, `-database` | exclusion |
| `(level:error OR level:warn) AND service:payments` | grouping and boolean logic |
| `http.status:503` | nested JSON fields are searchable via their flattened path |

Timestamps without an explicit timezone are interpreted as UTC, both in log lines and in queries.

## Architecture

```
tracebox/
├─ server/              zero-dependency Node.js backend (TypeScript)
│  ├─ lineIndex.ts      sparse line-offset index + bounded-memory newline scanner
│  ├─ reader.ts         random-access line reads via checkpoint seek + short scan
│  ├─ parsers.ts        format detection, JSON/regex/logfmt/raw parsers, ts/level normalization
│  ├─ queryParser.ts    tokenizer + recursive-descent parser → query AST
│  ├─ queryCompiler.ts  AST → SQL over the FTS5/fields schema
│  ├─ indexer.ts        SQLite store: lines, fields, FTS5, materialized results, histogram
│  ├─ session.ts        per-file orchestration: background indexing, search, tail
│  ├─ http.ts           router, static serving, SSE
│  ├─ files.ts          drive/directory browsing + recent files
│  ├─ app.ts            assembles the HTTP app (shared by CLI and desktop)
│  └─ main.ts           CLI entry: binds a fixed port, opens the browser
├─ web/                 React UI (Vite + Tailwind)
├─ electron/            desktop shell
│  ├─ main.cjs          Electron main: spawns the backend, window, file assoc, single-instance
│  ├─ preload.cjs       contextBridge: native dialog, drag-drop paths, OS open events
│  └─ server-entry.ts   backend entry for the utilityProcess (bundled by esbuild)
├─ build/               icon + NSIS installer script (file-association registry verbs)
└─ scripts/             dev runner, esbuild bundler, icon generator, synthetic log generator
```

How the big-file path works:

1. **Open** — the file is streamed in 4 MB chunks. Each line gets a byte-offset entry in the sparse
   index and is parsed and inserted into SQLite (FTS5 + a key/value fields table) in 20k-line
   transactions. Progress streams to the UI over SSE; the file is already browsable and searchable
   while indexing runs.
2. **Search** — the query AST compiles to a single SQL expression (FTS5 `MATCH` subqueries for text
   terms, indexed lookups on the fields table for field filters). Results are materialized into a
   results table, so paging anywhere in a million-row result set is O(1).
3. **Read** — the UI virtualizes rows and fetches 256-line blocks; the server seeks to the nearest
   64-line checkpoint and scans forward, so reads are independent of file size.
4. **Tail** — a file watcher indexes appended bytes incrementally, re-indexing a previously
   unterminated last line if it grew, and extends the active search with matches from new lines only.

The index database lives in `%TEMP%/tracebox-index/` and is reused when the file is unchanged.

## Performance (measured on this machine)

| Operation | Result |
|---|---|
| Index 1 GB / 9.8M-line app log | ~2 minutes, search available throughout |
| Reopen the same file | instant (index reused) |
| `level:error` over 9.8M lines (1.2M hits) | 230 ms |
| Needle-in-haystack term | 3 ms |
| Complex boolean over 1M+ hits | ~2 s |
| Paging 1M rows deep into results | < 150 ms |
| Server RSS with the 1 GB file fully indexed | ~170 MB |
