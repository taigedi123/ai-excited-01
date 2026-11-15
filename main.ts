// ai-excited-01 — a program that draws ONE image made to get an AI judge excited.
// Node 22, standard library only, no network. Everything is drawn procedurally at
// runtime, deterministically: running it twice writes byte-identical PNG bytes.
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;
const SS = 2; // supersampling factor for smooth edges
const SW = W * SS;
const SH = H * SS;

// Float RGB buffer, values 0..1. The background is painted opaque first, so every
// later draw is a blend-over or an additive glow onto it.
const px = new Float32Array(SW * SH * 3);

type RGB = [number, number, number];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Multi-stop gradient: stops are [position 0..1, colour].
function grad(stops: [number, RGB][], t: number): RGB {
  t = clamp01(t);
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (t <= p1) return mix(c0, c1, p1 === p0 ? 0 : (t - p0) / (p1 - p0));
  }
  return stops[stops.length - 1][1];
}

// --- pixel ops (coordinates are in supersampled space) ----------------------
function blend(x: number, y: number, c: RGB, a: number): void {
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= SW || yi >= SH || a <= 0) return;
  const i = (yi * SW + xi) * 3;
  px[i] = c[0] * a + px[i] * (1 - a);
  px[i + 1] = c[1] * a + px[i + 1] * (1 - a);
  px[i + 2] = c[2] * a + px[i + 2] * (1 - a);
}

function add(x: number, y: number, c: RGB, a: number): void {
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= SW || yi >= SH || a <= 0) return;
  const i = (yi * SW + xi) * 3;
  px[i] += c[0] * a;
  px[i + 1] += c[1] * a;
  px[i + 2] += c[2] * a;
}

// --- fills (coordinates are in logical 1024 space) --------------------------
function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1): void {
  const X0 = Math.max(0, Math.floor(x0 * SS));
  const X1 = Math.min(SW, Math.ceil(x1 * SS));
  const Y0 = Math.max(0, Math.floor(y0 * SS));
  const Y1 = Math.min(SH, Math.ceil(y1 * SS));
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) blend(x, y, c, a);
}

// Vertical gradient over a rectangle.
function vgrad(x0: number, y0: number, x1: number, y1: number, stops: [number, RGB][]): void {
  const Y0 = Math.max(0, Math.floor(y0 * SS));
  const Y1 = Math.min(SH, Math.ceil(y1 * SS));
  for (let y = Y0; y < Y1; y++) {
    const c = grad(stops, (y / SS - y0) / (y1 - y0));
    fillRect(x0, y / SS, x1, y / SS + 1 / SS + 0.01, c, 1);
  }
}

// Soft additive radial glow. peak is the added brightness at the centre.
function glow(cx: number, cy: number, r: number, c: RGB, peak: number, falloff = 2): void {
  const R = Math.ceil(r * SS);
  const CX = cx * SS;
  const CY = cy * SS;
  const X0 = Math.max(0, Math.floor(CX - R));
  const X1 = Math.min(SW, Math.ceil(CX + R));
  const Y0 = Math.max(0, Math.floor(CY - R));
  const Y1 = Math.min(SH, Math.ceil(CY + R));
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const d = Math.hypot(x - CX, y - CY) / R;
      if (d >= 1) continue;
      add(x, y, c, peak * Math.pow(1 - d, falloff));
    }
  }
}

// Filled disc. soft>0 feathers the edge over that many logical pixels.
function disc(cx: number, cy: number, r: number, c: RGB, a = 1, soft = 0): void {
  const R = (r + soft) * SS;
  const CX = cx * SS;
  const CY = cy * SS;
  const X0 = Math.max(0, Math.floor(CX - R));
  const X1 = Math.min(SW, Math.ceil(CX + R));
  const Y0 = Math.max(0, Math.floor(CY - R));
  const Y1 = Math.min(SH, Math.ceil(CY + R));
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const d = Math.hypot(x - CX, y - CY) / SS;
      let al = 0;
      if (soft > 0) al = a * clamp01((r - d) / soft + 0.5);
      else if (d <= r) al = a;
      if (al > 0) blend(x, y, c, al);
    }
  }
}

// Scanline polygon fill.
function poly(pts: [number, number][], c: RGB, a = 1): void {
  const P = pts.map(([x, y]): [number, number] => [x * SS, y * SS]);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of P) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (let y = Math.max(0, Math.floor(minY)); y < Math.min(SH, Math.ceil(maxY)); y++) {
    const xs: number[] = [];
    for (let i = 0; i < P.length; i++) {
      const [x0, y0] = P[i];
      const [x1, y1] = P[(i + 1) % P.length];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const X0 = Math.max(0, Math.floor(xs[k]));
      const X1 = Math.min(SW, Math.ceil(xs[k + 1]));
      for (let x = X0; x < X1; x++) blend(x, y, c, a);
    }
  }
}

function segDist(px0: number, py0: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px0 - x0) * dx + (py0 - y0) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px0 - (x0 + t * dx), py0 - (y0 + t * dy));
}

// Thick polyline with round caps/joins (constant width).
function stroke(pts: [number, number][], width: number, c: RGB, a = 1): void {
  const r = (width / 2) * SS;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const X0 = Math.max(0, Math.floor(Math.min(x0, x1) * SS - r - 1));
    const X1 = Math.min(SW, Math.ceil(Math.max(x0, x1) * SS + r + 1));
    const Y0 = Math.max(0, Math.floor(Math.min(y0, y1) * SS - r - 1));
    const Y1 = Math.min(SH, Math.ceil(Math.max(y0, y1) * SS + r + 1));
    for (let y = Y0; y < Y1; y++) {
      for (let x = X0; x < X1; x++) {
        if (segDist(x, y, x0 * SS, y0 * SS, x1 * SS, y1 * SS) <= r) blend(x, y, c, a);
      }
    }
  }
}


function cubic(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], n = 32): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

function quad(p0: [number, number], p1: [number, number], p2: [number, number], n = 20): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return out;
}

// Elongated pointed shape (feather / fin / flame tongue) from base to tip.
function leaf(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a = 1): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const mx = x0 + dx * 0.45;
  const my = y0 + dy * 0.45;
  poly(
    [
      [x0, y0],
      [mx + nx * w, my + ny * w],
      [x1, y1],
      [mx - nx * w, my - ny * w],
    ],
    c,
    a,
  );
}

// Four-point sparkle star.
function sparkle(cx: number, cy: number, r: number, c: RGB, a = 1): void {
  const pts: [number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i * Math.PI) / 4;
    const rr = i % 2 === 0 ? r : r * 0.16;
    pts.push([cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr]);
  }
  poly(pts, c, a);
  glow(cx, cy, r * 2.4, c, 0.3 * a);
}

// --- tiny 5x7 bitmap font (each glyph: 7 rows of 5 bits, bit 4 = leftmost) ----
const FONT: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
  '-': [0, 0, 0, 0x0e, 0, 0, 0],
  "'": [0x04, 0x04, 0x08, 0, 0, 0, 0],
};

function drawText(str: string, x: number, y: number, s: number, c: RGB, a = 1): void {
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const g = FONT[ch] ?? FONT[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if ((g[row] >> (4 - col)) & 1) {
          fillRect(cx + col * s, y + row * s, cx + (col + 1) * s, y + (row + 1) * s, c, a);
        }
      }
    }
    cx += 6 * s;
  }
}

function textWidth(str: string, s: number): number {
  return str.length * 6 * s - s;
}

// --- PNG encoding (pure Node: zlib deflate, per-row best filter) --------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function encodePNG(rgb: Uint8Array, w: number, h: number): Buffer {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgb.subarray((y - 1) * stride, y * stride) : null;
    let bestF = 0;
    let bestScore = Infinity;
    let best: Buffer | null = null;
    for (let f = 0; f < 5; f++) {
      const out = Buffer.alloc(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        let v = row[i];
        if (f === 1) v = (v - (i >= 3 ? row[i - 3] : 0)) & 255;
        else if (f === 2) v = (v - (prev ? prev[i] : 0)) & 255;
        else if (f === 3) v = (v - (((i >= 3 ? row[i - 3] : 0) + (prev ? prev[i] : 0)) >> 1)) & 255;
        else if (f === 4) {
          const a = i >= 3 ? row[i - 3] : 0;
          const b = prev ? prev[i] : 0;
          const cc = i >= 3 && prev ? prev[i - 3] : 0;
          const p = a + b - cc;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - cc);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
          v = (v - pr) & 255;
        }
        out[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestF = f;
        best = out;
      }
    }
    raw[y * (stride + 1)] = bestF;
    best!.copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// Average the supersampled buffer down to 1024x1024 RGB bytes.
function downsample(): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * SW + x * SS + dx) * 3;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
        }
      }
      const n = SS * SS;
      const o = (y * W + x) * 3;
      out[o] = Math.round(clamp01(r / n) * 255);
      out[o + 1] = Math.round(clamp01(g / n) * 255);
      out[o + 2] = Math.round(clamp01(b / n) * 255);
    }
  }
  return out;
}

// --- SCENE B: a giant koi leaps for the moon; its splash becomes stars -------
function drawKoi(): void {
  const rnd = mulberry32(77);

  // Night sky over the sea.
  vgrad(0, 0, W, 720, [
    [0, hex('#010512')],
    [0.45, hex('#05233d')],
    [0.8, hex('#0a4a5e')],
    [1, hex('#0f6a72')],
  ]);
  fillRect(0, 720, W, H, hex('#03202e'));

  // Stars, dense and varied; a few bright ones sparkle.
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W;
    const y = rnd() * 660;
    const r = 0.6 + rnd() * 1.7;
    const b = 0.4 + rnd() * 0.6;
    disc(x, y, r, [b, b * 0.98, b], 0.95);
    if (rnd() < 0.05) sparkle(x, y, 3 + rnd() * 4, hex('#ffffff'), 0.85);
  }
  // A small constellation, top-left.
  const cons: [number, number][] = [
    [120, 90],
    [168, 118],
    [205, 96],
    [248, 130],
    [290, 104],
  ];
  stroke(cons, 1.4, hex('#9fd8ff'), 0.6);
  cons.forEach(([cx, cy]) => sparkle(cx, cy, 3.5, hex('#cfeaff'), 0.9));

  // The moon: halo, disc, craters.
  glow(770, 215, 260, hex('#ffe9a8'), 0.55);
  glow(770, 215, 150, hex('#fff3c4'), 0.7);
  disc(770, 215, 108, hex('#fff6d8'), 1, 4);
  disc(740, 185, 18, hex('#ecd9a8'), 0.5, 6);
  disc(800, 250, 24, hex('#ecd9a8'), 0.45, 8);
  disc(790, 175, 12, hex('#ecd9a8'), 0.4, 5);
  disc(735, 245, 9, hex('#ecd9a8'), 0.4, 4);

  // Moonlight path on the water: shimmering gold dashes under the moon.
  for (let i = 0; i < 130; i++) {
    const mx = 770 + (rnd() - 0.5) * (40 + (rnd() * 260));
    const my = 730 + rnd() * 280;
    const mw = 8 + rnd() * 42;
    fillRect(mx - mw / 2, my, mx + mw / 2, my + 2.5, hex('#ffd27a'), 0.16 + rnd() * 0.3);
  }

  // Rolling waves: long arcs of lighter teal, each row with its own swell and gaps.
  for (let w = 0; w < 14; w++) {
    const wy = 742 + w * 20 + rnd() * 8;
    const phase = rnd() * Math.PI * 2;
    const amp = 5 + rnd() * 8;
    const pts: [number, number][] = [];
    for (let x = -20; x <= W + 20; x += 40) {
      pts.push([x, wy + Math.sin((x / W) * Math.PI * 2 + phase) * amp]);
    }
    // Draw in broken runs so the sea is not a set of perfect rails.
    let run: [number, number][] = [];
    for (const p of pts) {
      run.push(p);
      if (rnd() < 0.14 && run.length > 2) {
        stroke(run, 2.5, hex('#0f6a72'), 0.5);
        run = [];
      }
    }
    if (run.length > 1) stroke(run, 2.5, hex('#0f6a72'), 0.5);
    stroke(pts, 1.2, hex('#7ad0ff'), 0.16);
  }

  // The koi's spine: a leap from the water at lower-left to the moon at upper-right.
  const spine = cubic([290, 830], [420, 600], [540, 430], [690, 330], 40);
  const radiusAt = (t: number): number => 12 + Math.sin(Math.min(t * 1.25, 1) * Math.PI) * 40;

  // Tail fin first (behind the body): three big flowing translucent leaves.
  const tailBase = spine[0];
  leaf(tailBase[0] - 6, tailBase[1] + 4, tailBase[0] - 150, tailBase[1] + 180, 40, hex('#ff5a1f'), 0.92);
  leaf(tailBase[0] + 4, tailBase[1] - 2, tailBase[0] - 80, tailBase[1] + 225, 32, hex('#ff9a2a'), 0.92);
  leaf(tailBase[0] + 10, tailBase[1] + 8, tailBase[0] - 185, tailBase[1] + 110, 28, hex('#ffc93c'), 0.85);
  leaf(tailBase[0] - 2, tailBase[1] + 12, tailBase[0] - 120, tailBase[1] + 250, 20, hex('#ffe14d'), 0.8);
  glow(tailBase[0] - 90, tailBase[1] + 150, 90, hex('#ff7a1a'), 0.25);

  // Body: overlapping discs along the spine, one smooth orange; a soft darker
  // shade underneath gives it volume instead of stripes.
  const orange = hex('#ff7a1a');
  const deep = hex('#e2480f');
  spine.forEach(([bx, by], i) => {
    const t = i / (spine.length - 1);
    const r = radiusAt(t);
    disc(bx, by, r, mix(orange, deep, 0.12 * Math.sin(i * 0.9) + 0.12), 0.98);
  });
  // Belly shade along the lower edge.
  spine.forEach(([bx, by], i) => {
    const t = i / (spine.length - 1);
    const r = radiusAt(t);
    disc(bx - 2, by + r * 0.5, r * 0.55, deep, 0.35, 4);
  });
  // Pale belly patches: small, irregular, hugging the lower edge only.
  spine.forEach(([bx, by], i) => {
    const t = i / (spine.length - 1);
    if (t > 0.3 && t < 0.85 && i % 3 === 0 && rnd() < 0.75) {
      disc(bx - 4, by + radiusAt(t) * 0.72, radiusAt(t) * (0.2 + rnd() * 0.1), hex('#fff3e0'), 0.38, 3);
    }
  });
  // Moonlit rim along the back.
  const rim: [number, number][] = spine.map(([bx, by], i) => {
    const t = i / (spine.length - 1);
    return [bx + 3, by - radiusAt(t) * 0.72];
  });
  stroke(rim, 3, hex('#ffe9a8'), 0.65);
  // Scale arcs along the flank.
  for (let i = 4; i < spine.length - 4; i += 3) {
    const [bx, by] = spine[i];
    const r = radiusAt(i / (spine.length - 1));
    const a0 = 0.3 + rnd() * 0.4;
    stroke(
      quad([bx - r * 0.5, by - r * 0.1], [bx, by + r * 0.35], [bx + r * 0.5, by - r * 0.1], 8),
      1.6,
      hex('#ffd27a'),
      0.4 + a0 * 0.3,
    );
  }

  // Dorsal fin: narrow gold leaves sweeping back toward the tail.
  for (let i = 8; i < spine.length - 8; i += 5) {
    const [bx, by] = spine[i];
    const r = radiusAt(i / (spine.length - 1));
    leaf(bx, by - r * 0.6, bx - 20, by - r * 1.5, 7, hex('#ffc93c'), 0.9);
  }
  // Pectoral fin near the head.
  const head = spine[spine.length - 1];
  leaf(head[0] - 18, head[1] + 18, head[0] - 70, head[1] + 78, 14, hex('#ff9a2a'), 0.9);

  // Head: slightly flattened disc, whiskers, eye.
  disc(head[0], head[1], 34, orange, 1);
  disc(head[0] + 8, head[1] - 6, 26, hex('#ff9a2a'), 0.9);
  stroke(quad([head[0] + 26, head[1] + 6], [head[0] + 62, head[1] + 22], [head[0] + 96, head[1] + 52], 10), 2.2, hex('#ffd27a'), 0.9);
  stroke(quad([head[0] + 24, head[1] + 12], [head[0] + 58, head[1] + 34], [head[0] + 88, head[1] + 70], 10), 2.2, hex('#ffd27a'), 0.9);
  glow(head[0] + 12, head[1] - 8, 14, hex('#ffffff'), 0.9);
  disc(head[0] + 12, head[1] - 8, 5, hex('#ffffff'), 1);
  disc(head[0] + 13, head[1] - 8, 2.4, hex('#06283d'), 1);

  // The splash: droplets burst from the leap point and turn into stars as they rise.
  const leap: [number, number] = [290, 830];
  for (let i = 0; i < 230; i++) {
    const ang = -Math.PI * (0.15 + rnd() * 0.7);
    const dist = 20 + rnd() * rnd() * 330;
    const dx = leap[0] + Math.cos(ang) * dist + (rnd() - 0.5) * 26;
    const dy = leap[1] + Math.sin(ang) * dist * 0.85 - rnd() * 30;
    const h = clamp01((leap[1] - dy) / 320); // 0 at water, 1 high up
    const r = 1 + rnd() * (3.4 - h * 1.6);
    if (h > 0.55 && rnd() < 0.5) {
      sparkle(dx, dy, r * 2.2, hex('#dff3ff'), 0.95);
    } else {
      disc(dx, dy, r, mix(hex('#7ad0ff'), hex('#dff3ff'), h), 0.9, 1);
    }
  }
  // Splash crown: arcs of water around the leap point.
  for (let a = 0; a < 7; a++) {
    const ang = Math.PI * (1.05 + a * 0.13);
    const rr = 46 + a * 16;
    stroke(
      quad(
        [leap[0] + Math.cos(ang) * rr * 0.4, leap[1] - 8],
        [leap[0] + Math.cos(ang) * rr * 0.8, leap[1] - 60 - a * 8],
        [leap[0] + Math.cos(ang) * rr, leap[1] - 10],
        10,
      ),
      3,
      hex('#bfeaff'),
      0.8,
    );
  }
  // Ripples: concentric arcs on the water.
  for (let r = 0; r < 5; r++) {
    const rr = 60 + r * 42;
    const pts: [number, number][] = [];
    for (let a = Math.PI * 1.02; a <= Math.PI * 1.98; a += 0.08) {
      pts.push([leap[0] + Math.cos(a) * rr, leap[1] + Math.sin(a) * rr * 0.32]);
    }
    stroke(pts, 2.5, hex('#9fd8ff'), 0.55 - r * 0.08);
  }

  // Motion streaks along the leap arc.
  for (let i = 0; i < 26; i++) {
    const t = rnd() * 0.8;
    const [sx, sy] = spine[Math.floor(t * (spine.length - 1))];
    const off = (rnd() - 0.5) * 90;
    const len = 26 + rnd() * 60;
    stroke(
      [
        [sx + off, sy + 40],
        [sx + off * 0.7 + len * 0.4, sy + 40 - len],
      ],
      1.6,
      hex('#9fd8ff'),
      0.28,
    );
  }

  // A word for the judge, in moonlight gold on the dark water.
  const phrase = 'TO THE MOON';
  const ts = 5;
  const tw = textWidth(phrase, ts);
  glow(512, 962, 200, hex('#ffd27a'), 0.12);
  drawText(phrase, 512 - tw / 2, 944, ts, hex('#ffd27a'), 0.95);
}

// --- entry point ----------------------------------------------------------------
// The winning scene: a giant koi leaps for the moon.
drawKoi();

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), encodePNG(downsample(), W, H));
