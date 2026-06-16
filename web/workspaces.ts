import { useCallback, useSyncExternalStore } from 'react';

/**
 * Named workspaces: a snapshot of the open files and each file's active search,
 * persisted in localStorage and reopenable in one click. Search state is keyed by
 * file path (session ids are ephemeral).
 */

const KEY = 'tracebox.workspaces';

/** The per-file view state worth restoring (the search and how it's interpreted). */
export interface ViewState {
  query: string;
  regex: boolean;
  grouped: boolean;
}

export interface WorkspaceFile extends ViewState {
  path: string;
}

export interface Workspace {
  name: string;
  savedAt: number;
  activePath: string | null;
  files: WorkspaceFile[];
}

function load(): Workspace[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as Workspace[]) : [];
  } catch {
    return [];
  }
}

let store: Workspace[] = load();
const listeners = new Set<() => void>();

function persist(next: Workspace[]): void {
  store = next;
  localStorage.setItem(KEY, JSON.stringify(store));
  for (const l of listeners) l();
}

export function listWorkspaces(): Workspace[] {
  return store;
}

/** Save a workspace, replacing any existing one with the same name. */
export function saveWorkspace(ws: Workspace): void {
  const next = store.filter((w) => w.name !== ws.name);
  next.push(ws);
  next.sort((a, b) => b.savedAt - a.savedAt);
  persist(next);
}

export function deleteWorkspace(name: string): void {
  persist(store.filter((w) => w.name !== name));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive list of saved workspaces (most recently saved first). */
export function useWorkspaces(): Workspace[] {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => store, []),
  );
}
