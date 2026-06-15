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
  Python logging, plus a raw fallback that still sniffs levels and timestamps.
- **Live tail (`tail -f`)** — appended lines are indexed incrementally and an active search
  keeps extending over them; unterminated trailing lines are handled correctly.
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

## Desktop app (Windows)

TraceBox ships as a standalone desktop application built with **Electron**. The same
backend and UI run inside a native window — no browser, no localhost URL to manage.

```powershell
cd tracebox
npm install
npm run app      # build everything and launch the desktop app
```

To produce a distributable Windows installer:

```powershell
npm run dist     # → release\TraceBox Setup 1.0.0.exe  (NSIS installer)
npm run dist:dir # → release\win-unpacked\TraceBox.exe (portable, unpacked)
```

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
npm test                          # backend test suite (39 tests)
node scripts/genlog.mjs big.log 1gb app   # generate a synthetic test log (app|json|access)
```

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
