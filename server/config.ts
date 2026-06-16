import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Small persistent server config (cache location + retention). Lives outside the
 * cache itself so it survives cache clears: `~/.tracebox/config.json`.
 */

const CONFIG_DIR = path.join(homedir(), '.tracebox');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/** Default index-cache location when not overridden. */
export const DEFAULT_CACHE_DIR = path.join(tmpdir(), 'tracebox-index');
/** Default: clear cache entries unused for this many days (0 disables). */
const DEFAULT_RETENTION_DAYS = 7;

export interface Config {
  cacheDir: string;
  cacheRetentionDays: number;
}

let cached: Config | null = null;

function normalize(raw: Partial<Config>): Config {
  const dir = typeof raw.cacheDir === 'string' && raw.cacheDir.trim() ? raw.cacheDir.trim() : DEFAULT_CACHE_DIR;
  const days =
    typeof raw.cacheRetentionDays === 'number' && Number.isFinite(raw.cacheRetentionDays) && raw.cacheRetentionDays >= 0
      ? Math.floor(raw.cacheRetentionDays)
      : DEFAULT_RETENTION_DAYS;
  return { cacheDir: dir, cacheRetentionDays: days };
}

export function getConfig(): Config {
  if (cached) return cached;
  let raw: Partial<Config> = {};
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
  } catch {
    // no config yet — use defaults
  }
  cached = normalize(raw);
  return cached;
}

/** Merge and persist a config patch; returns the new config. */
export function setConfig(patch: Partial<Config>): Config {
  const next = normalize({ ...getConfig(), ...patch });
  cached = next;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  } catch {
    // best effort — keep the in-memory value even if persisting fails
  }
  return next;
}
