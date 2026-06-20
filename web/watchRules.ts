import { useCallback, useSyncExternalStore } from 'react';
import { clientStore } from './clientStore';
import type { WatchRule, WatchRuleKind } from './types';

/**
 * Per-file watch rules, persisted via the client store and shared across open
 * tabs. Keyed by absolute file path so rules survive reopening a file. The
 * server holds no rule state of its own — the App pushes each session's rules to
 * the backend, which evaluates them against appended lines while tailing.
 */

const KEY = 'tracebox.watchRules';
const EMPTY: WatchRule[] = [];

type Store = Record<string, WatchRule[]>;

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

export function getWatchRules(file: string): WatchRule[] {
  return store[file] ?? EMPTY;
}

function setFileRules(file: string, rules: WatchRule[]): void {
  store = { ...store };
  if (rules.length === 0) delete store[file];
  else store[file] = rules;
  persist();
}

/** A fresh rule with sensible defaults for the given kind. */
export function newWatchRule(kind: WatchRuleKind): WatchRule {
  return {
    id: crypto.randomUUID(),
    name: '',
    kind,
    query: '',
    threshold: 10,
    windowSec: 60,
    enabled: true,
    desktop: false,
  };
}

export function addWatchRule(file: string, rule: WatchRule): void {
  setFileRules(file, [...getWatchRules(file), rule]);
}

export function updateWatchRule(file: string, id: string, patch: Partial<WatchRule>): void {
  setFileRules(
    file,
    getWatchRules(file).map((r) => (r.id === id ? { ...r, ...patch } : r)),
  );
}

export function removeWatchRule(file: string, id: string): void {
  setFileRules(
    file,
    getWatchRules(file).filter((r) => r.id !== id),
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive list of a file's watch rules. */
export function useWatchRules(file: string): WatchRule[] {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => getWatchRules(file), [file]),
  );
}

/** A counter that changes whenever any file's watch rules change (for app-level sync). */
export function useWatchRulesVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
