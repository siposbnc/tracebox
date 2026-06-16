import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Server-side store for the UI's client state (workspaces, bookmarks, notes,
 * settings, …). Persisted to `~/.tracebox/state.json` so it survives regardless
 * of the renderer's origin — the desktop window's port can change between
 * launches, which would otherwise reset browser localStorage.
 *
 * Values are opaque strings (the client serializes its own JSON), mirroring the
 * localStorage contract the UI was written against.
 */

const CONFIG_DIR = path.join(homedir(), '.tracebox');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

let cached: Record<string, string> | null = null;

function read(): Record<string, string> {
  if (cached) return cached;
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // no state yet
  }
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  cached = out;
  return cached;
}

function write(state: Record<string, string>): void {
  cached = state;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    // best effort — keep the in-memory value even if persisting fails
  }
}

/** The entire client-state map. */
export function getClientState(): Record<string, string> {
  return read();
}

/**
 * Apply a patch: string values are set, `null` deletes the key. Returns nothing;
 * the client keeps its own copy and doesn't need the result echoed back.
 */
export function patchClientState(patch: Record<string, string | null>): void {
  const next = { ...read() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else if (typeof v === 'string') next[k] = v;
  }
  write(next);
}
