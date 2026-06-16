/**
 * Client-state store backed by the server (`/api/state`), not browser
 * localStorage. The desktop window's origin (port) can change between launches,
 * which would reset origin-scoped localStorage; persisting on disk via the
 * backend makes workspaces, bookmarks, notes, and settings stable.
 *
 * Mirrors the localStorage contract the UI was written against: synchronous
 * string get/set over an in-memory cache hydrated once at startup (see
 * `hydrateClientStore`, awaited before the app renders), with writes flushed to
 * the server on a short debounce.
 */

let cache: Record<string, string> = {};
let pending: Record<string, string | null> = {};
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  const patch = pending;
  pending = {};
  if (Object.keys(patch).length === 0) return;
  void fetch('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch }),
  }).catch(() => {
    // best effort; the in-memory cache still reflects the change this session
  });
}

function schedule(): void {
  if (timer === null) timer = setTimeout(flush, 200);
}

export const clientStore = {
  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
  },
  setItem(key: string, value: string): void {
    cache[key] = value;
    pending[key] = value;
    schedule();
  },
  removeItem(key: string): void {
    delete cache[key];
    pending[key] = null;
    schedule();
  },
};

/** Load all client state from the server. Must be awaited before the app renders. */
export async function hydrateClientStore(): Promise<void> {
  try {
    const res = await fetch('/api/state');
    const body = (await res.json()) as { values?: Record<string, string> };
    cache = body.values ?? {};
  } catch {
    cache = {};
  }

  // one-time migration: lift any pre-existing localStorage state (from the old
  // origin-scoped storage) into the server store so upgrades don't lose it
  if (Object.keys(cache).length === 0 && typeof localStorage !== 'undefined') {
    const patch: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('tracebox.')) continue;
      const v = localStorage.getItem(k);
      if (v !== null) {
        cache[k] = v;
        patch[k] = v;
      }
    }
    if (Object.keys(patch).length > 0) {
      void fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch }),
      }).catch(() => {});
    }
  }

  // flush any pending writes when the window goes away (debounce may be mid-wait)
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (Object.keys(pending).length === 0) return;
      const blob = new Blob([JSON.stringify({ patch: pending })], { type: 'application/json' });
      pending = {};
      navigator.sendBeacon('/api/state', blob);
    });
  }
}
