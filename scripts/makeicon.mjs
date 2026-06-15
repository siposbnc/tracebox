// Renders the TraceBox logo to a multi-size Windows .ico (and a 256px PNG),
// with no browser or native dependency. The logo is simple geometry — a
// rounded square plus three rounded bars — rasterized with 4x4 supersampling
// for antialiasing, then PNG-encoded via the built-in zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const ACCENT = [14, 165, 233]; // #0ea5e9
const INK = [8, 47, 73]; // #082f49

// Signed distance to a rounded box centered at origin with half-extents h and radius r.
function sdRoundBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// Signed distance to a thick rounded segment (capsule) from a to b with radius r.
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/** Render the logo into an RGBA buffer of the given size. */
function renderIcon(size) {
  const S = size;
  const buf = Buffer.alloc(S * S * 4); // transparent
  const SS = 4; // supersampling factor per axis

  // geometry in pixel space
  const cx = S / 2;
  const cy = S / 2;
  const half = 0.406 * S; // half-extent of the rounded square
  const radius = 0.19 * S;
  const barR = 0.04 * S;
  const bars = [
    [0.3, 0.375, 0.72],
    [0.3, 0.5, 0.58],
    [0.3, 0.625, 0.67],
  ].map(([x0, y, x1]) => [x0 * S, y * S, x1 * S, y * S]);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let rAcc = 0;
      let gAcc = 0;
      let bAcc = 0;
      let aAcc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          // start transparent
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          if (sdRoundBox(px - cx, py - cy, half, half, radius) <= 0) {
            [cr, cg, cb] = ACCENT;
            ca = 1;
          }
          for (const [ax, ay, bx, by] of bars) {
            if (sdCapsule(px, py, ax, ay, bx, by, barR) <= 0) {
              [cr, cg, cb] = INK;
              ca = 1;
              break;
            }
          }
          rAcc += cr;
          gAcc += cg;
          bAcc += cb;
          aAcc += ca;
        }
      }
      const n = SS * SS;
      const i = (y * S + x) * 4;
      // colors are accumulated only on covered subsamples; average over covered
      const covered = aAcc || 1;
      buf[i] = Math.round(rAcc / covered);
      buf[i + 1] = Math.round(gAcc / covered);
      buf[i + 2] = Math.round(bAcc / covered);
      buf[i + 3] = Math.round((aAcc / n) * 255);
    }
  }
  return buf;
}

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO assembly -----------------------------------------------------------

function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

// --- main -------------------------------------------------------------------

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, data: encodePng(renderIcon(size), size) }));

writeFileSync(path.join(OUT_DIR, 'build', 'icon.ico'), encodeIco(pngs));
writeFileSync(path.join(OUT_DIR, 'build', 'icon.png'), pngs.at(-1).data);
// also refresh the in-app favicon used by the web UI
writeFileSync(path.join(OUT_DIR, 'public', 'tracebox.png'), pngs.at(-1).data);
console.log(`Wrote build/icon.ico (${sizes.join(', ')}), build/icon.png, public/tracebox.png`);
