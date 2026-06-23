import { useSyncExternalStore } from 'react';
import { clientStore } from './clientStore';

/**
 * Redaction: a display/export-only masking of sensitive values so an
 * investigation can be shared (screenshots, reports, exports) without leaking
 * secrets. Search and all backend logic keep running on the real, unmasked data
 * — only what's rendered or exported is masked. A master toggle, per-category
 * switches, and user-defined custom patterns are persisted globally.
 *
 * NOTE: the built-in category patterns are mirrored in `server/redaction.ts`,
 * which masks the streamed CSV/JSON export. Keep the two in sync.
 */

export type RedactCategory = 'secret' | 'jwt' | 'email' | 'ipv4' | 'ipv6' | 'card' | 'token';

export interface CategoryDef {
  id: RedactCategory;
  label: string;
  hint: string;
  apply: (text: string) => string;
}

export interface CustomPattern {
  id: string;
  label: string;
  pattern: string;
  enabled: boolean;
}

// ---- Built-in patterns (applied specific → general) ------------------------

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const IPV6 = /\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:(?:[0-9a-fA-F]{1,4}:?){0,5}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
// key=value / key: value secret pairs, plus `Bearer <token>`
const SECRET_KV =
  /\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth(?:orization)?|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?id)\b(\s*[:=]\s*"?)([^\s,;"']+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// long opaque strings that contain both a letter and a digit (api keys, hashes,
// session ids) — the catch-all, applied last so it doesn't eat structured values
const TOKEN = /\b(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{20,}\b/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Luhn check so credit-card masking doesn't catch arbitrary long digit runs. */
function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Built-in categories, in application order (specific first, catch-all last). */
export const CATEGORIES: CategoryDef[] = [
  {
    id: 'secret',
    label: 'Secrets',
    hint: 'password=…, token: …, Authorization, Bearer …',
    apply: (t) =>
      t.replace(SECRET_KV, (_m, k, sep) => `${k}${sep}[secret]`).replace(BEARER, 'Bearer [secret]'),
  },
  { id: 'jwt', label: 'JWTs', hint: 'eyJ… JSON web tokens', apply: (t) => t.replace(JWT, '[jwt]') },
  { id: 'email', label: 'Emails', hint: 'name@host.tld', apply: (t) => t.replace(EMAIL, '[email]') },
  { id: 'ipv4', label: 'IPv4', hint: '10.0.0.1', apply: (t) => t.replace(IPV4, '[ip]') },
  { id: 'ipv6', label: 'IPv6', hint: 'fe80::1', apply: (t) => t.replace(IPV6, '[ip]') },
  {
    id: 'card',
    label: 'Card numbers',
    hint: '13–19 digit numbers passing a Luhn check',
    apply: (t) => t.replace(CARD, (m) => (luhn(m.replace(/\D/g, '')) ? '[card]' : m)),
  },
  {
    id: 'token',
    label: 'Long tokens',
    hint: '20+ char keys/hashes with letters and digits',
    apply: (t) => t.replace(TOKEN, '[token]'),
  },
];

// ---- Persisted state -------------------------------------------------------

const ON_KEY = 'tracebox.redact';
const DISABLED_KEY = 'tracebox.redactDisabled';
const CUSTOM_KEY = 'tracebox.redactCustom';

function loadOn(): boolean {
  return clientStore.getItem(ON_KEY) === 'true';
}
function loadDisabled(): Set<RedactCategory> {
  try {
    const raw = clientStore.getItem(DISABLED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? (arr as RedactCategory[]) : []);
  } catch {
    return new Set();
  }
}
function loadCustom(): CustomPattern[] {
  try {
    const raw = clientStore.getItem(CUSTOM_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as CustomPattern[]) : [];
  } catch {
    return [];
  }
}

let on = loadOn();
let disabled = loadDisabled();
let custom = loadCustom();
let version = 0;

const listeners = new Set<() => void>();
function emit(): void {
  version++;
  rebuild();
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---- The compiled redactor -------------------------------------------------

const identity = (t: string): string => t;
let apply: (text: string) => string = identity;

function rebuild(): void {
  if (!on) {
    apply = identity;
    return;
  }
  const fns = CATEGORIES.filter((c) => !disabled.has(c.id)).map((c) => c.apply);
  for (const p of custom) {
    if (!p.enabled || p.pattern === '') continue;
    try {
      const re = new RegExp(p.pattern, 'g');
      const rep = `[${p.label.trim() || 'redacted'}]`;
      fns.push((t) => t.replace(re, rep));
    } catch {
      // invalid pattern — skip; the editor surfaces the error
    }
  }
  apply = fns.length === 0 ? identity : (text) => fns.reduce((t, f) => f(t), text);
}
rebuild();

// ---- Public API ------------------------------------------------------------

export function getRedactOn(): boolean {
  return on;
}
export function setRedactOn(next: boolean): void {
  if (next === on) return;
  on = next;
  clientStore.setItem(ON_KEY, String(next));
  emit();
}
export function useRedactOn(): boolean {
  return useSyncExternalStore(subscribe, getRedactOn);
}

export function isCategoryEnabled(id: RedactCategory): boolean {
  return !disabled.has(id);
}
export function setCategoryEnabled(id: RedactCategory, enabled: boolean): void {
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  disabled = new Set(disabled);
  clientStore.setItem(DISABLED_KEY, JSON.stringify([...disabled]));
  emit();
}

export function getCustomPatterns(): CustomPattern[] {
  return custom;
}
export function setCustomPatterns(next: CustomPattern[]): void {
  custom = next;
  clientStore.setItem(CUSTOM_KEY, JSON.stringify(next));
  emit();
}

/** Snapshot used by the config UI to re-render on any redaction change. */
export function useRedactionVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/**
 * The active masking function: identity when redaction is off, otherwise applies
 * every enabled built-in category and custom pattern. The returned function is
 * stable until the configuration changes (tracked via {@link useRedactionVersion}).
 */
export function getRedactor(): (text: string) => string {
  return apply;
}

/** React hook form: `{ on, redact }`. `redact` is identity while off. */
export function useRedactor(): { on: boolean; redact: (text: string) => string } {
  useRedactionVersion();
  return { on, redact: apply };
}

/**
 * Query-string fragment (leading `&`) describing the active redaction config for
 * the server-streamed export / copy endpoints, or '' when redaction is off. The
 * server mirrors this masking in `server/redaction.ts`.
 */
export function redactExportParams(): string {
  if (!on) return '';
  const parts = ['redact=1'];
  if (disabled.size > 0) parts.push(`rdisabled=${encodeURIComponent([...disabled].join(','))}`);
  const cust = custom
    .filter((c) => c.enabled && c.pattern !== '')
    .map((c) => ({ label: c.label, pattern: c.pattern }));
  if (cust.length > 0) parts.push(`rcustom=${encodeURIComponent(JSON.stringify(cust))}`);
  return `&${parts.join('&')}`;
}

/** Validate a custom pattern, returning an error message or null. */
export function validateCustomPattern(label: string, pattern: string): string | null {
  if (pattern === '') return 'Enter a regular expression';
  try {
    new RegExp(pattern, 'g');
  } catch (err) {
    return `Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (label.trim() !== '' && !/^[\w .-]{1,24}$/.test(label.trim())) return 'Label: up to 24 letters, digits, space, _ . -';
  return null;
}
