import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Rotation-group detection: given a log file, find its rotated siblings in the
 * same directory (logrotate numeric `app.log.1[.gz]` and dateext
 * `app.log-20240101` / `app-2024-01-01.log` styles) so they can be opened as one
 * time-ordered stream. Members are ordered oldest→newest by mtime, which is
 * pattern-agnostic and matches how rotation actually timestamps files.
 */

export interface RotationMember {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Reduce a filename to its rotation base (the stable part shared across rotations). */
export function rotationBase(name: string): string {
  let n = name;
  n = n.replace(/\.(gz|gzip|bz2|xz|zip)$/i, ''); // compression extension
  n = n.replace(/\.\d+$/, ''); // logrotate numeric suffix: app.log.1
  n = n.replace(/[._-]\d{4}-?\d{2}-?\d{2}$/, ''); // dateext suffix: app.log-20240101
  n = n.replace(/[._-]\d{4}-?\d{2}-?\d{2}(\.[A-Za-z][A-Za-z0-9]*)$/, '$1'); // infix date: app-2024-01-01.log
  return n;
}

/**
 * The rotation group for `file` (including itself), oldest→newest. Returns just
 * `[file]` when no rotated siblings are found.
 */
export function detectRotationGroup(file: string): RotationMember[] {
  const full = path.resolve(file);
  const dir = path.dirname(full);
  const base = rotationBase(path.basename(full));

  const self = (): RotationMember[] => {
    const st = statSync(full);
    return [{ path: full, size: st.size, mtimeMs: st.mtimeMs }];
  };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return self();
  }

  const members: RotationMember[] = [];
  for (const e of entries) {
    if (rotationBase(e) !== base) continue;
    const p = path.join(dir, e);
    try {
      const st = statSync(p);
      if (st.isFile()) members.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // skip unreadable
    }
  }
  if (members.length <= 1) return self();
  members.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  return members;
}
