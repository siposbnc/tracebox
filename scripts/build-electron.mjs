// Bundles the TypeScript backend into dist-electron/ for the Electron shell
// (Electron's bundled Node may not support type stripping, so the desktop build
// ships plain CommonJS):
//   server.cjs — the HTTP backend, run in a utilityProcess by the desktop app.
//   mcp.cjs    — the opt-in stdio MCP server, launched on demand by an MCP client
//                via the app executable in ELECTRON_RUN_AS_NODE mode.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['electron/server-entry.ts'], outfile: 'dist-electron/server.cjs' });
await build({ ...common, entryPoints: ['server/mcp-main.ts'], outfile: 'dist-electron/mcp.cjs' });
