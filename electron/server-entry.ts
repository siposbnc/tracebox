/**
 * Entry point for the TraceBox backend when running inside the Electron
 * desktop shell. Forked as an Electron utilityProcess: starts the HTTP app
 * on an ephemeral localhost port and reports the port to the main process.
 *
 * Bundled to dist-electron/server.cjs by esbuild (see scripts/build-electron.mjs).
 */
import { createApp } from '../server/app.ts';

const distDir = process.env.TRACEBOX_DIST;
if (!distDir) throw new Error('TRACEBOX_DIST not set');

// Electron utilityProcess exposes an IPC channel to the main process.
const parentPort = (process as unknown as { parentPort: ElectronParentPort }).parentPort;

interface ElectronParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
}

const app = createApp(distDir);

app.server.listen(0, '127.0.0.1', () => {
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  parentPort.postMessage({ type: 'ready', port });
});

app.server.on('error', (err) => {
  parentPort.postMessage({ type: 'error', message: err.message });
});

parentPort.on('message', (e) => {
  const msg = e.data as { type?: string };
  if (msg?.type === 'shutdown') {
    void app.shutdown().then(() => process.exit(0));
    // hard exit fallback if a session refuses to close quickly
    setTimeout(() => process.exit(0), 3000).unref();
  }
});
