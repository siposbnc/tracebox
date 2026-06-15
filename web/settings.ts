import { useSyncExternalStore } from 'react';

/** Display order for log rows: oldest-first (file order) or newest-first. */
export type Order = 'asc' | 'desc';

/** Timezone used to render all timestamps. */
export type Tz = 'utc' | 'local';

const ORDER_KEY = 'tracebox.order';
const TZ_KEY = 'tracebox.tz';

let order: Order = localStorage.getItem(ORDER_KEY) === 'desc' ? 'desc' : 'asc';
let tz: Tz = localStorage.getItem(TZ_KEY) === 'local' ? 'local' : 'utc';

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
  localStorage.setItem(ORDER_KEY, next);
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
  localStorage.setItem(TZ_KEY, next);
  emit();
}

/** React hook for the global timestamp timezone. Updates every open tab when changed. */
export function useTz(): Tz {
  return useSyncExternalStore(subscribe, getTz);
}
