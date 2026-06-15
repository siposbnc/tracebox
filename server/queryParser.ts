/**
 * TraceBox query language.
 *
 *   error                      full-text term (FTS5 prefix match)
 *   "connection failed"        full-text phrase
 *   level:error                field equality (case-insensitive)
 *   status:>=500               numeric / lexicographic comparison
 *   timestamp:>2024-01-01      time comparison (eq matches the whole day/minute/…)
 *   path:/api/*                wildcard match
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
  | { type: 'exists'; field: string }
  | { type: 'all' };

export class QuerySyntaxError extends Error {}

// ---------------------------------------------------------------------------
// Tokenizer

type Token =
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'word'; value: string }
  | { kind: 'quoted'; value: string };

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
    } else {
      let j = i;
      let value = '';
      while (j < n && !' \t\n\r()'.includes(input[j])) {
        // allow field:"phrase" — stop the word at a quote after a colon
        if (input[j] === '"') break;
        value += input[j];
        j++;
      }
      tokens.push({ kind: 'word', value });
      i = j;
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
    return this.termFromWord(t.value);
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
}

export function parseQuery(input: string): QueryNode {
  return new Parser(tokenize(input)).parse();
}
