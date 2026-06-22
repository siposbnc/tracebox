import { useEffect, useRef } from 'react';

/**
 * Centralized Escape handling so overlapping overlays close in a sensible order:
 * floating windows (modals) before docked panels, and among equals the most
 * recently opened first. Every dismissible surface registers via
 * {@link useEscapeKey}; a single global listener routes each Escape to the
 * top-most active entry and stops there, so one press closes exactly one layer.
 */

/** Floating windows take precedence over docked panels. */
export type EscLayer = 'modal' | 'panel';

const LAYER_PRIORITY: Record<EscLayer, number> = { modal: 2, panel: 1 };

interface Entry {
  run: () => void;
  priority: number;
  seq: number;
}

let stack: Entry[] = [];
let seqCounter = 0;
let installed = false;

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || stack.length === 0) return;
  // highest priority wins; ties broken by most-recently-registered
  let top = stack[0];
  for (const entry of stack) {
    if (entry.priority > top.priority || (entry.priority === top.priority && entry.seq > top.seq)) {
      top = entry;
    }
  }
  e.preventDefault();
  e.stopPropagation();
  top.run();
}

function install(): void {
  if (installed) return;
  installed = true;
  // bubble phase: lets focused inputs (and capture-phase interceptors) handle
  // Escape first and stop propagation before it reaches the stack
  window.addEventListener('keydown', onKeyDown);
}

/**
 * Register `handler` to run when Escape is pressed and this surface is the
 * top-most one. `layer` decides precedence (`modal` over `panel`); `active`
 * lets a surface temporarily opt out (e.g. while capturing a key chord).
 */
export function useEscapeKey(handler: () => void, layer: EscLayer = 'modal', active = true): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!active) return;
    install();
    const entry: Entry = { run: () => ref.current(), priority: LAYER_PRIORITY[layer], seq: ++seqCounter };
    stack.push(entry);
    return () => {
      stack = stack.filter((x) => x !== entry);
    };
  }, [layer, active]);
}
