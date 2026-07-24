import { useCallback, useSyncExternalStore } from 'react';
import { clientStore } from './clientStore';

/**
 * Per-file column selection for the columnar (grid) view, persisted in
 * the client store and keyed by file path. Empty means "use the default columns".
 *
 * The list mixes ordinary data fields with the built-in columns (line number,
 * time, level) — all of which can be reordered (drag) and hidden (Columns menu).
 * Built-in columns use reserved sentinel keys ({@link LINE_COL} etc.) that can't
 * collide with a real field name.
 */

// Reserved keys for the built-in columns. The `@@` prefix keeps them from
// colliding with a parsed field name (field keys come from JSON/logfmt/regex and
// never start with `@@`) and from showing up in field listings. They never reach
// the server — the row fetch projects only real fields — and render via columnLabel.
export const LINE_COL = '@@line';
export const TIME_COL = '@@time';
export const LEVEL_COL = '@@level';

/** Built-in columns in their canonical (default) left-to-right order. */
export const BUILTIN_COLS = [LINE_COL, TIME_COL, LEVEL_COL] as const;
const BUILTIN_SET = new Set<string>(BUILTIN_COLS);

/** Whether a column key is one of the built-in (non-field) columns. */
export function isBuiltinCol(c: string): boolean {
  return BUILTIN_SET.has(c);
}

/** Human label for a column header (built-ins get a friendly name; '#' for line). */
export function columnLabel(c: string): string {
  switch (c) {
    case LINE_COL:
      return '#';
    case TIME_COL:
      return 'time';
    case LEVEL_COL:
      return 'level';
    default:
      return c;
  }
}

const KEY = 'tracebox.columns'; // legacy: data-only arrays (no built-in columns)
const KEY2 = 'tracebox.columns.v2'; // current: arrays including built-in columns
const EMPTY: string[] = [];

type Store = Record<string, string[]>;

/** Prepend any missing built-in columns (in canonical order) to a data-only list. */
function withBuiltins(cols: string[]): string[] {
  const missing = BUILTIN_COLS.filter((b) => !cols.includes(b));
  return [...missing, ...cols.filter((c) => !isBuiltinCol(c))];
}

function load(): Store {
  // Prefer the v2 store (arrays already include the built-in columns).
  try {
    const raw = clientStore.getItem(KEY2);
    if (raw) {
      const obj = JSON.parse(raw) as unknown;
      if (obj && typeof obj === 'object') return obj as Store;
    }
  } catch {
    /* fall through to migration */
  }
  // One-time migration: older arrays held only data fields, with line/time/level
  // rendered as fixed columns. Fold the built-ins in so they're orderable/hideable.
  try {
    const raw = clientStore.getItem(KEY);
    const obj = raw ? (JSON.parse(raw) as unknown) : {};
    if (obj && typeof obj === 'object') {
      const migrated: Store = {};
      for (const [file, cols] of Object.entries(obj as Record<string, unknown>)) {
        if (Array.isArray(cols)) migrated[file] = withBuiltins(cols as string[]);
      }
      clientStore.setItem(KEY2, JSON.stringify(migrated));
      return migrated;
    }
  } catch {
    /* ignore */
  }
  return {};
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
  clientStore.setItem(KEY2, JSON.stringify(store));
  emit();
}

/**
 * Add a column to a list. Data fields append to the end; built-in columns slot
 * into the leading built-in run at their canonical position, so re-enabling the
 * line number doesn't land it on the far right.
 */
export function addColumn(cols: string[], key: string): string[] {
  if (cols.includes(key)) return cols;
  if (!isBuiltinCol(key)) return [...cols, key];
  const rank = (c: string): number => BUILTIN_COLS.indexOf(c as (typeof BUILTIN_COLS)[number]);
  let i = 0;
  while (i < cols.length && isBuiltinCol(cols[i]) && rank(cols[i]) < rank(key)) i++;
  const next = cols.slice();
  next.splice(i, 0, key);
  return next;
}

const TS_LEVEL = /^(timestamp|ts|time|@timestamp|date|datetime|eventtime|level|lvl|severity|loglevel)$/i;

/**
 * A sensible starting column set: the built-in line/time/level columns (plus Δt if
 * enabled), then the most common data fields (minus ts/level, shown as built-ins).
 */
export function defaultColumns(fieldNames: { key: string; count: number }[]): string[] {
  const data = fieldNames
    .map((f) => f.key)
    .filter((k) => !TS_LEVEL.test(k))
    .slice(0, 6);
  return [...BUILTIN_COLS, ...data];
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
