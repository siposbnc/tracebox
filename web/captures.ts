import { useCallback, useSyncExternalStore } from 'react';
import { clientStore } from './clientStore';

/**
 * Ad-hoc capture fields: throwaway named-regex extractions a user defines to pull
 * a value out of raw log lines without re-indexing. Persisted per file (like
 * column selections) and sent with each search so the backend can filter/facet on
 * them; display columns are extracted client-side from the row text we already
 * have. The extracted value is the named group matching the field name, else the
 * first capturing group, else the whole match — matching `server/captureField.ts`.
 */

export interface Capture {
  name: string;
  pattern: string;
}

const KEY = 'tracebox.captures';
const EMPTY: Capture[] = [];

type Store = Record<string, Capture[]>;

function load(): Store {
  try {
    const raw = clientStore.getItem(KEY);
    const obj = raw ? (JSON.parse(raw) as unknown) : {};
    return obj && typeof obj === 'object' ? (obj as Store) : {};
  } catch {
    return {};
  }
}

let store: Store = load();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getCaptures(file: string): Capture[] {
  return store[file] ?? EMPTY;
}

export function setCaptures(file: string, caps: Capture[]): void {
  store = { ...store };
  if (caps.length === 0) delete store[file];
  else store[file] = caps;
  clientStore.setItem(KEY, JSON.stringify(store));
  emit();
}

/** Add or replace a capture by name (case-insensitive) for a file. */
export function upsertCapture(file: string, cap: Capture): void {
  const rest = getCaptures(file).filter((c) => c.name.toLowerCase() !== cap.name.toLowerCase());
  setCaptures(file, [...rest, cap]);
}

export function removeCapture(file: string, name: string): void {
  setCaptures(
    file,
    getCaptures(file).filter((c) => c.name.toLowerCase() !== name.toLowerCase()),
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive per-file capture list. */
export function useCaptures(file: string): Capture[] {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => getCaptures(file), [file]),
  );
}

const NAME_RE = /^[A-Za-z_][\w.]*$/;

/** Validate a capture, returning an error message or null. Mirrors the server's rules. */
export function validateCapture(cap: Capture): string | null {
  if (!NAME_RE.test(cap.name)) return 'Name: letters, digits, "_" or "." (not starting with a digit)';
  if (cap.pattern === '') return 'Enter a regular expression';
  try {
    new RegExp(cap.pattern);
  } catch (err) {
    return `Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

/** Extract a capture's value from a line, or undefined. Used for client-side columns. */
export function extractValue(re: RegExp, name: string, text: string): string | undefined {
  const m = re.exec(text);
  if (!m) return undefined;
  if (m.groups && m.groups[name] !== undefined) return m.groups[name];
  return m[1] !== undefined ? m[1] : m[0];
}

export type Extractor = (text: string) => string | undefined;

/** Compile captures into a name → extractor map, skipping any that don't compile. */
export function compileExtractors(captures: Capture[]): Map<string, Extractor> {
  const map = new Map<string, Extractor>();
  for (const c of captures) {
    try {
      const re = new RegExp(c.pattern);
      map.set(c.name, (text) => extractValue(re, c.name, text));
    } catch {
      // invalid pattern — leave it out; the picker shows the validation error
    }
  }
  return map;
}
