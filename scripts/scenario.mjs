// Generates a synthetic log with a REAL incident buried in noise, for
// exercising TraceBox end-to-end. Not part of the product — a test fixture.
//
//   node scripts/scenario.mjs incident.log
//
// Story: a midnight deploy ships a bad DB pool config. Minutes later the
// payments service starts exhausting its connection pool under load, which
// surfaces as 503s on /api/checkout and a recurring stack trace. Everything
// else is normal background traffic.
import { createWriteStream } from 'node:fs';

const outFile = process.argv[2] ?? 'incident.log';

let rngState = 0xc0ffee;
function rnd() {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 0xffffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const SERVICES = ['auth', 'payments', 'gateway', 'catalog', 'orders', 'email', 'search'];
const HOSTS = ['web-01', 'web-02', 'worker-01', 'worker-02', 'db-proxy'];
const NORMAL = [
  'request completed',
  'cache miss for key session',
  'user authentication succeeded',
  'background job finished',
  'rate limit applied',
];

let ts = Date.UTC(2024, 2, 14, 23, 50, 0); // 23:50 UTC
function tick(maxMs) {
  ts += Math.floor(rnd() * maxMs);
  return new Date(ts);
}
function fmt(d, level, service, host, msg, reqId, dur) {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)} [${level}] ${service}.${host} - ${msg} request_id=${reqId} duration=${dur}ms`;
}

const out = createWriteStream(outFile);
let reqId = 1000;
const lines = [];

function normalLine() {
  const d = tick(120);
  const level = rnd() < 0.08 ? 'WARN' : rnd() < 0.02 ? 'ERROR' : 'INFO';
  lines.push(fmt(d, level, pick(SERVICES), pick(HOSTS), pick(NORMAL), reqId++, Math.floor(rnd() * 400)));
}

// 1) ~6 minutes of calm background traffic before the deploy.
const deployAt = Date.UTC(2024, 2, 15, 0, 0, 0); // 00:00 UTC
while (ts < deployAt) normalLine();

// 2) The deploy marker — the root cause, a single innocuous-looking line.
{
  const d = tick(10);
  lines.push(fmt(d, 'INFO', 'gateway', 'web-01',
    'deploy v4.2.0 applied: db.pool.maxConnections 50 -> 5', reqId++, 12));
}

// 3) After the deploy: normal traffic continues, but payments starts failing
//    intermittently and worsens. Each failure emits a multi-line stack trace.
const incidentEnd = Date.UTC(2024, 2, 15, 0, 12, 0);
let failures = 0;
while (ts < incidentEnd) {
  // failure probability ramps up over the incident window
  const progress = (ts - deployAt) / (incidentEnd - deployAt);
  if (rnd() < 0.05 + progress * 0.35) {
    const d = tick(80);
    const rid = reqId++;
    const wait = 1000 + Math.floor(rnd() * 9000);
    lines.push(fmt(d, 'ERROR', 'payments', pick(['web-01', 'web-02']),
      'checkout failed: could not acquire DB connection', rid, wait));
    lines.push('  org.tracebox.db.PoolTimeoutException: Timeout waiting for connection from pool (active=5, idle=0, waiting=' + (3 + Math.floor(rnd() * 20)) + ')');
    lines.push('      at org.tracebox.db.ConnectionPool.acquire(ConnectionPool.java:214)');
    lines.push('      at org.tracebox.payments.Checkout.charge(Checkout.java:88)');
    lines.push('      at org.tracebox.payments.Checkout.handle(Checkout.java:41)');
    lines.push('      at org.tracebox.http.Router.dispatch(Router.java:127)');
    failures++;
  } else {
    normalLine();
  }
}

// 4) Recovery: a rollback, then calm again.
{
  const d = tick(10);
  lines.push(fmt(d, 'INFO', 'gateway', 'web-01',
    'deploy v4.2.1 applied: db.pool.maxConnections 5 -> 50 (rollback)', reqId++, 14));
}
const calmEnd = Date.UTC(2024, 2, 15, 0, 18, 0);
while (ts < calmEnd) normalLine();

out.write(lines.join('\n') + '\n');
out.end(() => {
  console.log(`Wrote ${outFile}: ${lines.length} lines, ${failures} payment failures.`);
});
