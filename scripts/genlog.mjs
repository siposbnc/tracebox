// Generates a synthetic log file for testing TraceBox with large inputs.
//
//   node scripts/genlog.mjs out.log 500mb [json|app|access]
//
import { createWriteStream } from 'node:fs';

const [, , outFile = 'test.log', sizeArg = '100mb', format = 'app'] = process.argv;

const m = /^(\d+(?:\.\d+)?)(kb|mb|gb)?$/i.exec(sizeArg);
if (!m) {
  console.error('Size must look like 500mb, 2gb, 100kb');
  process.exit(1);
}
const mult = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] ?? 'mb').toLowerCase()];
const targetBytes = Math.round(Number(m[1]) * mult);

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];
const SERVICES = ['auth', 'payments', 'gateway', 'catalog', 'orders', 'email', 'search'];
const HOSTS = ['web-01', 'web-02', 'worker-01', 'worker-02', 'db-proxy'];
const PATHS = ['/api/users', '/api/orders', '/api/items', '/health', '/api/cart', '/login', '/api/search'];
const MESSAGES = [
  'request completed',
  'cache miss for key session',
  'connection pool exhausted, retrying',
  'slow query detected',
  'payment provider timeout',
  'user authentication succeeded',
  'background job finished',
  'disk usage above threshold',
  'connection failed to upstream',
  'rate limit applied',
];

let rngState = 0x12345678;
function rnd() {
  // xorshift32 — deterministic output for reproducible test files
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 0xffffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

let ts = Date.UTC(2024, 0, 1);
function nextTs() {
  ts += Math.floor(rnd() * 200);
  return new Date(ts);
}

function makeLine(i) {
  const d = nextTs();
  const level = pick(LEVELS);
  const iso = d.toISOString();
  switch (format) {
    case 'json':
      return JSON.stringify({
        timestamp: iso,
        level: level.toLowerCase(),
        message: `${pick(MESSAGES)} (#${i})`,
        service: pick(SERVICES),
        host: pick(HOSTS),
        http: { status: rnd() < 0.05 ? 503 : rnd() < 0.1 ? 404 : 200, path: pick(PATHS) },
        duration_ms: Math.floor(rnd() * 2000),
      });
    case 'access': {
      const clf = `${String(d.getUTCDate()).padStart(2, '0')}/${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}/${d.getUTCFullYear()}:${iso.slice(11, 19)} +0000`;
      const status = rnd() < 0.05 ? 500 + Math.floor(rnd() * 4) : rnd() < 0.15 ? 404 : 200;
      return `10.0.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)} - ${rnd() < 0.3 ? 'alice' : '-'} [${clf}] "GET ${pick(PATHS)} HTTP/1.1" ${status} ${Math.floor(rnd() * 50000)}`;
    }
    default:
      return `${iso.slice(0, 10)} ${iso.slice(11, 23)} [${level}] ${pick(SERVICES)}.${pick(HOSTS)} - ${pick(MESSAGES)} request_id=${i} duration=${Math.floor(rnd() * 2000)}ms`;
  }
}

const out = createWriteStream(outFile);
let written = 0;
let lines = 0;
const t0 = Date.now();

function writeMore() {
  while (written < targetBytes) {
    let chunk = '';
    for (let i = 0; i < 5000 && written < targetBytes; i++) {
      const line = makeLine(lines++) + '\n';
      chunk += line;
      written += Buffer.byteLength(line);
    }
    if (!out.write(chunk)) {
      out.once('drain', writeMore);
      return;
    }
  }
  out.end(() => {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Wrote ${outFile}: ${(written / 1024 / 1024).toFixed(1)} MB, ${lines.toLocaleString()} lines in ${secs}s`);
  });
}
writeMore();
