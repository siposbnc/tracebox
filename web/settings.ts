import { useSyncExternalStore } from 'react';
import { clientStore } from './clientStore';

/** Display order for log rows: oldest-first (file order) or newest-first. */
export type Order = 'asc' | 'desc';

/** Timezone used to render all timestamps. */
export type Tz = 'utc' | 'local';

/** How the detail panel renders a structured line: flattened fields or a JSON tree. */
export type DetailView = 'flat' | 'json';

/** Color theme for the whole UI. */
export type Theme = 'dark' | 'light' | 'hc';

/** Reading font size for log content (rows, detail, context). */
export type FontSize = 'sm' | 'md' | 'lg' | 'xl';

/**
 * Font-size presets → content metrics, in px. `font` drives the `--tb-row-font`
 * CSS variable used by log text; `line` is both its line-height and the
 * virtualized row height, so rows stay aligned at every size.
 */
export const FONT_METRICS: Record<FontSize, { font: number; line: number }> = {
  sm: { font: 12, line: 22 },
  md: { font: 13, line: 24 },
  lg: { font: 15, line: 27 },
  xl: { font: 17, line: 30 },
};

const ORDER_KEY = 'tracebox.order';
const TZ_KEY = 'tracebox.tz';
const CONTEXT_KEY = 'tracebox.contextLines';
const HISTOGRAM_KEY = 'tracebox.histogramDefault';
const PAGE_JUMP_KEY = 'tracebox.pageJump';
const PAGE_JUMP_BIG_KEY = 'tracebox.pageJumpBig';

const WRAP_KEY = 'tracebox.wrap';
const COLUMNAR_KEY = 'tracebox.columnar';
const DETAIL_VIEW_KEY = 'tracebox.detailView';
const THEME_KEY = 'tracebox.theme';
const FONT_SIZE_KEY = 'tracebox.fontSize';
const LEVEL_BARS_KEY = 'tracebox.levelBars';

let order: Order = clientStore.getItem(ORDER_KEY) === 'desc' ? 'desc' : 'asc';
let tz: Tz = clientStore.getItem(TZ_KEY) === 'local' ? 'local' : 'utc';
let wrap = clientStore.getItem(WRAP_KEY) === 'true';
let columnar = clientStore.getItem(COLUMNAR_KEY) === 'true';
// the colored level-accent bar before WARN+ rows; on by default
let levelBars = clientStore.getItem(LEVEL_BARS_KEY) !== 'false';
let detailView: DetailView = clientStore.getItem(DETAIL_VIEW_KEY) === 'json' ? 'json' : 'flat';

function loadTheme(): Theme {
  const raw = clientStore.getItem(THEME_KEY);
  return raw === 'light' || raw === 'hc' ? raw : 'dark';
}
function loadFontSize(): FontSize {
  const raw = clientStore.getItem(FONT_SIZE_KEY);
  return raw === 'sm' || raw === 'lg' || raw === 'xl' ? raw : 'md';
}

let theme: Theme = loadTheme();
let fontSize: FontSize = loadFontSize();

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

// ---- Appearance (theme + font size) ----------------------------------------
// Theme is a `data-theme` attribute on <html>; the CSS variable overrides in
// styles.css repaint the whole UI. Font size is exposed as CSS variables that
// log content reads, and as a row height the virtualized lists size rows by.

function applyTheme(t: Theme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = t;
}

function applyFontSize(f: FontSize): void {
  if (typeof document === 'undefined') return;
  const m = FONT_METRICS[f];
  const el = document.documentElement;
  el.style.setProperty('--tb-row-font', `${m.font}px`);
  el.style.setProperty('--tb-row-line', `${m.line}px`);
}

/**
 * Apply the persisted theme and font size to the document. Call once at startup
 * (before first paint) so the UI never flashes the wrong theme.
 */
export function initAppearance(): void {
  applyTheme(theme);
  applyFontSize(fontSize);
}

export function getTheme(): Theme {
  return theme;
}

export function setTheme(next: Theme): void {
  if (next === theme) return;
  theme = next;
  clientStore.setItem(THEME_KEY, next);
  applyTheme(next);
  emit();
}

/** React hook for the active color theme. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme);
}

export function getFontSize(): FontSize {
  return fontSize;
}

export function setFontSize(next: FontSize): void {
  if (next === fontSize) return;
  fontSize = next;
  clientStore.setItem(FONT_SIZE_KEY, next);
  applyFontSize(next);
  emit();
}

/** React hook for the reading font size of log content. */
export function useFontSize(): FontSize {
  return useSyncExternalStore(subscribe, getFontSize);
}

/** Virtualized log-row height (px) for the active font size. */
export function getRowHeight(): number {
  return FONT_METRICS[fontSize].line;
}

/** React hook for the virtualized log-row height (px). Re-renders on font change. */
export function useRowHeight(): number {
  return FONT_METRICS[useFontSize()].line;
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

export function getLevelBars(): boolean {
  return levelBars;
}

export function setLevelBars(next: boolean): void {
  if (next === levelBars) return;
  levelBars = next;
  clientStore.setItem(LEVEL_BARS_KEY, String(next));
  emit();
}

/** Whether the colored accent bar marks WARN/ERROR/FATAL rows. Off aligns every row. */
export function useLevelBars(): boolean {
  return useSyncExternalStore(subscribe, getLevelBars);
}

export function getDetailView(): DetailView {
  return detailView;
}

export function setDetailView(next: DetailView): void {
  if (next === detailView) return;
  detailView = next;
  clientStore.setItem(DETAIL_VIEW_KEY, next);
  emit();
}

/** Preferred structured view in the detail panel: flattened fields or a JSON tree. */
export function useDetailView(): DetailView {
  return useSyncExternalStore(subscribe, getDetailView);
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
