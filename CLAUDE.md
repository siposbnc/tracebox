# CLAUDE.md

Guidance for AI agents (and humans) working in this repository.

## What this is

TraceBox is a fast, fully offline log reader for multi-gigabyte files: a
zero-dependency Node.js backend that indexes logs into built-in SQLite (FTS5),
a React UI, and an Electron desktop shell. **This project is 100% AI-coded.**

`README.md` is the source of truth for architecture, the query language, and the
big-file design — read it before making non-trivial changes. This file covers
how to work in the repo.

## Commands

```bash
npm install            # Node.js >= 24 required (engines field enforces this)
npm run dev            # Vite dev server + auto-restarting API (development)
npm test               # backend test suite (node --test over server/**/*.test.ts)
npm run build          # build the web UI into dist/ (needed before npm start / app)
npm start              # run as a local web app on http://127.0.0.1:7077
npm run mcp            # run the MCP server (stdio) so AI agents can drive TraceBox
npm run app            # build everything and launch the Electron desktop app
npm run dist           # build the NSIS Windows installer into release/
npm run release        # build + publish to a GitHub release (CI only; needs GH_TOKEN)
node scripts/genlog.mjs big.log 1gb app   # generate a synthetic test log (app|json|access)
```

There is no separate typecheck script; `tsconfig.json` is `noEmit` (type-checking
only — TypeScript runs natively via Node type stripping). Run `npx tsc` to
typecheck if needed.

## Layout

See the architecture tree in `README.md`. In short:

- `server/` — zero-dependency backend (indexing, parsing, query parser/compiler,
  sessions, HTTP/SSE). Not desktop-specific.
- `web/` — React UI (Vite + Tailwind).
- `electron/` — desktop shell only; `server/` and `web/` stay platform-agnostic.
- `scripts/` — dev runner, esbuild bundler, icon + synthetic-log generators.
- `build/` — icon and NSIS installer script.

## Conventions

- **TypeScript, strict.** 2-space indent, single quotes, semicolons.
- **Explicit return types** on functions (e.g. `: void`, `: Promise<void>`).
- **Import with explicit `.ts` extensions** (`./session.ts`) and the `node:`
  prefix for builtins (`node:http`, `node:fs`).
- **No runtime dependencies in `server/`** — this is a core design constraint.
  Indexing uses built-in `node:sqlite`; the HTTP server is hand-rolled. Do not
  add packages to make the backend work; prefer the standard library.
- JSDoc comments on exported functions/types; `// ----` section dividers within
  larger files. Match the surrounding style.
- Tests live next to the code as `*.test.ts` and use the built-in `node:test`
  runner. Add or update tests with backend changes and keep `npm test` green.

## MCP toolkit (driving TraceBox as an agent)

`npm run mcp` runs the stdio MCP server (`server/mcp.ts`), exposing the index/query
engine to AI agents. It is opt-in (off until enabled in Settings → MCP server, or
run with `--allow` for dev). Tools:

| Tool | Purpose |
|---|---|
| `open_log` | Index a file (or rotation group); returns a session id, format, counts, levels, fields |
| `list_sessions` / `close_log` | Manage open sessions |
| `search` | Run the query language; returns a page of matching rows + the total |
| `table` | Like `search`, but project only chosen fields as a compact value-array table (no full lines to post-process) |
| `get_lines` | Read a raw line range by number (browse / tail), ignoring any active search |
| `get_context` | Surrounding lines for a hit (like `grep -C`), with matches flagged |
| `get_record` | One line's parsed fields and full multi-line record |
| `fields` | Detected structured fields with counts |
| `facet` | Value breakdown for a field over the current view |
| `stats` / `histogram` / `clusters` | Summary metrics, time-volume histogram, and top log patterns |
| `test_parser` / `add_parser` / `remove_parser` / `list_parsers` | Build, save, and manage user-defined parsers |
| `build_report` | Assemble a Markdown or HTML report; cited line numbers are filled with the real indexed lines |

Recommended workflow: `open_log`, then `search`/`table`/`stats`/`clusters` to narrow
down, then `get_context`/`get_record` to read the relevant lines — returning only
matching lines and aggregates — and finish with `build_report` to deliver findings as a
report whose quoted log lines are pulled verbatim from the index (authoritative, not
paraphrased). Notes for agents:

- **Line numbers are 0-based.**
- Prefer `table(query, columns)` over `search` when you only need a few fields across
  many rows — it stays compact and needs no post-processing.
- `stats`/`histogram`/`facet`/`clusters` take an optional `query` to scope themselves in
  one call (pass `""` for the whole file); omit it and they reuse the active `search`
  (which scopes the view until you search again).
- If a log's fields aren't extracted, `test_parser` dry-runs a regex and `add_parser`
  saves it so a reopen indexes the format. Capture numbers without their unit
  (`(?<dur>\d+)ms`) so `dur:>500` works.
- The query language is documented in `README.md`.

## Releasing

1. Update `CHANGELOG.md`: move `Unreleased` entries under a new version heading.
2. Bump `version` in `package.json` (the release workflow fails if the tag
   doesn't match it).
3. Commit, then `git tag vX.Y.Z` and `git push --tags`.
4. `.github/workflows/release.yml` builds the installer and creates a **draft**
   GitHub release; review and publish it.

Code signing is env-var driven (`CSC_LINK` / `CSC_KEY_PASSWORD`); see
`SIGNING.md`. No secrets live in the repo.

## When you make changes

- Add a `CHANGELOG.md` entry under `## [Unreleased]` for anything user-facing.
  The in-app "What's new" view is generated from `CHANGELOG.md` into
  `web/patchnotes.ts` by `scripts/gen-patchnotes.mjs` (run by `npm run build` and
  `npm run dev`) — don't edit `web/patchnotes.ts` by hand.
- Keep `server/` dependency-free and `127.0.0.1`-only (offline guarantee).
- Run `npm test` before considering backend work done.
