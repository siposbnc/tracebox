# Design: MCP "attached" mode — let an agent drive the open TraceBox window

**Status:** Proposed (not implemented)
**Author:** AI-coded design note
**Related:** `ROADMAP.md` → "More transports"; `server/mcp.ts`, `server/app.ts`, `electron/main.cjs`

## Summary

Today an MCP agent and the desktop UI are two isolated processes with two
separate session registries — the agent can't see or affect what the user has
open. This proposes an **opt-in "attached" mode** in which the agent's tool calls
operate on the *same* sessions the UI is showing, so a user can ask Claude to
investigate and **watch it happen in their TraceBox window** (tabs appear,
searches run, the view jumps to a line).

The client-facing transport stays **stdio** (no client reconfiguration). A
per-window **toggle** selects the mode:

| `mcpEnabled` | `mcpAttach` | Behavior |
|---|---|---|
| `false` | — | Server refuses to start (today's default). |
| `true` | `false` | Standalone stdio, isolated sessions (today's enabled behavior). |
| `true` | `true` | Bridge to the running desktop app; tools drive its live sessions. |

## Goals

- An agent can read and drive the **user's currently open** logs, not a private copy.
- The user **sees** the agent's actions reflected live in the window.
- No change to the user's MCP client config when toggling modes (still stdio).
- Preserve the offline / `127.0.0.1`-only / zero-dependency guarantees.

## Non-goals

- Multi-user / remote access. Strictly local, single machine.
- A full spec-compliant MCP Streamable HTTP transport for *external* clients
  (possible later — see Phase 3 — but not required for the headline feature).
- Conflict-free collaborative editing. Last-writer-wins on the shared view is fine.

## Background: what's shared today, and what isn't

- **Desktop backend** (`electron/server-entry.ts` → `server/app.ts createApp`) runs
  in an Electron `utilityProcess` on a fixed port (7177, ephemeral fallback). It
  owns the `sessions: Map<string, LogSession>` the renderer is bound to, plus the
  app-wide `watchBus` SSE bus and `track(session)` registration path.
- **stdio MCP server** (`server/mcp-main.ts` → `server/mcp.ts McpServer`) is a
  *separate process* with its **own** `sessions` Map. It shares nothing in-memory
  with the app — only the on-disk index cache.

So "drive the UI" reduces to: make the agent's tool calls land on the backend's
session map, and make the renderer react to mutations it didn't originate.

`McpServer.handle(msg)` is already transport-agnostic (takes a parsed JSON-RPC
message, returns a response), which is what makes this tractable.

## Two layers of "drive"

1. **Same data** (engine level) — `search` / `get_record` / `stats` operate on the
   same `LogSession` objects the user has open. The agent immediately *sees* the
   user's logs. (Phase 1.)
2. **Same visible view** (renderer level) — the user *sees* the agent act: tabs
   appear, the search box updates, the view scrolls. This requires the renderer to
   reconcile against mutations made by another client, and is the bulk of the work.
   (Phase 2.)

## Design

Three pieces.

### A. Shared-session `McpServer` (engine)

`McpServer` currently owns its session registry: `private sessions`, `private
lastSearch`, and `open_log` does `new LogSession(...)` directly. Refactor it to
depend on an injected registry instead:

```ts
interface SessionHost {
  open(path: string, opts: { rotation?: boolean }): Promise<LogSession>;
  close(id: string): Promise<void>;
  list(): LogSession[];
  get(id: string): LogSession | undefined;
}
```

- **Standalone mode:** `McpServer` is constructed with a private `SessionHost`
  that owns its own Map — today's behavior, unchanged.
- **Attached mode:** the **app** constructs an `McpServer` with a `SessionHost`
  backed by `createApp`'s own `sessions` + `track()` + `openSource()` path, so an
  agent-opened log goes through the exact registration the UI uses (watch bus,
  SSE, lifecycle).

Add one HTTP route in `server/app.ts`:

```
POST /api/mcp   →  appHostedMcpServer.handle(parsedBody)  →  JSON-RPC response
```

This is *not* the public MCP transport; it's an internal endpoint the bridge
(below) posts to. It reuses `readJsonBody` / `sendJson`.

### B. The stdio → backend bridge (transport)

Keep the stdio entry as the client-facing transport. In **attached** mode it
stops constructing its own `McpServer` and instead **proxies** each JSON-RPC line
to the running app's `POST /api/mcp`, writing responses back to stdout. ~40 lines.

**Instance discovery.** The backend port can fall back off 7177, and there may be
no app running. On listen, `createApp` writes an instance file:

```
~/.tracebox/instance.json   { "port": 7177, "pid": 1234, "token": "<random>", "startedAt": ... }
```

removed (best-effort) on shutdown. The bridge reads it, confirms the server is
live (`GET /api/health`), and posts with `Authorization: Bearer <token>`. If no
live instance is found, it **falls back to standalone** (configurable: fall back
vs. error).

### C. Renderer external-mutation sync (the bulk of the work)

The renderer manages its session list and per-view search in React state and only
fetches `/api/sessions` on mount — it does **not** react to another client's
mutations. Add an app-wide event channel modeled on the existing `watchBus`:

- A `viewBus` `EventEmitter` in `createApp`, plus an SSE route `GET /api/events`
  (mirrors `/api/watch/events`).
- The **attached** `McpServer` is given an `onView` callback that emits structured
  events after view-affecting tools:
  - `session-opened` / `session-closed { id }`
  - `search-changed { id, query }`
  - `reveal { id, lineNo }` — a new, side-effect-free MCP tool so the agent can
    scroll the user's view to a line without changing engine state.
- The **renderer** subscribes to `/api/events` and reconciles:
  - opened/closed → re-fetch `/api/sessions`, add/remove tabs;
  - search-changed → update the search box + results for that tab (treat the
    server's `status().search` as the source of truth on external change);
  - reveal → focus the tab and scroll to the line (reuse the existing
    `jumpTarget` plumbing in `App.tsx` / `LogView`).

This is the piece that turns "same data" into "watch the agent drive."

## Concurrency model

The single active-search cursor per `LogSession` stops being a footgun and
**becomes the feature**: the agent moving the user's view is the point. Rules:

- **Last-writer-wins** on the shared active search. If the user types while the
  agent searches, whichever lands last wins; the `/api/events` push keeps both
  views consistent.
- **Read-only analysis doesn't clobber the filter.** The `query`-scoping already
  added to `facet/stats/histogram/clusters` means the agent can analyze without
  disturbing the user's active `search`. Only the explicit `search` tool moves the
  user's filter.
- **One attached client at a time** initially (the bridge holds the instance
  token); reject a second concurrent attach.

## Security

A `/api/mcp` endpoint can open arbitrary file paths, so it needs more than the
REST API has today:

- **Bind** stays `127.0.0.1` (already true).
- **Origin validation** — reject requests carrying a browser `Origin` (DNS-rebinding
  defense). MCP clients send none.
- **Loopback token** — require the `~/.tracebox/instance.json` bearer token. A
  malicious local web page can POST to `127.0.0.1:7177` but cannot read the token
  file, and the Origin check blocks it regardless.

## Example flow

1. User has `app.log` open; enables *Settings → MCP server → Drive this window*.
2. They tell Claude "find the checkout errors." The client spawns the stdio server.
3. Bridge sees `mcpAttach`, reads the instance file, proxies to `POST /api/mcp`.
4. Agent calls `list_sessions` → sees `app.log`; `search level:error`; `reveal`.
5. `viewBus` emits `search-changed` + `reveal`; the renderer updates the search box,
   re-renders results, and scrolls — the user **watches it happen**.

## Incremental delivery

- **Phase 1 — shared sessions (read value immediately).** Pieces A + B + toggle +
  instance file + token. The agent can already *see and search the user's open
  logs*; agent-opened sessions appear on the next UI refresh. No renderer changes.
- **Phase 2 — live drive (headline).** Piece C: `viewBus`, `/api/events`, the
  `reveal` tool, and renderer reconciliation. This is the larger effort.
- **Phase 3 — optional public HTTP transport.** Promote `/api/mcp` to a real MCP
  Streamable HTTP endpoint (session ids, `MCP-Protocol-Version`, optional SSE) so a
  client can attach over HTTP directly instead of via the stdio bridge.

## Open questions

- When the attached app quits mid-session: bridge errors, or transparently falls
  back to standalone for the rest of the connection?
- Should the user be able to close an agent-opened tab (and what does the agent see
  if they do)?
- Multiple windows / both the web app (7077) and desktop (7177) running — which
  instance does the bridge attach to? (Instance file likely becomes a small registry.)
- Do we surface "an agent is attached and driving this window" in the UI (a banner)
  so the user knows actions aren't their own?

## Alternatives considered

- **Bridge → REST translation** (map each MCP tool to existing `/api/*` calls):
  rejected — duplicates the tool-layer semantics (scoping, serialization) that
  `McpServer.handle()` already implements, and still needs the same renderer sync.
- **Embed the MCP server in the renderer:** rejected — the engine lives in the
  backend process; the renderer is a thin client.
- **Public HTTP transport only (no stdio bridge):** would force users to
  reconfigure their MCP client and abandons the "same config, just toggle" UX.

## Effort estimate

The HTTP/bridge plumbing (A + B) is small — a day or two — and delivers the
read-side value. **Phase 2 (renderer reactivity) is the majority of the work** and
the real decision point: it's worth it only if the "watch the agent drive my
window" experience is a product goal, not just programmatic access (which stdio
standalone already provides).
