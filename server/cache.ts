import { readdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Management of the on-disk index cache (`%TEMP%/tracebox-index/`). Each open
 * file's index is a `<hash>.db`; the merged timeline writes transient
 * `merged-*.db` files which are excluded here.
 */

export interface CacheEntry {
  name: string;
  /** Source log file this index was built for. */
  path: string;
  size: number;
  lineCount: number;
  mtimeMs: number;
  /** True if a currently-open session is using this index (cannot be evicted). */
  inUse: boolean;
}

export interface CacheInfo {
  entries: CacheEntry[];
  totalSize: number;
}

function isSessionDb(name: string): boolean {
  return name.endsWith('.db') && !name.startsWith('merged-');
}

/** Read the source path + line count from a cache DB's meta (best effort). */
function readMeta(dbPath: string): { path: string | null; lineCount: number } {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const fp = (db.prepare(`SELECT value FROM meta WHERE key = 'fingerprint'`).get() as { value: string } | undefined)
        ?.value;
      const lc = (db.prepare(`SELECT value FROM meta WHERE key = 'lineCount'`).get() as { value: string } | undefined)
        ?.value;
      // fingerprint is `path|size|mtime`
      let srcPath: string | null = null;
      if (fp) {
        const parts = fp.split('|');
        parts.pop();
        parts.pop();
        srcPath = parts.join('|') || null;
      }
      return { path: srcPath, lineCount: Number(lc ?? 0) || 0 };
    } finally {
      db.close();
    }
  } catch {
    return { path: null, lineCount: 0 };
  }
}

/** `active` maps an in-use cache db path to its source file. */
export function listCache(dir: string, active: Map<string, string>): CacheInfo {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter(isSessionDb);
  } catch {
    return { entries: [], totalSize: 0 };
  }
  const entries: CacheEntry[] = [];
  let totalSize = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    totalSize += st.size;
    const activeFile = active.get(full);
    // for in-use caches read the path from the live session (don't open the db);
    // otherwise read it from the cache file's meta
    const meta = activeFile ? { path: activeFile, lineCount: 0 } : readMeta(full);
    entries.push({
      name,
      path: meta.path ?? name,
      size: st.size,
      lineCount: meta.lineCount,
      mtimeMs: st.mtimeMs,
      inUse: activeFile !== undefined,
    });
  }
  entries.sort((a, b) => b.size - a.size);
  return { entries, totalSize };
}

/** Delete one cache db by name. Refuses path traversal, non-caches, and in-use entries. */
export function evictCache(dir: string, name: string, active: Map<string, string>): boolean {
  if (name.includes('/') || name.includes('\\') || !isSessionDb(name)) return false;
  const full = path.join(dir, name);
  if (active.has(full)) return false;
  try {
    rmSync(full, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Delete cache dbs not used (mtime) within `retentionDays` and not in use. */
export function pruneStaleCache(
  dir: string,
  retentionDays: number,
  active: Map<string, string>,
): { removed: number; freed: number } {
  if (!retentionDays || retentionDays <= 0) return { removed: 0, freed: 0 };
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let removed = 0;
  let freed = 0;
  for (const e of listCache(dir, active).entries) {
    if (e.inUse || e.mtimeMs >= cutoff) continue;
    try {
      rmSync(path.join(dir, e.name), { force: true });
      removed++;
      freed += e.size;
    } catch {
      // ignore
    }
  }
  return { removed, freed };
}

/** Delete every cache db that isn't currently in use; returns bytes freed. */
export function clearCache(dir: string, active: Map<string, string>): { freed: number } {
  let freed = 0;
  for (const e of listCache(dir, active).entries) {
    if (e.inUse) continue;
    try {
      rmSync(path.join(dir, e.name), { force: true });
      freed += e.size;
    } catch {
      // ignore
    }
  }
  return { freed };
}
