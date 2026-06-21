import { McpServer, parseMessage, PARSE_ERROR } from './mcp.ts';
import { getConfig } from './config.ts';

/**
 * stdio entry for the TraceBox MCP server. Reads newline-delimited JSON-RPC
 * messages from stdin and writes responses to stdout, one JSON object per line;
 * all diagnostics go to stderr so stdout carries only protocol traffic.
 *
 *   node server/mcp-main.ts --allow
 *
 * Configure it in an MCP client (e.g. Claude Code) as a stdio command. It holds
 * no network sockets — TraceBox's offline guarantee is preserved.
 *
 * Opt-in gate: driving TraceBox from an agent only runs when the user has
 * enabled it (Settings → MCP server, persisted as `mcpEnabled` in the config).
 * `--allow` bypasses the gate for development (`npm run mcp`).
 */

// Refuse to serve unless the user opted in (or a developer passed --allow), so a
// packaged install never exposes the toolkit until it's explicitly turned on.
if (!process.argv.includes('--allow') && !getConfig().mcpEnabled) {
  process.stderr.write(
    '[tracebox-mcp] The MCP server is disabled. Enable it in TraceBox → Settings → MCP server,\n' +
      '[tracebox-mcp] or run with --allow for development.\n',
  );
  process.exit(0);
}

const server = new McpServer();

function send(obj: object): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function log(msg: string): void {
  process.stderr.write(`[tracebox-mcp] ${msg}\n`);
}

let buffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl: number;
  // process every complete line; keep any trailing partial in the buffer
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === '') continue;
    void dispatch(line);
  }
});

async function dispatch(line: string): Promise<void> {
  let msg;
  try {
    msg = parseMessage(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
    return;
  }
  try {
    const response = await server.handle(msg);
    if (response) send(response);
  } catch (err) {
    log(`handler error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function shutdown(): Promise<void> {
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}

// stdin closing (client disconnected) or a signal ends the server
process.stdin.on('end', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

log('ready (stdio)');
