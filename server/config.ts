import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Small persistent server config (cache location + retention). Lives outside the
 * cache itself so it survives cache clears: `~/.tracebox/config.json`.
 */

/** Config location, overridable via TRACEBOX_CONFIG_DIR (read dynamically so tests
 * can isolate it). Defaults to `~/.tracebox`. */
function configDir(): string {
  const override = process.env.TRACEBOX_CONFIG_DIR;
  return override && override.trim() ? override.trim() : path.join(homedir(), '.tracebox');
}
function configFile(): string {
  return path.join(configDir(), 'config.json');
}

/** Default index-cache location when not overridden. */
export const DEFAULT_CACHE_DIR = path.join(tmpdir(), 'tracebox-index');
/** Default: clear cache entries unused for this many days (0 disables). */
const DEFAULT_RETENTION_DAYS = 7;

/**
 * A user-defined log format: a regular expression with named capture groups.
 * `timestamp`, `level` (or `level2`), and `message` groups are treated as the
 * record's metadata; every other named group becomes a structured field. This is
 * the same mapping the built-in regex formats use, so a custom parser slots into
 * auto-detection alongside them.
 */
export interface CustomParserSpec {
  name: string;
  pattern: string;
}

export interface Config {
  cacheDir: string;
  cacheRetentionDays: number;
  parsers: CustomParserSpec[];
}

let cached: Config | null = null;

/** A spec is usable only if it has a name and a regex that compiles with at least
 * one named capture group (without groups it can never produce fields). */
export function validateParser(spec: unknown): { ok: true; spec: CustomParserSpec } | { ok: false; error: string } {
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'parser must be an object' };
  const name = (spec as CustomParserSpec).name;
  const pattern = (spec as CustomParserSpec).pattern;
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'parser needs a non-empty "name"' };
  if (typeof pattern !== 'string' || !pattern.trim()) return { ok: false, error: 'parser needs a non-empty "pattern"' };
  if (!/\(\?<[A-Za-z_]\w*>/.test(pattern)) {
    return { ok: false, error: 'pattern must contain at least one named capture group, e.g. (?<message>.*)' };
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    return { ok: false, error: `invalid regular expression: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, spec: { name: name.trim(), pattern } };
}

function normalize(raw: Partial<Config>): Config {
  const dir = typeof raw.cacheDir === 'string' && raw.cacheDir.trim() ? raw.cacheDir.trim() : DEFAULT_CACHE_DIR;
  const days =
    typeof raw.cacheRetentionDays === 'number' && Number.isFinite(raw.cacheRetentionDays) && raw.cacheRetentionDays >= 0
      ? Math.floor(raw.cacheRetentionDays)
      : DEFAULT_RETENTION_DAYS;
  // keep only valid specs; last one wins on duplicate names
  const byName = new Map<string, CustomParserSpec>();
  if (Array.isArray(raw.parsers)) {
    for (const p of raw.parsers) {
      const v = validateParser(p);
      if (v.ok) byName.set(v.spec.name, v.spec);
    }
  }
  return { cacheDir: dir, cacheRetentionDays: days, parsers: [...byName.values()] };
}

export function getConfig(): Config {
  if (cached) return cached;
  let raw: Partial<Config> = {};
  try {
    raw = JSON.parse(readFileSync(configFile(), 'utf8')) as Partial<Config>;
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
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configFile(), JSON.stringify(next, null, 2));
  } catch {
    // best effort — keep the in-memory value even if persisting fails
  }
  return next;
}

/** Add or replace a custom parser (by name) and persist. Throws on an invalid spec. */
export function addParser(spec: CustomParserSpec): Config {
  const v = validateParser(spec);
  if (!v.ok) throw new Error(v.error);
  const parsers = getConfig().parsers.filter((p) => p.name !== v.spec.name);
  parsers.push(v.spec);
  return setConfig({ parsers });
}

/** Remove a custom parser by name and persist. Returns true if one was removed. */
export function removeParser(name: string): boolean {
  const before = getConfig().parsers;
  const parsers = before.filter((p) => p.name !== name);
  if (parsers.length === before.length) return false;
  setConfig({ parsers });
  return true;
}

/**
 * A stable signature of the active custom parsers, folded into a session's index
 * fingerprint so that adding/editing/removing a parser invalidates cached indexes
 * (they were built with the old parser set and must be rebuilt to re-extract fields).
 */
export function parsersSignature(): string {
  const parsers = getConfig().parsers;
  if (parsers.length === 0) return '';
  return parsers
    .map((p) => `${p.name}=${p.pattern}`)
    .sort()
    .join('');
}
