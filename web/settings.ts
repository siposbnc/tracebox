import { useSyncExternalStore } from 'react';

/** Display order for log rows: oldest-first (file order) or newest-first. */
export type Order = 'asc' | 'desc';

const ORDER_KEY = 'tracebox.order';

let order: Order = localStorage.getItem(ORDER_KEY) === 'desc' ? 'desc' : 'asc';
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook for the global row order. Updates every open tab when changed. */
export function useOrder(): Order {
  return useSyncExternalStore(subscribe, getOrder);
}
