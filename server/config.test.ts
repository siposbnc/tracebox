import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getConfig } from './config.ts';

// isolate the config to a temp dir (configDir reads TRACEBOX_CONFIG_DIR live)
const cfgDir = mkdtempSync(path.join(tmpdir(), 'tracebox-cfg-'));
process.env.TRACEBOX_CONFIG_DIR = cfgDir;
after(() => rmSync(cfgDir, { recursive: true, force: true }));

test('getConfig reflects config-file changes made by another process', () => {
  // no file yet → defaults, no custom parsers
  assert.equal(getConfig().parsers.length, 0);

  const file = path.join(cfgDir, 'config.json');
  const writeAt = (parsers: { name: string; pattern: string }[], mtimeSec: number): void => {
    writeFileSync(file, JSON.stringify({ parsers }, null, 2));
    const t = new Date(mtimeSec * 1000); // force a distinct mtime so the change is unambiguous
    utimesSync(file, t, t);
  };

  // a separate process (the MCP server) adds a parser — getConfig picks it up,
  // no restart needed (regression: the in-memory cache used to be permanent)
  writeAt([{ name: 'one', pattern: '^(?<message>.*)$' }], 1_000_000);
  assert.deepEqual(getConfig().parsers.map((p) => p.name), ['one']);

  // a later edit on disk is reflected too
  writeAt(
    [
      { name: 'one', pattern: '^(?<message>.*)$' },
      { name: 'two', pattern: '^(?<x>\\d+)$' },
    ],
    2_000_000,
  );
  assert.deepEqual(getConfig().parsers.map((p) => p.name), ['one', 'two']);
});
