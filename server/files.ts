import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
}

/** Available filesystem roots (drive letters on Windows, "/" elsewhere). */
export function listRoots(): string[] {
  if (process.platform !== 'win32') return ['/'];
  const roots: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    try {
      if (existsSync(drive)) roots.push(drive);
    } catch {
      // skip inaccessible drives
    }
  }
  return roots;
}

export async function listDir(dirPath: string): Promise<{ path: string; parent: string | null; entries: DirEntry[] }> {
  const resolved = path.resolve(dirPath);
  const names = await readdir(resolved, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of names) {
    if (d.name.startsWith('$')) continue;
    const full = path.join(resolved, d.name);
    let size = 0;
    let mtimeMs = 0;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) continue;
    if (!isDir) {
      try {
        const st = await stat(full);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
    }
    entries.push({ name: d.name, path: full, dir: isDir, size, mtimeMs });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const parent = path.dirname(resolved);
  return { path: resolved, parent: parent === resolved ? null : parent, entries };
}

// ---------------------------------------------------------------------------
// Recent files

interface RecentFile {
  path: string;
  openedAt: number;
}

function configPath(): string {
  const dir = path.join(homedir(), '.tracebox');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'recent.json');
}

export function getRecents(): RecentFile[] {
  try {
    const data = JSON.parse(readFileSync(configPath(), 'utf8')) as RecentFile[];
    return data.filter((r) => existsSync(r.path));
  } catch {
    return [];
  }
}

export function addRecent(filePath: string): void {
  const recents = getRecents().filter((r) => r.path.toLowerCase() !== filePath.toLowerCase());
  recents.unshift({ path: filePath, openedAt: Date.now() });
  try {
    writeFileSync(configPath(), JSON.stringify(recents.slice(0, 15), null, 2));
  } catch {
    // non-fatal
  }
}
