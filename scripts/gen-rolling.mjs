// Generates daily-rolled log files (logrotate "dateext" style) for testing the
// merged timeline's timestamp stitching across files.
//
//   node scripts/gen-rolling.mjs [outDir] [days] [linesPerDay]
//
// For each of `days` consecutive days it writes one file per service, named
// <service>-YYYY-MM-DD.log, whose timestamps fall within that calendar day.
// Open several days together and the merged timeline stitches them in order;
// open the same day across services to see intra-day interleave.
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';

const [, , outDir = 'testlogs/rolling', daysArg = '5', linesArg = '1500'] = process.argv;
const days = Math.max(1, Number(daysArg) || 5);
const linesPerDay = Math.max(1, Number(linesArg) || 1500);
mkdirSync(outDir, { recursive: true });

const DAY_MS = 86_400_000;
const HOSTS = ['web-01', 'web-02', 'web-03', 'worker-01'];
const PATHS = ['/api/users', '/api/orders', '/api/items', '/health', '/api/cart', '/login'];
const MESSAGES = [
  'request completed',
  'cache miss for session',
  'connection pool exhausted',
  'slow query detected',
  'user authentication succeeded',
  'background job finished',
  'rate limit applied',
  'upstream request failed',
];

let rngState = 0x1a2b3c4d;
function rnd() {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 0xffffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const SERVICES = [
  {
    name: 'app',
    ext: 'log',
    line: (i, d) => {
      const iso = d.toISOString();
      const r = rnd();
      const level = r < 0.04 ? 'ERROR' : r < 0.12 ? 'WARN' : r < 0.16 ? 'DEBUG' : 'INFO';
      return `${iso.slice(0, 10)} ${iso.slice(11, 23)} [${level}] app.${pick(HOSTS)} - ${pick(
        MESSAGES,
      )} request_id=${i} duration=${Math.floor(rnd() * 1500)}ms`;
    },
  },
  {
    name: 'api',
    ext: 'jsonl',
    line: (i, d) => {
      const r = rnd();
      const status = r < 0.05 ? 503 : r < 0.12 ? 404 : 200;
      return JSON.stringify({
        timestamp: d.toISOString(),
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        message: status >= 500 ? 'upstream request failed' : 'request completed',
        service: 'api',
        host: pick(HOSTS),
        http: { status, path: pick(PATHS) },
        duration_ms: Math.floor(rnd() * 2000),
        request_id: i,
      });
    },
  },
];

async function writeDayFile(svc, dayIndex) {
  const dayStart = Date.UTC(2024, 0, 1 + dayIndex);
  const dateStr = new Date(dayStart).toISOString().slice(0, 10);
  const name = `${svc.name}-${dateStr}.${svc.ext}`;
  const out = createWriteStream(path.join(outDir, name));
  // spread the day's lines across the 24h window, staying inside the day
  const avgGap = DAY_MS / linesPerDay;
  let clock = dayStart;
  for (let i = 0; i < linesPerDay; i++) {
    clock = Math.min(clock + Math.floor(rnd() * avgGap * 2), dayStart + DAY_MS - 1000);
    out.write(svc.line(dayIndex * linesPerDay + i, new Date(clock)) + '\n');
  }
  out.end();
  return new Promise((resolve) => out.on('finish', () => resolve(name)));
}

const written = [];
for (const svc of SERVICES) {
  for (let d = 0; d < days; d++) written.push(await writeDayFile(svc, d));
}
console.log(`Wrote ${written.length} daily files into ${path.resolve(outDir)}/`);
console.log(`  ${days} days × ${SERVICES.length} services, ${linesPerDay.toLocaleString()} lines/day each`);
for (const n of written) console.log(`  ${n}`);
