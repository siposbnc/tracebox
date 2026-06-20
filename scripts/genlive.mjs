// Appends synthetic structured logs to one or more files in real time, so you
// can exercise TraceBox's live tail and the merged live timeline. Each "API"
// gets its own file, service name, hosts and traffic character, so the merged
// timeline interleaves several independent sources.
//
//   node scripts/genlive.mjs                       # 3 APIs into ./live-logs/, app format
//   node scripts/genlive.mjs --rate 20             # ~20 lines/sec per API
//   node scripts/genlive.mjs auth payments gateway # name the APIs explicitly
//   node scripts/genlive.mjs auth:json orders:app  # per-API format override
//   node scripts/genlive.mjs --dir C:/tmp/logs --format json api-a api-b
//
// Options:
//   --dir <path>      output directory (default ./live-logs)
//   --rate <n>        average lines per second, per API (default 5)
//   --format <fmt>    default line format: app | json | access (default app)
//   --fresh           clear/overwrite existing log files instead of appending
//                     (aliases: --clear, --overwrite)
//   --no-bursts       disable the occasional traffic/error spikes
//
// Stop with Ctrl+C. By default files are appended to, so you can restart against
// the same files to simulate a process that was paused; pass --fresh to start
// each file from empty.
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---- argument parsing -------------------------------------------------------

const args = process.argv.slice(2);
const opts = { dir: 'live-logs', rate: 5, format: 'app', bursts: true, fresh: false };
const names = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dir') opts.dir = args[++i];
  else if (a === '--rate') opts.rate = Number(args[++i]);
  else if (a === '--format') opts.format = args[++i];
  else if (a === '--no-bursts') opts.bursts = false;
  else if (a === '--fresh' || a === '--clear' || a === '--overwrite') opts.fresh = true;
  else if (a.startsWith('--')) {
    console.error(`Unknown option: ${a}`);
    process.exit(1);
  } else names.push(a);
}

const FORMATS = new Set(['app', 'json', 'access']);
if (!FORMATS.has(opts.format)) {
  console.error(`--format must be one of: ${[...FORMATS].join(', ')}`);
  process.exit(1);
}
if (!Number.isFinite(opts.rate) || opts.rate <= 0) {
  console.error('--rate must be a positive number');
  process.exit(1);
}

// Default to three distinct-looking APIs when none are named.
if (names.length === 0) names.push('auth', 'payments', 'gateway');

// ---- shared vocabulary ------------------------------------------------------

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];
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

const rnd = () => Math.random();
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// ---- per-API source state ---------------------------------------------------

/**
 * Build one log source: an open write stream plus the state needed to render
 * lines that look like they came from a single service.
 */
function makeSource(spec) {
  const [name, fmt] = spec.split(':');
  const format = fmt ?? opts.format;
  if (!FORMATS.has(format)) {
    console.error(`Unknown format "${fmt}" for "${name}"`);
    process.exit(1);
  }
  const hosts = [1, 2].map((n) => `${name}-${String(n).padStart(2, '0')}`);
  const file = join(opts.dir, `${name}.log`);
  return {
    name,
    format,
    hosts,
    file,
    // 'a' appends to any existing file; 'w' truncates it (--fresh).
    stream: createWriteStream(file, { flags: opts.fresh ? 'w' : 'a' }),
    seq: 0,
    // Each source carries an independent error-rate baseline so the merged
    // timeline shows sources misbehaving at different times.
    errorBias: rnd() * 0.1,
    spikeUntil: 0,
  };
}

/** Render a single line for a source in its configured format. */
function makeLine(src) {
  const d = new Date();
  const iso = d.toISOString();
  const i = src.seq++;
  const erroring = Date.now() < src.spikeUntil;
  const level = erroring && rnd() < 0.6 ? 'ERROR' : pick(LEVELS);
  const host = pick(src.hosts);

  switch (src.format) {
    case 'json':
      return JSON.stringify({
        timestamp: iso,
        level: level.toLowerCase(),
        message: `${pick(MESSAGES)} (#${i})`,
        service: src.name,
        host,
        http: {
          status: erroring ? 503 : rnd() < src.errorBias ? 404 : 200,
          path: pick(PATHS),
        },
        duration_ms: Math.floor(rnd() * (erroring ? 8000 : 2000)),
      });
    case 'access': {
      const clf = `${String(d.getUTCDate()).padStart(2, '0')}/${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}/${d.getUTCFullYear()}:${iso.slice(11, 19)} +0000`;
      const status = erroring ? 500 + Math.floor(rnd() * 4) : rnd() < src.errorBias ? 404 : 200;
      return `10.0.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)} - ${rnd() < 0.3 ? 'alice' : '-'} [${clf}] "GET ${pick(PATHS)} HTTP/1.1" ${status} ${Math.floor(rnd() * 50000)}`;
    }
    default:
      return `${iso.slice(0, 10)} ${iso.slice(11, 23)} [${level}] ${src.name}.${host} - ${pick(MESSAGES)} request_id=${i} duration=${Math.floor(rnd() * (erroring ? 8000 : 2000))}ms`;
  }
}

// ---- run loop ---------------------------------------------------------------

mkdirSync(opts.dir, { recursive: true });
const sources = names.map(makeSource);

console.log(
  `${opts.fresh ? 'Overwriting' : 'Appending to'} ${sources.length} live log${
    sources.length === 1 ? '' : 's'
  } in ${opts.dir} at ~${opts.rate} line/s each:`,
);
for (const s of sources) console.log(`  ${s.file}  (${s.format})`);
console.log('Open these in TraceBox and merge them into a timeline. Ctrl+C to stop.\n');

/**
 * Schedule the next line for a source. Intervals are jittered around the target
 * rate so sources drift in and out of phase and lines interleave naturally.
 */
function schedule(src) {
  const base = 1000 / opts.rate;
  const delay = base * (0.4 + rnd() * 1.2);
  src.timer = setTimeout(() => {
    src.stream.write(makeLine(src) + '\n');
    // Occasionally tip a source into a short error/latency spike.
    if (opts.bursts && Date.now() >= src.spikeUntil && rnd() < 0.004) {
      src.spikeUntil = Date.now() + 2000 + rnd() * 4000;
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${src.name}: error spike`);
    }
    schedule(src);
  }, delay);
}

for (const src of sources) schedule(src);

let total = 0;
const report = setInterval(() => {
  const lines = sources.reduce((n, s) => n + s.seq, 0);
  process.stdout.write(`\r${lines.toLocaleString()} lines written (+${lines - total}/5s)   `);
  total = lines;
}, 5000);

function shutdown() {
  clearInterval(report);
  for (const src of sources) {
    clearTimeout(src.timer);
    src.stream.end();
  }
  const lines = sources.reduce((n, s) => n + s.seq, 0);
  console.log(`\nStopped. Wrote ${lines.toLocaleString()} lines across ${sources.length} file(s).`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
