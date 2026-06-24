import { useCallback, useSyncExternalStore } from 'react';
import { clientStore } from './clientStore';
import type { Dashboard, Panel } from './types';

/**
 * Named dashboards: a reusable set of user-configured chart panels, persisted in
 * the client store and runnable against any open file. Unlike workspaces (which
 * capture which files are open), a dashboard is format-oriented — open it on any
 * log and each panel re-runs its own scoping query + aggregation.
 */

const KEY = 'tracebox.dashboards';

function load(): Dashboard[] {
  try {
    const raw = clientStore.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as Dashboard[]) : [];
  } catch {
    return [];
  }
}

let store: Dashboard[] = load();
const listeners = new Set<() => void>();

function persist(next: Dashboard[]): void {
  store = next;
  clientStore.setItem(KEY, JSON.stringify(store));
  for (const l of listeners) l();
}

export function listDashboards(): Dashboard[] {
  return store;
}

/** Save a dashboard, replacing any existing one with the same id. */
export function saveDashboard(dash: Dashboard): void {
  const next = store.filter((d) => d.id !== dash.id);
  next.push({ ...dash, savedAt: Date.now() });
  next.sort((a, b) => b.savedAt - a.savedAt);
  persist(next);
}

export function deleteDashboard(id: string): void {
  persist(store.filter((d) => d.id !== id));
}

/** A fresh, empty dashboard (not yet persisted). */
export function newDashboard(name: string): Dashboard {
  return { id: uid(), name, savedAt: Date.now(), panels: [] };
}

/** A fresh panel with sensible defaults (not yet persisted). */
export function newPanel(): Panel {
  return {
    id: uid(),
    title: 'Lines over time',
    chart: 'line',
    query: '',
    spec: { groupBy: { type: 'time', buckets: 60 }, splitBy: { type: 'level' }, metric: { type: 'count' } },
    w: 1,
  };
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive list of saved dashboards (most recently saved first). */
export function useDashboards(): Dashboard[] {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => store, []),
  );
}
