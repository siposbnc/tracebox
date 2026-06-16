import { useSyncExternalStore } from 'react';
import { clientStore } from './clientStore';

/** Display order for log rows: oldest-first (file order) or newest-first. */
export type Order = 'asc' | 'desc';

/** Timezone used to render all timestamps. */
export type Tz = 'utc' | 'local';

const ORDER_KEY = 'tracebox.order';
const TZ_KEY = 'tracebox.tz';
const CONTEXT_KEY = 'tracebox.contextLines';
const HISTOGRAM_KEY = 'tracebox.histogramDefault';
const PAGE_JUMP_KEY = 'tracebox.pageJump';
const PAGE_JUMP_BIG_KEY = 'tracebox.pageJumpBig';

const WRAP_KEY = 'tracebox.wrap';
const COLUMNAR_KEY = 'tracebox.columnar';

let order: Order = clientStore.getItem(ORDER_KEY) === 'desc' ? 'desc' : 'asc';
let tz: Tz = clientStore.getItem(TZ_KEY) === 'local' ? 'local' : 'utc';
let wrap = clientStore.getItem(WRAP_KEY) === 'true';
let columnar = clientStore.getItem(COLUMNAR_KEY) === 'true';

/** Read a non-negative integer setting, falling back to `fallback` when unset/invalid. */
function loadNumber(key: string, fallback: number, min = 0, max = 1_000_000): number {
  const raw = clientStore.getItem(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
}

let contextLines = loadNumber(CONTEXT_KEY, 5, 0, 1000);
let histogramDefault = clientStore.getItem(HISTOGRAM_KEY) !== 'false';
let pageJump = loadNumber(PAGE_JUMP_KEY, 100, 1);
let pageJumpBig = loadNumber(PAGE_JUMP_BIG_KEY, 1000, 1);

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getOrder(): Order {
  return order;
}

export function setOrder(next: Order): void {
  if (next === order) return;
  order = next;
  clientStore.setItem(ORDER_KEY, next);
  emit();
}

/** React hook for the global row order. Updates every open tab when changed. */
export function useOrder(): Order {
  return useSyncExternalStore(subscribe, getOrder);
}

export function getTz(): Tz {
  return tz;
}

export function setTz(next: Tz): void {
  if (next === tz) return;
  tz = next;
  clientStore.setItem(TZ_KEY, next);
  emit();
}

/** React hook for the global timestamp timezone. Updates every open tab when changed. */
export function useTz(): Tz {
  return useSyncExternalStore(subscribe, getTz);
}

export function getWrap(): boolean {
  return wrap;
}

export function setWrap(next: boolean): void {
  if (next === wrap) return;
  wrap = next;
  clientStore.setItem(WRAP_KEY, String(next));
  emit();
}

/** Whether long log lines wrap instead of being truncated. */
export function useWrap(): boolean {
  return useSyncExternalStore(subscribe, getWrap);
}

export function getColumnar(): boolean {
  return columnar;
}

export function setColumnar(next: boolean): void {
  if (next === columnar) return;
  columnar = next;
  clientStore.setItem(COLUMNAR_KEY, String(next));
  emit();
}

/** Whether structured logs render as a column grid instead of raw lines. */
export function useColumnar(): boolean {
  return useSyncExternalStore(subscribe, getColumnar);
}

export function getContextLines(): number {
  return contextLines;
}

export function setContextLines(next: number): void {
  const clamped = Math.min(Math.max(Math.round(next), 0), 1000);
  if (clamped === contextLines) return;
  contextLines = clamped;
  clientStore.setItem(CONTEXT_KEY, String(clamped));
  emit();
}

/** Default number of context lines shown before/after a line in the context peek. */
export function useContextLines(): number {
  return useSyncExternalStore(subscribe, getContextLines);
}

export function getPageJump(): number {
  return pageJump;
}

export function setPageJump(next: number): void {
  const clamped = Math.min(Math.max(Math.round(next), 1), 1_000_000);
  if (clamped === pageJump) return;
  pageJump = clamped;
  clientStore.setItem(PAGE_JUMP_KEY, String(clamped));
  emit();
}

/** Rows moved by Page Up / Page Down. */
export function usePageJump(): number {
  return useSyncExternalStore(subscribe, getPageJump);
}

export function getPageJumpBig(): number {
  return pageJumpBig;
}

export function setPageJumpBig(next: number): void {
  const clamped = Math.min(Math.max(Math.round(next), 1), 1_000_000);
  if (clamped === pageJumpBig) return;
  pageJumpBig = clamped;
  clientStore.setItem(PAGE_JUMP_BIG_KEY, String(clamped));
  emit();
}

/** Rows moved by Ctrl/Cmd + Page Up / Page Down. */
export function usePageJumpBig(): number {
  return useSyncExternalStore(subscribe, getPageJumpBig);
}

export function getHistogramDefault(): boolean {
  return histogramDefault;
}

export function setHistogramDefault(next: boolean): void {
  if (next === histogramDefault) return;
  histogramDefault = next;
  clientStore.setItem(HISTOGRAM_KEY, String(next));
  emit();
}

/** Whether the histogram is shown by default when a file opens. */
export function useHistogramDefault(): boolean {
  return useSyncExternalStore(subscribe, getHistogramDefault);
}
