// Bundles the TypeScript backend into dist-electron/server.cjs for the
// Electron shell (Electron's bundled Node may not support type stripping,
// so the desktop build ships plain CommonJS).
import { build } from 'esbuild';

await build({
  entryPoints: ['electron/server-entry.ts'],
  outfile: 'dist-electron/server.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  logLevel: 'info',
});
