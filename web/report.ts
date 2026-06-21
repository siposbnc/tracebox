/**
 * Build a shareable report (Markdown or HTML) from a file's annotations — the
 * bookmarked and/or noted lines — for pasting into an incident ticket.
 */

export interface ReportMeta {
  file: string;
  lineCount: number;
  query: string | null;
  generatedAt: number;
}

export interface ReportEntry {
  lineNo: number;
  /** 1 = bookmarked, has a note, or both. */
  bookmarked: boolean;
  note: string;
  text: string;
  ts: number | null;
  level: string | null;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function tsLabel(ts: number | null): string {
  return ts === null ? '' : new Date(ts).toISOString().replace('T', ' ').replace('Z', '');
}

/** A Markdown report: a header block plus one section per annotated line. */
export function buildMarkdown(meta: ReportMeta, entries: ReportEntry[]): string {
  const out: string[] = [];
  out.push(`# TraceBox report — ${baseName(meta.file)}`);
  out.push('');
  out.push(`- **Source:** \`${meta.file}\``);
  out.push(`- **Lines:** ${meta.lineCount.toLocaleString()}`);
  if (meta.query) out.push(`- **Filter:** \`${meta.query}\``);
  out.push(`- **Generated:** ${new Date(meta.generatedAt).toISOString()}`);
  out.push(`- **Annotations:** ${entries.length}`);
  out.push('');
  out.push(`## Annotations`);
  out.push('');

  for (const e of entries) {
    const tags = [`Line ${(e.lineNo + 1).toLocaleString()}`];
    if (e.ts !== null) tags.push(tsLabel(e.ts));
    if (e.level) tags.push(e.level);
    if (e.bookmarked) tags.push('🔖');
    out.push(`### ${tags.join(' · ')}`);
    out.push('');
    out.push('```');
    out.push(e.text);
    out.push('```');
    if (e.note.trim()) {
      out.push('');
      for (const line of e.note.split('\n')) out.push(`> ${line}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/**
 * Inline Markdown on already-escaped text: code, bold, italic, links. Splits on
 * backtick code spans first so bold/italic formatting never reaches inside a
 * `code` span (and there are no placeholder sentinels to collide with the text).
 */
function mdInline(escaped: string): string {
  return escaped
    .split(/(`[^`]+`)/g)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 1
        ? `<code>${part.slice(1, -1)}</code>`
        : part
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\b_([^_]+)_\b/g, '<em>$1</em>')
            .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>'),
    )
    .join('');
}

/**
 * Minimal, dependency-free Markdown → HTML so notes render formatting (bold,
 * lists, code, …) in the HTML export. Escapes before formatting.
 */
export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const blockStart = /^(?:```|#{1,6}\s|>\s?|\s*[-*+]\s+|\s*\d+\.\s+)/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if (/^(#{1,6})\s+/.test(line)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(line)!;
      out.push(`<h${m[1].length}>${mdInline(esc(m[2]))}</h${m[1].length}>`);
      i++;
    } else if (/^>\s?/.test(line)) {
      const q: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${q.map((l) => mdInline(esc(l))).join('<br>')}</blockquote>`);
    } else if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && /^\s*[-*+]\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
      out.push(`<ul>${items.map((it) => `<li>${mdInline(esc(it))}</li>`).join('')}</ul>`);
    } else if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && /^\s*\d+\.\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
      out.push(`<ol>${items.map((it) => `<li>${mdInline(esc(it))}</li>`).join('')}</ol>`);
    } else if (line.trim() === '') {
      i++;
    } else {
      const buf: string[] = [];
      for (; i < lines.length && lines[i].trim() !== '' && !blockStart.test(lines[i]); i++) buf.push(lines[i]);
      out.push(`<p>${buf.map((l) => mdInline(esc(l))).join('<br>')}</p>`);
    }
  }
  return out.join('\n');
}

/** A standalone, self-styled HTML report (dark theme, no external assets). */
export function buildHtml(meta: ReportMeta, entries: ReportEntry[]): string {
  const rows = entries
    .map((e) => {
      const tags = [`Line ${(e.lineNo + 1).toLocaleString()}`];
      if (e.ts !== null) tags.push(tsLabel(e.ts));
      if (e.level) tags.push(`<span class="lvl">${esc(e.level)}</span>`);
      if (e.bookmarked) tags.push('🔖');
      const note = e.note.trim() ? `<div class="note">${mdToHtml(e.note)}</div>` : '';
      return `<section><h3>${tags.join(' · ')}</h3><pre>${esc(e.text)}</pre>${note}</section>`;
    })
    .join('\n');

  const head = [
    `<p><b>Source:</b> <code>${esc(meta.file)}</code></p>`,
    `<p><b>Lines:</b> ${meta.lineCount.toLocaleString()}</p>`,
    meta.query ? `<p><b>Filter:</b> <code>${esc(meta.query)}</code></p>` : '',
    `<p><b>Generated:</b> ${new Date(meta.generatedAt).toISOString()}</p>`,
    `<p><b>Annotations:</b> ${entries.length}</p>`,
  ]
    .filter(Boolean)
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>TraceBox report — ${esc(baseName(meta.file))}</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0b1018; color:#d8dee9; font:14px/1.5 system-ui,sans-serif; max-width:900px; margin:2rem auto; padding:0 1rem; }
  h1 { color:#7dd3fc; font-size:1.4rem; }
  h3 { color:#9ca3af; font-size:.85rem; font-weight:600; margin:1.5rem 0 .4rem; border-top:1px solid #1f2937; padding-top:1rem; }
  .lvl { color:#fca5a5; font-weight:700; }
  pre { background:#0f1623; border:1px solid #1f2937; border-radius:6px; padding:.6rem .8rem; overflow:auto; font:12px/1.5 ui-monospace,monospace; white-space:pre-wrap; word-break:break-all; }
  blockquote { margin:.5rem 0 0; border-left:3px solid #b45309; padding:.2rem .8rem; color:#fcd34d; }
  .note { margin:.5rem 0 0; border-left:3px solid #b45309; padding:.1rem .8rem; color:#fcd34d; }
  .note p { margin:.3rem 0; } .note ul, .note ol { margin:.3rem 0; padding-left:1.2rem; }
  .note pre { color:#d8dee9; } .note a { color:#7dd3fc; }
  code { background:#0f1623; padding:.1rem .3rem; border-radius:4px; }
  header p { margin:.2rem 0; color:#9ca3af; }
</style></head>
<body>
<h1>TraceBox report — ${esc(baseName(meta.file))}</h1>
<header>${head}</header>
${rows}
</body></html>`;
}
