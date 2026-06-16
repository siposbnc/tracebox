/**
 * Entry point for the TraceBox backend when running inside the Electron
 * desktop shell. Forked as an Electron utilityProcess: starts the HTTP app
 * on a stable localhost port and reports the port to the main process.
 *
 * The port is fixed (not ephemeral) so the window's origin
 * (`http://127.0.0.1:<port>`) stays constant across launches — browser
 * localStorage is keyed by origin, so a changing port would reset all
 * client-side state (workspaces, bookmarks, notes, settings) every launch.
 * If the preferred port is busy we fall back to an ephemeral one.
 *
 * Bundled to dist-electron/server.cjs by esbuild (see scripts/build-electron.mjs).
 */
import { createApp } from '../server/app.ts';

// distinct from the web app's 7077 so the two can run side by side
const PREFERRED_PORT = 7177;

const distDir = process.env.TRACEBOX_DIST;
if (!distDir) throw new Error('TRACEBOX_DIST not set');

// Electron utilityProcess exposes an IPC channel to the main process.
const parentPort = (process as unknown as { parentPort: ElectronParentPort }).parentPort;

interface ElectronParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
}

const app = createApp(distDir);

const onListen = (): void => {
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  parentPort.postMessage({ type: 'ready', port });
};

let triedFallback = false;
app.server.on('error', (err: NodeJS.ErrnoException) => {
  // preferred port busy (e.g. a second instance, or the dev server): fall back
  // to an ephemeral one once. State won't persist for that session, but the app runs.
  if (!triedFallback && err.code === 'EADDRINUSE') {
    triedFallback = true;
    app.server.listen(0, '127.0.0.1', onListen);
    return;
  }
  parentPort.postMessage({ type: 'error', message: err.message });
});

app.server.listen(PREFERRED_PORT, '127.0.0.1', onListen);

parentPort.on('message', (e) => {
  const msg = e.data as { type?: string };
  if (msg?.type === 'shutdown') {
    void app.shutdown().then(() => process.exit(0));
    // hard exit fallback if a session refuses to close quickly
    setTimeout(() => process.exit(0), 3000).unref();
  }
});
