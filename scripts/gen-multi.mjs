// Generates a set of synthetic "service" log files that share a time window, for
// exercising the merged timeline (and grouping / columnar / faceting / clustering).
//
//   node scripts/gen-multi.mjs [outDir] [scale]
//
// Each file is a different service in a different format, with overlapping
// timestamps over ~2024-01-01 00:00–01:00 UTC, so the merged timeline interleaves
// them. `scale` multiplies the per-file line counts (default 1).
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';

const [, , outDir = 'testlogs', scaleArg = '1'] = process.argv;
const scale = Math.max(0.01, Number(scaleArg) || 1);
mkdirSync(outDir, { recursive: true });

let rngState = 0x9e3779b9;
function rnd() {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 0xffffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BASE = Date.UTC(2024, 0, 1, 0, 0, 0);

const HOSTS = ['web-01', 'web-02', 'web-03', 'worker-01', 'worker-02'];
const PATHS = ['/api/users', '/api/orders', '/api/items', '/health', '/api/cart', '/login', '/api/search'];

function writeFileLines(name, count, makeLine) {
  const file = path.join(outDir, name);
  const out = createWriteStream(file);
  let clock = BASE;
  let lines = 0;
  for (let i = 0; i < count; i++) {
    clock += Math.floor(rnd() * 2400); // 0–2.4s between records
    const emitted = makeLine(i, new Date(clock));
    for (const l of Array.isArray(emitted) ? emitted : [emitted]) {
      out.write(l + '\n');
      lines++;
    }
  }
  out.end();
  return new Promise((resolve) => out.on('finish', () => resolve({ name, lines })));
}

// Java-ish stack trace appended after an ERROR (tests multi-line grouping)
function javaTrace() {
  return [
    'java.lang.NullPointerException: session token was null',
    '\tat com.app.AuthService.verify(AuthService.java:88)',
    '\tat com.app.SecurityFilter.doFilter(SecurityFilter.java:42)',
    '\tat com.app.RequestHandler.handle(RequestHandler.java:120)',
    'Caused by: java.lang.IllegalStateException: token cache unavailable',
    '\tat com.app.TokenCache.get(TokenCache.java:31)',
    '\t... 14 more',
  ];
}

// Python traceback appended after an ERROR
function pyTrace() {
  return [
    'Traceback (most recent call last):',
    '  File "/srv/worker/runner.py", line 142, in run',
    '    result = self.process(job)',
    '  File "/srv/worker/runner.py", line 198, in process',
    '    raise RuntimeError("downstream refused connection")',
    'RuntimeError: downstream refused connection',
  ];
}

const jobs = [
  // 1) auth service — classic timestamped app log, with stack traces on errors
  writeFileLines('auth.log', Math.round(3000 * scale), (i, d) => {
    const iso = d.toISOString();
    const r = rnd();
    const level = r < 0.04 ? 'ERROR' : r < 0.12 ? 'WARN' : r < 0.16 ? 'DEBUG' : 'INFO';
    const head = `${iso.slice(0, 10)} ${iso.slice(11, 23)} [${level}] auth.${pick(HOSTS)} - ${
      level === 'ERROR' ? 'token verification failed' : 'user authentication succeeded'
    } request_id=${1000 + i} user=u${Math.floor(rnd() * 500)} duration=${Math.floor(rnd() * 800)}ms`;
    return level === 'ERROR' ? [head, ...javaTrace()] : head;
  }),

  // 2) gateway — JSON lines with nested http fields (tests columnar / faceting)
  writeFileLines('gateway.jsonl', Math.round(3500 * scale), (i, d) => {
    const r = rnd();
    const status = r < 0.05 ? 503 : r < 0.12 ? 404 : r < 0.16 ? 500 : 200;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    return JSON.stringify({
      timestamp: d.toISOString(),
      level,
      message: status >= 500 ? 'upstream request failed' : 'request completed',
      service: 'gateway',
      host: pick(HOSTS),
      http: { method: pick(['GET', 'POST', 'PUT']), status, path: pick(PATHS) },
      duration_ms: Math.floor(rnd() * 2000),
      request_id: 5000 + i,
    });
  }),

  // 3) nginx access log (CLF)
  writeFileLines('access.log', Math.round(4000 * scale), (_, d) => {
    const iso = d.toISOString();
    const clf = `${String(d.getUTCDate()).padStart(2, '0')}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}:${iso.slice(11, 19)} +0000`;
    const status = rnd() < 0.04 ? 502 : rnd() < 0.12 ? 404 : 200;
    return `10.0.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)} - ${
      rnd() < 0.3 ? 'alice' : '-'
    } [${clf}] "${pick(['GET', 'POST'])} ${pick(PATHS)} HTTP/1.1" ${status} ${Math.floor(rnd() * 50000)} "-" "curl/8.0"`;
  }),

  // 4) worker — Python logging with tracebacks on errors
  writeFileLines('worker.log', Math.round(1500 * scale), (i, d) => {
    const r = rnd();
    const level = r < 0.06 ? 'ERROR' : r < 0.14 ? 'WARNING' : 'INFO';
    const iso = d.toISOString();
    const head = `${iso.slice(0, 10)} ${iso.slice(11, 19)} ${level}:worker:job ${2000 + i} ${
      level === 'ERROR' ? 'failed' : 'completed'
    } host=${pick(HOSTS)}`;
    return level === 'ERROR' ? [head, ...pyTrace()] : head;
  }),
];

const results = await Promise.all(jobs);
for (const r of results) console.log(`  ${r.name.padEnd(16)} ${r.lines.toLocaleString()} lines`);
console.log(`Wrote ${results.length} files into ${path.resolve(outDir)}/`);
