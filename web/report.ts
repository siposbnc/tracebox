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

/** A standalone, self-styled HTML report (dark theme, no external assets). */
export function buildHtml(meta: ReportMeta, entries: ReportEntry[]): string {
  const rows = entries
    .map((e) => {
      const tags = [`Line ${(e.lineNo + 1).toLocaleString()}`];
      if (e.ts !== null) tags.push(tsLabel(e.ts));
      if (e.level) tags.push(`<span class="lvl">${esc(e.level)}</span>`);
      if (e.bookmarked) tags.push('🔖');
      const note = e.note.trim() ? `<blockquote>${esc(e.note).replace(/\n/g, '<br>')}</blockquote>` : '';
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
  blockquote { margin:.5rem 0 0; border-left:3px solid #b45309; padding:.2rem .8rem; color:#fcd34d; white-space:pre-wrap; }
  code { background:#0f1623; padding:.1rem .3rem; border-radius:4px; }
  header p { margin:.2rem 0; color:#9ca3af; }
</style></head>
<body>
<h1>TraceBox report — ${esc(baseName(meta.file))}</h1>
<header>${head}</header>
${rows}
</body></html>`;
}
