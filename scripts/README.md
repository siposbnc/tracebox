# scripts/

Dev, build, and test-data tooling. Node scripts run with `node scripts/<name>.mjs`
(Node ≥ 24); several have `npm run` aliases (shown below). Generated logs land in
`testlogs/` or `live-logs/`, which are git-ignored.

## Synthetic log generators

Test fixtures for exercising TraceBox — none ship in the product.

### `genlog.mjs` — one big file
```bash
node scripts/genlog.mjs <out.log> <size> [app|json|access]
npm run genlog -- big.log 1gb app          # via the alias
```
Writes a single log of a target `size` (`100kb`, `500mb`, `2gb`, …) and exits.
Output is deterministic (seeded RNG). Use it to test indexing speed, paging, and
search over a huge file. Defaults: `test.log`, `100mb`, `app`.

### `genlive.mjs` — live, growing logs
```bash
node scripts/genlive.mjs                    # 3 APIs → ./live-logs/, ~5 lines/s each, appends
node scripts/genlive.mjs --rate 20 auth payments gateway
node scripts/genlive.mjs auth:json orders:app   # per-API format override
```
Appends synthetic lines to one file per "API" in real time until **Ctrl+C** — for
testing **live tail**, watch rules, and the live merged timeline. Occasionally tips
a source into an error/latency **spike** (durations up to ~8000ms, bursts of
ERRORs). Options: `--dir <path>` (default `./live-logs`), `--rate <n>` (lines/sec
per API, default 5), `--format app|json|access`, `--fresh` (truncate instead of
append), `--no-bursts`.

### `gen-multi.mjs` — several services, one time window (`npm run genlogs`)
```bash
node scripts/gen-multi.mjs [outDir] [scale]   # default: testlogs/, scale 1
```
Writes a set of service log files (each a different service in a different format)
whose timestamps overlap ~2024-01-01 00:00–01:00 UTC, so the **merged timeline**
interleaves them. `scale` multiplies the per-file line counts.

### `gen-rolling.mjs` — daily-rolled files (`npm run genrolling`)
```bash
node scripts/gen-rolling.mjs [outDir] [days] [linesPerDay]   # default: testlogs/rolling/, 5, 1500
```
Writes logrotate `dateext`-style files (`<service>-YYYY-MM-DD.log`) across `days`
consecutive days, for testing the merged timeline's cross-file timestamp stitching.

### `scenario.mjs` — a realistic incident
```bash
node scripts/scenario.mjs [incident.log]      # default: incident.log
```
Generates one file with a **real incident buried in noise**: a midnight deploy
ships a bad DB-pool config, payments starts exhausting its pool, surfacing as 503s
on `/api/checkout` plus a recurring stack trace. Good for demoing search,
clustering, gap/spike detection, and grouping end-to-end.

## Dev, build & release

Mostly invoked through `npm run` (see `package.json`); listed here for reference.

| Script | npm alias | What it does |
|---|---|---|
| `dev.mjs` | `npm run dev` | Runs the auto-restarting API server and the Vite dev server together. |
| `gen-patchnotes.mjs` | `npm run genpatchnotes` | Regenerates `web/patchnotes.ts` (the in-app "What's new") from `CHANGELOG.md`. Runs automatically in `dev`/`build`. |
| `build-electron.mjs` | `npm run build:electron` | esbuild-bundles the backend to `dist-electron/` (`server.cjs`, `mcp.cjs`) as CommonJS for the desktop shell. |
| `dist.mjs` | `npm run dist` (`:dir`, `:linux`) | electron-builder wrapper that retries the transient Windows `EPERM` rename failure; pass electron-builder args. |
| `clean-release.mjs` | `npm run clean:release` | Removes electron-builder's unpacked staging dirs from `release/` (installers are left in place). |
| `makeicon.mjs` | — | Renders the logo to a multi-size Windows `.ico` + a 256px PNG, with no native deps. |
| `make-selfsigned-cert.ps1` | — | Generates a self-signed code-signing cert for **local pipeline testing only** (won't clear SmartScreen — see `SIGNING.md`). Run via `powershell -ExecutionPolicy Bypass -File scripts/make-selfsigned-cert.ps1`. |
