/**
 * Render an investigation report (Markdown) from an agent's findings: a title, a
 * summary, and ordered sections of narrative plus *authoritative* evidence — log
 * lines pulled from the index by line number, so quoted lines are the real thing
 * rather than paraphrased. Drives the MCP `build_report` tool.
 *
 * Line numbers are 0-based internally (matching the engine) but rendered 1-based
 * to match what a reader sees in the UI.
 */

export interface ReportEvidence {
  /** 0-based line number, as stored. */
  lineNo: number;
  text: string;
  ts: number | null;
  level: string | null;
  truncated?: boolean;
}

export interface ReportSection {
  heading: string;
  /** Markdown narrative for this finding. */
  body: string;
  evidence: ReportEvidence[];
}

export interface ReportDoc {
  title: string;
  summary: string;
  source: { file: string; lineCount: number };
  generatedAt: number;
  sections: ReportSection[];
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** `2024-03-15 00:00:02.626` (UTC, no T/Z) — matches the UI's compact stamp. */
function tsLabel(ts: number | null): string {
  return ts === null ? '' : new Date(ts).toISOString().replace('T', ' ').replace('Z', '');
}

/** One evidence line: a caption (1-based line · timestamp · level) over a code block. */
function renderEvidence(e: ReportEvidence): string[] {
  const tags = [`Line ${(e.lineNo + 1).toLocaleString()}`];
  if (e.ts !== null) tags.push(tsLabel(e.ts));
  if (e.level) tags.push(e.level);
  const out = [`**${tags.join(' · ')}**`, '', '```', e.text, '```'];
  if (e.truncated) out.push('_(line truncated)_');
  return out;
}

/** A Markdown report: header block, summary, then one section per finding. */
export function renderReportMarkdown(doc: ReportDoc): string {
  const out: string[] = [];
  out.push(`# ${doc.title.trim() || 'TraceBox report'}`);
  out.push('');
  if (doc.summary.trim()) {
    out.push(doc.summary.trim());
    out.push('');
  }
  out.push(`- **Source:** \`${doc.source.file}\``);
  out.push(`- **Lines:** ${doc.source.lineCount.toLocaleString()}`);
  out.push(`- **Generated:** ${new Date(doc.generatedAt).toISOString()}`);
  out.push('');

  for (const section of doc.sections) {
    out.push('---');
    out.push('');
    out.push(`## ${section.heading.trim() || 'Finding'}`);
    out.push('');
    if (section.body.trim()) {
      out.push(section.body.trim());
      out.push('');
    }
    for (const e of section.evidence) {
      out.push(...renderEvidence(e));
      out.push('');
    }
  }
  // collapse a trailing blank
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
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
 * Minimal, dependency-free Markdown → HTML for report prose/notes: fenced code,
 * headings, ordered/unordered lists, blockquotes, paragraphs, and inline marks.
 * Everything is HTML-escaped before formatting is applied.
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
      i++; // closing fence
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

/**
 * A standalone, self-styled HTML report (dark theme, no external assets) — the
 * same look as the app's annotation export (`web/report.ts`), for a shareable file.
 */
export function renderReportHtml(doc: ReportDoc): string {
  const sections = doc.sections
    .map((section) => {
      const evidence = section.evidence
        .map((e) => {
          const tags = [`Line ${(e.lineNo + 1).toLocaleString()}`];
          if (e.ts !== null) tags.push(tsLabel(e.ts));
          if (e.level) tags.push(`<span class="lvl">${esc(e.level)}</span>`);
          const trunc = e.truncated ? '<div class="trunc">(line truncated)</div>' : '';
          return `<h3>${tags.join(' · ')}</h3><pre>${esc(e.text)}</pre>${trunc}`;
        })
        .join('\n');
      return `<section><h2>${esc(section.heading.trim() || 'Finding')}</h2>${
        section.body.trim() ? mdToHtml(section.body) : ''
      }${evidence}</section>`;
    })
    .join('\n');

  const head = [
    `<p><b>Source:</b> <code>${esc(doc.source.file)}</code></p>`,
    `<p><b>Lines:</b> ${doc.source.lineCount.toLocaleString()}</p>`,
    `<p><b>Generated:</b> ${new Date(doc.generatedAt).toISOString()}</p>`,
  ].join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(doc.title.trim() || 'TraceBox report')}</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0b1018; color:#d8dee9; font:14px/1.5 system-ui,sans-serif; max-width:900px; margin:2rem auto; padding:0 1rem; }
  h1 { color:#7dd3fc; font-size:1.5rem; }
  h2 { color:#e5e7eb; font-size:1.1rem; border-top:1px solid #1f2937; padding-top:1.2rem; margin-top:1.6rem; }
  h3 { color:#9ca3af; font-size:.8rem; font-weight:600; margin:1rem 0 .3rem; }
  .lvl { color:#fca5a5; font-weight:700; }
  .trunc { color:#6b7280; font-size:.75rem; }
  pre { background:#0f1623; border:1px solid #1f2937; border-radius:6px; padding:.6rem .8rem; overflow:auto; font:12px/1.5 ui-monospace,monospace; white-space:pre-wrap; word-break:break-all; }
  code { background:#0f1623; padding:.1rem .3rem; border-radius:4px; }
  header p { margin:.2rem 0; color:#9ca3af; }
</style></head>
<body>
<h1>${esc(doc.title.trim() || 'TraceBox report')}</h1>
${doc.summary.trim() ? mdToHtml(doc.summary) : ''}
<header>${head}</header>
${sections}
</body></html>
`;
}

export { baseName };
