/**
 * Server-side redaction for the streamed CSV/JSON export and the copy-to-clipboard
 * endpoint. The UI masks the on-screen view itself; this masks the bytes that
 * leave over those two server-streamed paths, using the same built-in patterns.
 *
 * NOTE: the built-in patterns mirror `web/redaction.ts`. Keep the two in sync.
 */

export interface RedactionConfig {
  /** Built-in category ids that are turned OFF. */
  disabled?: string[];
  /** User-defined patterns: a regex source and a label for the placeholder. */
  custom?: { label: string; pattern: string }[];
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const IPV6 = /\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:(?:[0-9a-fA-F]{1,4}:?){0,5}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_KV =
  /\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth(?:orization)?|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?id)\b(\s*[:=]\s*"?)([^\s,;"']+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const TOKEN = /\b(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{20,}\b/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

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

const CATEGORIES: { id: string; apply: (t: string) => string }[] = [
  {
    id: 'secret',
    apply: (t) => t.replace(SECRET_KV, (_m, k, sep) => `${k}${sep}[secret]`).replace(BEARER, 'Bearer [secret]'),
  },
  { id: 'jwt', apply: (t) => t.replace(JWT, '[jwt]') },
  { id: 'email', apply: (t) => t.replace(EMAIL, '[email]') },
  { id: 'ipv4', apply: (t) => t.replace(IPV4, '[ip]') },
  { id: 'ipv6', apply: (t) => t.replace(IPV6, '[ip]') },
  { id: 'card', apply: (t) => t.replace(CARD, (m) => (luhn(m.replace(/\D/g, '')) ? '[card]' : m)) },
  { id: 'token', apply: (t) => t.replace(TOKEN, '[token]') },
];

/** Build a masking function from a config. Returns identity when nothing applies. */
export function buildRedactor(cfg: RedactionConfig): (text: string) => string {
  const disabled = new Set(cfg.disabled ?? []);
  const fns = CATEGORIES.filter((c) => !disabled.has(c.id)).map((c) => c.apply);
  for (const p of cfg.custom ?? []) {
    if (!p.pattern) continue;
    try {
      const re = new RegExp(p.pattern, 'g');
      const rep = `[${p.label.trim() || 'redacted'}]`;
      fns.push((t) => t.replace(re, rep));
    } catch {
      // invalid pattern — skip
    }
  }
  return fns.length === 0 ? (t) => t : (text) => fns.reduce((t, f) => f(t), text);
}

/**
 * Build a redactor from request query params (`redact=1`, `rdisabled=email,token`,
 * `rcustom=<uri-encoded JSON>`), or null when redaction isn't requested.
 */
export function redactorFromQuery(query: URLSearchParams): ((text: string) => string) | null {
  if (query.get('redact') !== '1') return null;
  const disabled = (query.get('rdisabled') ?? '').split(',').filter(Boolean);
  let custom: { label: string; pattern: string }[] = [];
  const raw = query.get('rcustom');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) custom = parsed as { label: string; pattern: string }[];
    } catch {
      // ignore malformed custom config
    }
  }
  return buildRedactor({ disabled, custom });
}
