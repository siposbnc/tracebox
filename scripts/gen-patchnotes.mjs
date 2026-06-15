// Generates web/patchnotes.ts from CHANGELOG.md so the in-app "What's new"
// view always matches the changelog. Released versions only (skips Unreleased).
// Run automatically by `npm run build` and `npm run dev`.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

const versions = [];
let cur = null; // current version
let section = null; // current section within the version
let item = null; // index of the current bullet (for wrapped continuation lines)

for (const raw of changelog.split(/\r?\n/)) {
  const line = raw.replace(/\s+$/, '');

  const versionHeader = line.match(/^##\s+\[([^\]]+)\](?:\s*-\s*(.+))?\s*$/);
  if (versionHeader) {
    section = null;
    item = null;
    const version = versionHeader[1].trim();
    if (version.toLowerCase() === 'unreleased') {
      cur = null; // users don't have unreleased work — leave it out
      continue;
    }
    cur = { version, date: versionHeader[2] ? versionHeader[2].trim() : null, sections: [] };
    versions.push(cur);
    continue;
  }

  if (!cur) continue;

  const sectionHeader = line.match(/^###\s+(.+?)\s*$/);
  if (sectionHeader) {
    section = { title: sectionHeader[1].trim(), items: [] };
    cur.sections.push(section);
    item = null;
    continue;
  }

  if (!section) continue;

  const bullet = line.match(/^-\s+(.+)$/);
  if (bullet) {
    section.items.push(bullet[1].trim());
    item = section.items.length - 1;
    continue;
  }

  // a wrapped continuation of the current bullet (indented, not a new bullet)
  if (item !== null && /^\s+\S/.test(raw) && !/^\s*-\s+/.test(raw)) {
    section.items[item] += ' ' + line.trim();
    continue;
  }

  if (line.trim() === '') item = null; // blank line ends the bullet
}

const out =
  `// AUTO-GENERATED from CHANGELOG.md by scripts/gen-patchnotes.mjs — do not edit.\n` +
  `import type { PatchNote } from './types';\n\n` +
  `export const patchNotes: PatchNote[] = ${JSON.stringify(versions, null, 2)};\n`;

writeFileSync(path.join(root, 'web', 'patchnotes.ts'), out);
console.log(`Wrote web/patchnotes.ts (${versions.length} version(s))`);
