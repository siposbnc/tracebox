/**
 * TraceBox query language.
 *
 *   error                      full-text term (FTS5 prefix match)
 *   "connection failed"        full-text phrase
 *   level:error                field equality (case-insensitive)
 *   status:>=500               numeric / lexicographic comparison
 *   timestamp:>2024-01-01      time comparison (eq matches the whole day/minute/…)
 *   path:/api/*                wildcard match
 *   msg:~time.*out             regular-expression match on the field value
 *   /timeout\d+/               regular-expression match on the whole line text
 *   user:*                     field-exists
 *   a AND b, a OR b, NOT a     boolean operators (implicit AND between terms)
 *   (a OR b) AND c             grouping
 */

export type CmpOp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte';

export type QueryNode =
  | { type: 'and'; children: QueryNode[] }
  | { type: 'or'; children: QueryNode[] }
  | { type: 'not'; child: QueryNode }
  | { type: 'text'; value: string; phrase: boolean }
  | { type: 'field'; field: string; op: CmpOp; value: string }
  | { type: 'fieldLike'; field: string; pattern: string }
  | { type: 'fieldRegex'; field: string; pattern: string }
  | { type: 'regex'; pattern: string; flags: string }
  | { type: 'exists'; field: string }
  | { type: 'all' };

export class QuerySyntaxError extends Error {}

// ---------------------------------------------------------------------------
// Tokenizer

type Token =
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'word'; value: string }
  | { kind: 'quoted'; value: string }
  | { kind: 'regex'; pattern: string; flags: string };

/** Valid JavaScript RegExp flag letters, used to bound a `/regex/flags` literal. */
const REGEX_FLAGS = 'dgimsuvy';

/**
 * Try to read a `/pattern/flags` regex literal starting at `s[start] === '/'`.
 * Returns null (so it falls back to a normal word) unless the literal closes
 * cleanly and is followed by a separator or end-of-input — so a bare path like
 * `/var/log/app` stays a plain term rather than becoming a regex.
 */
function scanRegexLiteral(s: string, start: number): { pattern: string; flags: string; next: number } | null {
  let j = start + 1;
  let pattern = '';
  let closed = false;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < s.length) {
      pattern += ch + s[j + 1]; // keep the escape verbatim (e.g. \/ or \d)
      j += 2;
    } else if (ch === '/') {
      closed = true;
      j++;
      break;
    } else if (ch === '\n' || ch === '\r') {
      return null;
    } else {
      pattern += ch;
      j++;
    }
  }
  if (!closed || pattern === '') return null;
  let flags = '';
  while (j < s.length && REGEX_FLAGS.includes(s[j])) {
    flags += s[j];
    j++;
  }
  const after = s[j];
  if (after !== undefined && !' \t\n\r()'.includes(after)) return null;
  return { pattern, flags, next: j };
}

function scanWord(s: string, start: number): { value: string; next: number } {
  let j = start;
  let value = '';
  while (j < s.length && !' \t\n\r()'.includes(s[j])) {
    if (s[j] === '"') break; // allow field:"phrase" — stop the word at a quote
    value += s[j];
    j++;
  }
  return { value, next: j };
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
    } else if (c === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < n && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < n) {
          value += input[j + 1];
          j += 2;
        } else {
          value += input[j];
          j++;
        }
      }
      if (j >= n) throw new QuerySyntaxError('Unterminated quoted string');
      tokens.push({ kind: 'quoted', value });
      i = j + 1;
    } else if (c === '/') {
      // a `/pattern/` whole-line regex literal, or — if it doesn't close cleanly
      // — an ordinary word that happens to start with a slash
      const rx = scanRegexLiteral(input, i);
      if (rx) {
        tokens.push({ kind: 'regex', pattern: rx.pattern, flags: rx.flags });
        i = rx.next;
      } else {
        const w = scanWord(input, i);
        tokens.push({ kind: 'word', value: w.value });
        i = w.next;
      }
    } else {
      const w = scanWord(input, i);
      tokens.push({ kind: 'word', value: w.value });
      i = w.next;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): QueryNode {
    if (this.tokens.length === 0) return { type: 'all' };
    const node = this.orExpr();
    if (this.pos < this.tokens.length) {
      throw new QuerySyntaxError(`Unexpected token near position ${this.pos}`);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isWord(value: string): boolean {
    const t = this.peek();
    return t?.kind === 'word' && t.value.toUpperCase() === value;
  }

  private orExpr(): QueryNode {
    const children = [this.andExpr()];
    while (this.isWord('OR')) {
      this.pos++;
      children.push(this.andExpr());
    }
    return children.length === 1 ? children[0] : { type: 'or', children };
  }

  private andExpr(): QueryNode {
    const children = [this.unary()];
    for (;;) {
      if (this.isWord('AND')) {
        this.pos++;
        children.push(this.unary());
      } else {
        const t = this.peek();
        if (t === undefined || t.kind === 'rparen' || this.isWord('OR')) break;
        children.push(this.unary()); // implicit AND
      }
    }
    return children.length === 1 ? children[0] : { type: 'and', children };
  }

  private unary(): QueryNode {
    if (this.isWord('NOT')) {
      this.pos++;
      return { type: 'not', child: this.unary() };
    }
    const t = this.peek();
    if (t?.kind === 'word' && t.value.startsWith('-') && t.value.length > 1) {
      this.pos++;
      return { type: 'not', child: this.termFromWord(t.value.slice(1)) };
    }
    return this.primary();
  }

  private primary(): QueryNode {
    const t = this.peek();
    if (t === undefined) throw new QuerySyntaxError('Unexpected end of query');
    if (t.kind === 'lparen') {
      this.pos++;
      const node = this.orExpr();
      const close = this.peek();
      if (close?.kind !== 'rparen') throw new QuerySyntaxError('Missing closing parenthesis');
      this.pos++;
      return node;
    }
    if (t.kind === 'rparen') throw new QuerySyntaxError('Unexpected ")"');
    this.pos++;
    if (t.kind === 'quoted') return { type: 'text', value: t.value, phrase: true };
    if (t.kind === 'regex') return this.makeRegex(t.pattern, t.flags);
    return this.termFromWord(t.value);
  }

  /** A `/pattern/flags` whole-line regex, validated up front so a bad pattern is a syntax error. */
  private makeRegex(pattern: string, flags: string): QueryNode {
    try {
      new RegExp(pattern, flags || undefined);
    } catch (err) {
      throw new QuerySyntaxError(
        `Invalid regular expression /${pattern}/${flags}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { type: 'regex', pattern, flags };
  }

  /** A bare word: either `field:value`, `field:` followed by a quoted phrase, or a text term. */
  private termFromWord(word: string): QueryNode {
    const colon = word.indexOf(':');
    if (colon <= 0) {
      if (word === '') throw new QuerySyntaxError('Empty term');
      return { type: 'text', value: word, phrase: false };
    }

    const field = word.slice(0, colon);
    let rest = word.slice(colon + 1);

    // field:"quoted value" — quoting lets a value contain spaces; wildcards and
    // the field-exists shorthand still apply to the quoted text.
    if (rest === '') {
      const next = this.peek();
      if (next?.kind === 'quoted') {
        this.pos++;
        return this.fieldEq(field, next.value);
      }
      throw new QuerySyntaxError(`Missing value for field "${field}"`);
    }

    // field:~regex — regular-expression match against the field value. The
    // pattern may be quoted (`field:~"a (b)"`) to carry spaces, parens, or
    // quotes that the tokenizer would otherwise treat as query syntax.
    if (rest.startsWith('~')) {
      let pattern = rest.slice(1);
      if (pattern === '') {
        const next = this.peek();
        if (next?.kind !== 'quoted') {
          throw new QuerySyntaxError(`Missing regular expression for field "${field}"`);
        }
        this.pos++;
        pattern = next.value;
      }
      return this.fieldRegex(field, pattern);
    }

    let op: CmpOp = 'eq';
    if (rest.startsWith('>=')) {
      op = 'gte';
      rest = rest.slice(2);
    } else if (rest.startsWith('<=')) {
      op = 'lte';
      rest = rest.slice(2);
    } else if (rest.startsWith('>')) {
      op = 'gt';
      rest = rest.slice(1);
    } else if (rest.startsWith('<')) {
      op = 'lt';
      rest = rest.slice(1);
    } else if (rest.startsWith('=')) {
      rest = rest.slice(1);
    }

    if (rest === '') throw new QuerySyntaxError(`Missing value for field "${field}"`);

    if (op === 'eq') return this.fieldEq(field, rest);
    return { type: 'field', field, op, value: rest };
  }

  /** An `eq` field predicate, routing `*` to exists and `*`-bearing values to a LIKE match. */
  private fieldEq(field: string, value: string): QueryNode {
    if (value === '*') return { type: 'exists', field };
    if (value.includes('*')) return { type: 'fieldLike', field, pattern: value };
    return { type: 'field', field, op: 'eq', value };
  }

  /** A regex field predicate, validating the pattern up front so errors surface as syntax errors. */
  private fieldRegex(field: string, pattern: string): QueryNode {
    if (pattern === '') throw new QuerySyntaxError(`Missing regular expression for field "${field}"`);
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new QuerySyntaxError(
        `Invalid regular expression for field "${field}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { type: 'fieldRegex', field, pattern };
  }
}

export function parseQuery(input: string): QueryNode {
  return new Parser(tokenize(input)).parse();
}
