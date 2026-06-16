import { useCallback, useSyncExternalStore } from 'react';

/**
 * Per-line free-text notes (annotations beyond a binary bookmark), persisted in
 * localStorage and shared across open tabs. Keyed by absolute file path; line
 * numbers are stored 0-based (the display adds 1). An empty/whitespace note is
 * removed.
 */

const KEY = 'tracebox.notes';

type Store = Record<string, Record<string, string>>;

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const obj = raw ? (JSON.parse(raw) as unknown) : {};
    return obj && typeof obj === 'object' ? (obj as Store) : {};
  } catch {
    return {};
  }
}

let store: Store = load();
let version = 0;
const listeners = new Set<() => void>();

const EMPTY: { lineNo: number; text: string }[] = [];
// cached sorted form per file, so the hook gets a stable reference between renders
let derived: Record<string, { lineNo: number; text: string }[]> = {};

function emit(): void {
  for (const l of listeners) l();
}

function persist(): void {
  version++;
  derived = {};
  localStorage.setItem(KEY, JSON.stringify(store));
  emit();
}

export function getNote(file: string, lineNo: number): string {
  return store[file]?.[lineNo] ?? '';
}

/** Set (or clear, when blank) the note for a line. */
export function setNote(file: string, lineNo: number, text: string): void {
  const trimmed = text.trim();
  const cur = store[file] ?? {};
  if ((cur[lineNo] ?? '') === text) return;
  const next = { ...cur };
  if (trimmed === '') delete next[lineNo];
  else next[lineNo] = text;
  store = { ...store };
  if (Object.keys(next).length === 0) delete store[file];
  else store[file] = next;
  persist();
}

/** A file's notes, sorted by line number (0-based). */
export function getNotes(file: string): { lineNo: number; text: string }[] {
  const map = store[file];
  if (!map) return EMPTY;
  if (!derived[file]) {
    derived[file] = Object.entries(map)
      .map(([lineNo, text]) => ({ lineNo: Number(lineNo), text }))
      .sort((a, b) => a.lineNo - b.lineNo);
  }
  return derived[file];
}

export function clearNotes(file: string): void {
  if (!store[file]) return;
  store = { ...store };
  delete store[file];
  persist();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive note text for a single line. */
export function useNote(file: string, lineNo: number): string {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => getNote(file, lineNo), [file, lineNo]),
  );
}

/** Reactive list of a file's notes (sorted, 0-based line numbers). */
export function useNotes(file: string): { lineNo: number; text: string }[] {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => getNotes(file), [file]),
  );
}

/** A counter that changes whenever any note changes (for views spanning files). */
export function useNotesVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
