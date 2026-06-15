import { useCallback, useSyncExternalStore } from 'react';

/**
 * Per-file column selection for the columnar (grid) view, persisted in
 * localStorage and keyed by file path. Empty means "use the default columns".
 */

const KEY = 'tracebox.columns';
const EMPTY: string[] = [];

type Store = Record<string, string[]>;

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
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getColumns(file: string): string[] {
  return store[file] ?? EMPTY;
}

export function setColumns(file: string, cols: string[]): void {
  store = { ...store };
  if (cols.length === 0) delete store[file];
  else store[file] = cols;
  localStorage.setItem(KEY, JSON.stringify(store));
  emit();
}

const TS_LEVEL = /^(timestamp|ts|time|@timestamp|date|datetime|eventtime|level|lvl|severity|loglevel)$/i;

/** A sensible starting column set: the most common fields, minus ts/level (shown as fixed columns). */
export function defaultColumns(fieldNames: { key: string; count: number }[]): string[] {
  return fieldNames
    .map((f) => f.key)
    .filter((k) => !TS_LEVEL.test(k))
    .slice(0, 6);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive per-file column selection. */
export function useColumns(file: string): string[] {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => getColumns(file), [file]),
  );
}
