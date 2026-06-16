import { useCallback, useSyncExternalStore } from 'react';
import { clientStore } from './clientStore';

/**
 * Per-file line bookmarks, persisted via the client store and shared across open
 * tabs. Keyed by absolute file path so marks survive reopening a file; line
 * numbers are stored 0-based (the display adds 1).
 */

const KEY = 'tracebox.bookmarks';
const EMPTY: number[] = [];

type Store = Record<string, number[]>;

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
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function persist(): void {
  version++;
  clientStore.setItem(KEY, JSON.stringify(store));
  emit();
}

export function getBookmarks(file: string): number[] {
  return store[file] ?? EMPTY;
}

/** Add or remove a line from a file's bookmarks (kept sorted ascending). */
export function toggleBookmark(file: string, lineNo: number): void {
  const cur = store[file] ?? EMPTY;
  const next = cur.includes(lineNo)
    ? cur.filter((n) => n !== lineNo)
    : [...cur, lineNo].sort((a, b) => a - b);
  store = { ...store };
  if (next.length === 0) delete store[file];
  else store[file] = next;
  persist();
}

export function clearBookmarks(file: string): void {
  if (!store[file]) return;
  store = { ...store };
  delete store[file];
  persist();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive list of a file's bookmarks (sorted, 0-based line numbers). */
export function useBookmarks(file: string): number[] {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => getBookmarks(file), [file]),
  );
}

/** A counter that changes whenever any bookmark changes (for views spanning files). */
export function useBookmarkVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
