import { useCallback, useSyncExternalStore } from 'react';
import { clientStore } from './clientStore';

/**
 * Per-file column widths (px) for the columnar (grid) view, persisted in the
 * client store and keyed by file path then column name. A column with no stored
 * width falls back to the default. Mirrors {@link ./columns.ts}.
 */

const KEY = 'tracebox.colwidths';
const EMPTY: Record<string, number> = {};

/** Clamp so a column can't be dragged to uselessly small or absurdly large. */
export const MIN_COL_W = 60;
export const MAX_COL_W = 900;

type Store = Record<string, Record<string, number>>;

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

export function getColumnWidths(file: string): Record<string, number> {
  return store[file] ?? EMPTY;
}

export function setColumnWidth(file: string, col: string, width: number): void {
  const px = Math.round(Math.min(MAX_COL_W, Math.max(MIN_COL_W, width)));
  store = { ...store, [file]: { ...(store[file] ?? {}), [col]: px } };
  clientStore.setItem(KEY, JSON.stringify(store));
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive per-file column widths. */
export function useColumnWidths(file: string): Record<string, number> {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => getColumnWidths(file), [file]),
  );
}
