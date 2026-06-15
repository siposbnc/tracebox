import { useSyncExternalStore } from 'react';

/**
 * Rebindable keyboard shortcuts. Each command has a default chord; user
 * overrides are persisted in localStorage and shared across tabs. A chord is a
 * canonical string like `Mod+G`, `Shift+F2`, `Mod+Shift+B` — `Mod` matches Ctrl
 * or Cmd so bindings work on every platform. An empty chord means "unbound".
 */

export interface Command {
  id: string;
  label: string;
  defaultChord: string;
}

export const COMMANDS: Command[] = [
  { id: 'focusSearch', label: 'Focus search', defaultChord: 'Mod+F' },
  { id: 'goToLine', label: 'Go to line', defaultChord: 'Mod+G' },
  { id: 'gotoStart', label: 'Jump to top', defaultChord: 'Home' },
  { id: 'gotoEnd', label: 'Jump to bottom', defaultChord: 'End' },
  { id: 'pageDown', label: 'Jump down a page', defaultChord: 'PageDown' },
  { id: 'pageUp', label: 'Jump up a page', defaultChord: 'PageUp' },
  { id: 'pageDownBig', label: 'Jump down a big page', defaultChord: 'Mod+PageDown' },
  { id: 'pageUpBig', label: 'Jump up a big page', defaultChord: 'Mod+PageUp' },
  { id: 'toggleBookmark', label: 'Toggle bookmark on selected line', defaultChord: 'Mod+B' },
  { id: 'nextBookmark', label: 'Next bookmark', defaultChord: 'F2' },
  { id: 'prevBookmark', label: 'Previous bookmark', defaultChord: 'Shift+F2' },
  { id: 'nextMatch', label: 'Next match (highlight mode)', defaultChord: 'F3' },
  { id: 'prevMatch', label: 'Previous match (highlight mode)', defaultChord: 'Shift+F3' },
  { id: 'toggleHighlight', label: 'Highlight matches in place', defaultChord: 'Mod+H' },
  { id: 'showShortcuts', label: 'Show keyboard shortcuts', defaultChord: 'Mod+/' },
];

/** Fixed shortcuts that are not rebindable, shown in the help for reference. */
export const FIXED_SHORTCUTS: { keys: string; label: string }[] = [
  { keys: '↑ / ↓', label: 'Move selection up / down' },
  { keys: 'Esc', label: 'Clear search / close panel' },
];

const KEY = 'tracebox.keybindings';
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

function loadOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    const obj = raw ? (JSON.parse(raw) as unknown) : {};
    return obj && typeof obj === 'object' ? (obj as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let overrides = loadOverrides();
const listeners = new Set<() => void>();

function computeSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of COMMANDS) out[c.id] = c.id in overrides ? overrides[c.id] : c.defaultChord;
  return out;
}

let snapshot = computeSnapshot();

function emit(): void {
  for (const l of listeners) l();
}

function persist(): void {
  localStorage.setItem(KEY, JSON.stringify(overrides));
  snapshot = computeSnapshot();
  emit();
}

/** Current chord for a command (override if set, else its default). */
export function getChord(id: string): string {
  return id in overrides ? overrides[id] : (COMMANDS.find((c) => c.id === id)?.defaultChord ?? '');
}

/** Assign a chord to a command. Any other command holding that chord is unbound (last-wins). */
export function setChord(id: string, chord: string): void {
  if (chord) {
    for (const c of COMMANDS) {
      if (c.id !== id && getChord(c.id) === chord) overrides[c.id] = '';
    }
  }
  overrides[id] = chord;
  persist();
}

export function resetChord(id: string): void {
  if (!(id in overrides)) return;
  delete overrides[id];
  persist();
}

export function resetAllChords(): void {
  overrides = {};
  persist();
}

const MOD_KEYS = new Set(['Control', 'Meta', 'Shift', 'Alt']);

function normalizeKey(k: string): string {
  if (k === ' ') return 'Space';
  return k.length === 1 ? k.toUpperCase() : k;
}

/** Canonical chord for a keyboard event, or '' if only a modifier is held. */
export function eventToChord(e: KeyboardEvent): string {
  if (MOD_KEYS.has(e.key)) return '';
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(normalizeKey(e.key));
  return parts.join('+');
}

/** The command bound to this event, if any. */
export function matchCommand(e: KeyboardEvent): string | null {
  const chord = eventToChord(e);
  if (!chord) return null;
  for (const c of COMMANDS) if (getChord(c.id) === chord) return c.id;
  return null;
}

/** Human-readable chord (`Mod+G` → `Ctrl+G`, or ⌘ symbols on macOS). */
export function formatChord(chord: string): string {
  if (!chord) return '';
  return chord
    .split('+')
    .map((p) => {
      if (p === 'Mod') return IS_MAC ? '⌘' : 'Ctrl';
      if (p === 'Alt') return IS_MAC ? '⌥' : 'Alt';
      if (p === 'Shift') return IS_MAC ? '⇧' : 'Shift';
      return p;
    })
    .join('+');
}

/** Whether an event target is a text input where plain-key shortcuts should be ignored. */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive map of commandId → current chord. */
export function useBindings(): Record<string, string> {
  return useSyncExternalStore(subscribe, () => snapshot);
}
