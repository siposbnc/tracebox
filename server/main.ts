import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
function argValue(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const PORT = Number(argValue('--port') ?? process.env.TRACEBOX_PORT ?? 7077);
const NO_OPEN = args.includes('--no-open');
const fileArg = args.find((a) => !a.startsWith('--') && a !== String(PORT));

const app = createApp(DIST);

app.server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  const hasUi = existsSync(path.join(DIST, 'index.html'));
  console.log(`\n  ▶ TraceBox running at ${url}\n`);
  if (!hasUi) {
    console.log('  ⚠ Web UI not built yet — run "npm run build" first (API is up).\n');
  }
  if (fileArg) {
    console.log(`  Opening ${fileArg} ...`);
    void fetch(`${url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fileArg }),
    }).catch(() => {});
  }
  if (!NO_OPEN && hasUi && process.env.NODE_ENV !== 'test') {
    const opener =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    try {
      spawn(opener[0] as string, opener[1] as string[], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // user can open the URL manually
    }
  }
});

process.on('SIGINT', () => {
  void app.shutdown().then(() => process.exit(0));
});
