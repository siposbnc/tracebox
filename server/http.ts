import { type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  query: URLSearchParams,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pathPattern: string, handler: Handler): void {
    const paramNames: string[] = [];
    const regexStr = pathPattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          paramNames.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler });
  }

  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      try {
        await route.handler(req, res, params, url.searchParams);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        } else {
          res.end();
        }
      }
      return true;
    }
    return false;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 1 << 20): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// ---------------------------------------------------------------------------
// Static file serving (the built web UI)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
};

export function serveStatic(rootDir: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(rootDir, rel);
  // prevent path traversal out of the web root
  if (!full.startsWith(path.resolve(rootDir))) {
    res.writeHead(403).end();
    return;
  }
  let target = full;
  if (!existsSync(target) || !statSync(target).isFile()) {
    target = path.join(rootDir, 'index.html'); // SPA fallback
    if (!existsSync(target)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('TraceBox UI is not built. Run: npm run build');
      return;
    }
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=86400',
  });
  createReadStream(target).pipe(res);
}

// ---------------------------------------------------------------------------
// Server-sent events

export class SseConnection {
  private alive = true;
  private heartbeat: NodeJS.Timeout;
  private readonly res: ServerResponse;

  constructor(res: ServerResponse) {
    this.res = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(':ok\n\n');
    this.heartbeat = setInterval(() => this.raw(':hb\n\n'), 15_000);
    res.on('close', () => this.dispose());
  }

  send(event: string, data: unknown): void {
    this.raw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private raw(text: string): void {
    if (!this.alive) return;
    try {
      this.res.write(text);
    } catch {
      this.dispose();
    }
  }

  get closed(): boolean {
    return !this.alive;
  }

  onClose(fn: () => void): void {
    this.res.on('close', fn);
  }

  private dispose(): void {
    this.alive = false;
    clearInterval(this.heartbeat);
  }
}
