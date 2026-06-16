import { useSyncExternalStore } from 'react';
import { clientStore } from './clientStore';

/**
 * Persistent search history (recent queries) and saved searches (named queries
 * the user pins for reuse). Both live in the client store and are shared across all
 * open tabs via a single store.
 */

const HISTORY_KEY = 'tracebox.searchHistory';
const SAVED_KEY = 'tracebox.savedSearches';
const HISTORY_LIMIT = 50;

export interface SavedSearch {
  name: string;
  query: string;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = clientStore.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

let history: string[] = load<string[]>(HISTORY_KEY, []).filter((q) => typeof q === 'string');
let saved: SavedSearch[] = load<SavedSearch[]>(SAVED_KEY, []).filter(
  (s) => s && typeof s.query === 'string',
);

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function persistHistory(): void {
  clientStore.setItem(HISTORY_KEY, JSON.stringify(history));
  emit();
}

function persistSaved(): void {
  clientStore.setItem(SAVED_KEY, JSON.stringify(saved));
  emit();
}

/** Record a submitted query at the front of the history (most-recent-first, deduped). */
export function recordHistory(query: string): void {
  const q = query.trim();
  if (q === '') return;
  history = [q, ...history.filter((h) => h !== q)].slice(0, HISTORY_LIMIT);
  persistHistory();
}

export function clearHistory(): void {
  if (history.length === 0) return;
  history = [];
  persistHistory();
}

export function getHistory(): string[] {
  return history;
}

export function getSaved(): SavedSearch[] {
  return saved;
}

/** Save (or rename) a query under a name. A query is stored at most once. */
export function saveSearch(query: string, name: string): void {
  const q = query.trim();
  if (q === '') return;
  const trimmedName = name.trim() || q;
  saved = [{ name: trimmedName, query: q }, ...saved.filter((s) => s.query !== q)];
  persistSaved();
}

export function removeSaved(query: string): void {
  const next = saved.filter((s) => s.query !== query);
  if (next.length === saved.length) return;
  saved = next;
  persistSaved();
}

export function isSaved(query: string): boolean {
  const q = query.trim();
  return saved.some((s) => s.query === q);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHistory(): string[] {
  return useSyncExternalStore(subscribe, getHistory);
}

export function useSaved(): SavedSearch[] {
  return useSyncExternalStore(subscribe, getSaved);
}
