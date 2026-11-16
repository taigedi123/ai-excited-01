// Koi to the Moon — a procedural 1024x1024 PNG, drawn pixel by pixel.
// No dependencies, no network: Node standard library only (fs, zlib).
// Deterministic: every random choice comes from a seeded generator.

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Seeded random (mulberry32) — same seed, same picture, every run.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261116);

// ---------------------------------------------------------------------------
// Canvas: 2x supersampled float RGB buffer, downsampled at the end.
// ---------------------------------------------------------------------------
const W = 1024, H = 1024, SS = 2, SW = W * SS, SH = H * SS;
const buf = new Float32Array(SW * SH * 3);

type RGB = [number, number, number];

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

function setPx(x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= SW || y >= SH) return;
  const i = (y * SW + x) * 3;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
}

function addPx(x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= SW || y >= SH) return;
  const i = (y * SW + x) * 3;
  buf[i] = Math.min(1, buf[i] + r);
  buf[i + 1] = Math.min(1, buf[i + 1] + g);
  buf[i + 2] = Math.min(1, buf[i + 2] + b);
}

// Blend a colour over the pixel with alpha a (0..1).
function blendPx(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= SW || y >= SH || a <= 0) return;
  if (a >= 1) { setPx(x, y, r, g, b); return; }
  const i = (y * SW + x) * 3;
  buf[i] = buf[i] * (1 - a) + r * a;
  buf[i + 1] = buf[i + 1] * (1 - a) + g * a;
  buf[i + 2] = buf[i + 2] * (1 - a) + b * a;
}

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------
interface Stop { t: number; c: RGB; }
function lerpStops(stops: Stop[], t: number): RGB {
  t = clamp01(t);
  if (t <= stops[0].t) return stops[0].c;
  for (let s = 1; s < stops.length; s++) {
    if (t <= stops[s].t) {
      const a = stops[s - 1], b = stops[s];
      const f = (t - a.t) / (b.t - a.t);
      return [
        a.c[0] + (b.c[0] - a.c[0]) * f,
        a.c[1] + (b.c[1] - a.c[1]) * f,
        a.c[2] + (b.c[2] - a.c[2]) * f,
      ];
    }
  }
  return stops[stops.length - 1].c;
}

function fillVerticalGradient(stops: Stop[], y0: number, y1: number): void {
  for (let y = 0; y < SH; y++) {
    const c = lerpStops(stops, (y - y0) / (y1 - y0));
    for (let x = 0; x < SW; x++) setPx(x, y, c[0], c[1], c[2]);
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
// Soft filled disc: radius in supersampled px, edge feather in px.
function disc(cx: number, cy: number, r: number, c: RGB, a = 1, feather = 1.5): void {
  const x0 = Math.max(0, Math.floor(cx - r - feather));
  const x1 = Math.min(SW - 1, Math.ceil(cx + r + feather));
  const y0 = Math.max(0, Math.floor(cy - r - feather));
  const y1 = Math.min(SH - 1, Math.ceil(cy + r + feather));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d >= r + feather) continue;
      const alpha = a * (d <= r ? 1 : 1 - (d - r) / feather);
      blendPx(x, y, c[0], c[1], c[2], alpha);
    }
  }
}

// Additive radial glow: brightness falls off smoothly from the centre.
function glow(cx: number, cy: number, r: number, c: RGB, strength: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(SW - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(SH - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
      if (d >= 1) continue;
      const f = strength * (1 - d) * (1 - d) * (1 + 2 * d * d);
      addPx(x, y, c[0] * f, c[1] * f, c[2] * f);
    }
  }
}

// Scanline polygon fill (points in supersampled coords).
function polygon(pts: Array<[number, number]>, c: RGB, a = 1): void {
  if (pts.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(SH - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1p] = pts[i], [x2, y2p] = pts[(i + 1) % pts.length];
      if ((y1p <= yc && y2p > yc) || (y2p <= yc && y1p > yc)) {
        xs.push(x1 + (yc - y1p) * (x2 - x1) / (y2p - y1p));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k])), xb = Math.min(SW - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) blendPx(x, y, c[0], c[1], c[2], a);
    }
  }
}

// Thick polyline: stamps discs along the path.
function thickLine(pts: Array<[number, number]>, width: number, c: RGB, a = 1): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(len / (width * 0.4)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      disc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, c, a, 1.2);
    }
  }
}

// Cubic bezier point.
function bezier(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}

// ---------------------------------------------------------------------------
// Tiny 5x7 bitmap font — only the glyphs we need (plus a few extras).
// Each row is a 5-bit mask, top row first.
// ---------------------------------------------------------------------------
const FONT: Record<string, number[]> = {
  "T": [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  "O": [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  "H": [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  "E": [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  "M": [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  "N": [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  " ": [0, 0, 0, 0, 0, 0, 0],
  "!": [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00100],
  ".": [0, 0, 0, 0, 0, 0, 0b00100],
};

// Draw text centred at (cx, cy) in final-pixel coords; scale = px per font unit.
function drawText(text: string, cx: number, cy: number, scale: number, c: RGB, a = 1): void {
  const unit = 6; // 5 wide + 1 gap
  const totalW = text.length * unit * scale - scale;
  let x = (cx - totalW / 2) * SS;
  const yTop = (cy - 3.5 * scale) * SS;
  const s = scale * SS;
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if ((glyph[row] >> (4 - col)) & 1) {
          const rx = Math.round(x + col * s), ry = Math.round(yTop + row * s);
          for (let yy = ry; yy < ry + s; yy++)
            for (let xx = rx; xx < rx + s; xx++) blendPx(xx, yy, c[0], c[1], c[2], a);
        }
      }
    }
    x += unit * s;
  }
}

// ---------------------------------------------------------------------------
// PNG encoder: CRC32, IHDR/IDAT/IEND, zlib deflate level 9, best filter/row.
// ---------------------------------------------------------------------------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
// Pick the best of the 5 PNG filters for one row by sum of |signed byte|.
function filterRow(row: Buffer, prev: Buffer | null, bpp: number): Buffer {
  const w = row.length;
  const cands: Buffer[] = [];
  for (let f = 0; f < 5; f++) {
    const out = Buffer.alloc(w + 1);
    out[0] = f;
    for (let i = 0; i < w; i++) {
      const x = row[i];
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const cc = prev && i >= bpp ? prev[i - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = Math.floor((a + b) / 2);
      else if (f === 4) pred = paeth(a, b, cc);
      out[i + 1] = (x - pred) & 0xff;
    }
    cands.push(out);
  }
  let best = cands[0], bestScore = Infinity;
  for (const cand of cands) {
    let score = 0;
    for (let i = 1; i < cand.length; i++) {
      const v = cand[i] >= 128 ? cand[i] - 256 : cand[i];
      score += Math.abs(v);
    }
    if (score < bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

function encodePNG(rgb: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const bpp = 3;
  const rows: Buffer[] = [];
  let prev: Buffer | null = null;
  for (let y = 0; y < height; y++) {
    const row = rgb.subarray(y * width * bpp, (y + 1) * width * bpp);
    const filtered = filterRow(row, prev, bpp);
    rows.push(filtered);
    prev = row;
  }
  const idat = deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Downsample the 2x buffer to 1024x1024 RGB bytes (box average).
function downsample(): Buffer {
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * SW + x * SS + dx) * 3;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
        }
      }
      const o = (y * W + x) * 3, n = SS * SS;
      out[o] = Math.round(clamp01(r / n) * 255);
      out[o + 1] = Math.round(clamp01(g / n) * 255);
      out[o + 2] = Math.round(clamp01(b / n) * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scene: midnight sea, giant moon, leaping koi, spray turning to stars.
// All coordinates below are in FINAL pixels (x SS to get buffer coords).
// ---------------------------------------------------------------------------
const S = (v: number): number => v * SS; // final px -> supersampled px
const HORIZON = 700; // where sea meets sky, in final px

function drawSky(): void {
  fillVerticalGradient([
    { t: 0.0, c: [0.012, 0.016, 0.055] },
    { t: 0.45, c: [0.03, 0.05, 0.14] },
    { t: 0.68, c: [0.05, 0.10, 0.22] },
    { t: 1.0, c: [0.03, 0.09, 0.19] },
  ], 0, SH);
}

function drawStars(): void {
  // Background stars, denser and brighter near the top.
  for (let i = 0; i < 420; i++) {
    const x = rand() * W, y = Math.pow(rand(), 1.4) * 660;
    const r = 0.6 + rand() * 1.5;
    const b = 0.35 + rand() * 0.65;
    const tint: RGB = rand() < 0.25 ? [1, 0.9, 0.7] : [0.85, 0.9, 1];
    disc(S(x), S(y), S(r), [tint[0] * b, tint[1] * b, tint[2] * b], 0.95, 1);
    if (rand() < 0.12) {
      // A few bright stars get a cross sparkle.
      const l = S(r * 5);
      thickLine([[S(x) - l, S(y)], [S(x) + l, S(y)]], S(0.7), [1, 1, 1], 0.5);
      thickLine([[S(x), S(y) - l], [S(x), S(y) + l]], S(0.7), [1, 1, 1], 0.5);
    }
  }
}

function drawMoon(): void {
  const mx = 752, my = 238, mr = 118;
  // Wide halo, then a tighter inner glow, then the disc itself.
  glow(S(mx), S(my), S(430), [0.55, 0.5, 0.28], 0.5);
  glow(S(mx), S(my), S(230), [0.85, 0.8, 0.55], 0.65);
  disc(S(mx), S(my), S(mr), [0.98, 0.94, 0.78], 1, 2.5);
  // Pale gold maria: soft darker blotches on the face.
  const maria: Array<[number, number, number, number]> = [
    [712, 205, 34, 0.10], [790, 262, 26, 0.08], [726, 285, 20, 0.09],
    [782, 198, 16, 0.07], [748, 232, 12, 0.06],
  ];
  for (const [x, y, r, a] of maria) disc(S(x), S(y), S(r), [0.78, 0.72, 0.55], a, 6);
  // Bright rim on the upper-left edge, catching light.
  for (let a = Math.PI * 0.75; a < Math.PI * 1.5; a += 0.01) {
    const x = mx + Math.cos(a) * (mr - 4), y = my + Math.sin(a) * (mr - 4);
    disc(S(x), S(y), S(2.5), [1, 0.99, 0.9], 0.4, 1.5);
  }
  // Thin bright ring just outside the disc.
  for (let a = 0; a < Math.PI * 2; a += 0.01) {
    const x = mx + Math.cos(a) * (mr + 5), y = my + Math.sin(a) * (mr + 5);
    disc(S(x), S(y), S(1.4), [1, 0.97, 0.82], 0.35, 1);
  }
}

function drawSea(): void {
  // Deep water with a vertical gradient and a gold moon-reflection column.
  for (let y = HORIZON * SS; y < SH; y++) {
    const t = (y - HORIZON * SS) / (SH - HORIZON * SS);
    const c = lerpStops([
      { t: 0.0, c: [0.02, 0.07, 0.15] },
      { t: 0.5, c: [0.012, 0.045, 0.11] },
      { t: 1.0, c: [0.005, 0.02, 0.06] },
    ], t);
    for (let x = 0; x < SW; x++) setPx(x, y, c[0], c[1], c[2]);
  }
  // Moonlight column: shimmering gold dashes under the moon.
  for (let i = 0; i < 90; i++) {
    const y = HORIZON + 8 + rand() * 300;
    const spread = 26 + (y - HORIZON) * 0.55;
    const x = 752 + (rand() - 0.5) * 2 * spread;
    const w = 14 + rand() * 60;
    const bright = 0.25 + rand() * 0.5;
    thickLine([[S(x - w / 2), S(y)], [S(x + w / 2), S(y)]], S(2.2 + rand() * 2),
      [0.95 * bright, 0.8 * bright, 0.4 * bright], 0.55);
  }
  // Dark wave crests: thin pale arcs across the water.
  for (let i = 0; i < 26; i++) {
    const y = HORIZON + 12 + rand() * 300;
    const x = rand() * W, w = 30 + rand() * 90;
    thickLine([[S(x), S(y)], [S(x + w * 0.6), S(y - 3)], [S(x + w), S(y)]],
      S(1.6), [0.35, 0.55, 0.75], 0.28);
  }
}

// ---------------------------------------------------------------------------
// The koi: a thick bezier spine, drawn as overlapping discs with a taper,
// orange back, cream belly, black patches, fins, tail, eye and barbels.
// ---------------------------------------------------------------------------
function drawKoi(): void {
  // Spine from tail (low left, still in the water) to head (high, near moon).
  const p0: [number, number] = [168, 826];
  const p1: [number, number] = [300, 730];
  const p2: [number, number] = [500, 560];
  const p3: [number, number] = [636, 412];
  const N = 90;
  const spine: Array<[number, number]> = [];
  for (let i = 0; i <= N; i++) spine.push(bezier(p0, p1, p2, p3, i / N));
  // Body width profile: slim and serpentine — narrow tail stalk, full middle,
  // tapering sharply to a pointed head.
  const widthAt = (t: number): number => {
    const base = 15 + 58 * Math.sin(Math.PI * Math.pow(t, 0.75));
    const headTaper = t > 0.86 ? 1 - (t - 0.86) * 4.5 : 1;
    return base * (t < 0.12 ? 0.4 + t * 4 : 1) * Math.max(0.25, headTaper);
  };
  // Back (orange) — full body first.
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const [x, y] = spine[i];
    disc(S(x), S(y), S(widthAt(t)), [0.92, 0.42, 0.10], 1, 2);
  }
  // Cream belly: offset discs toward the lower side of the body.
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    if (t < 0.08 || t > 0.96) continue;
    const [x, y] = spine[i];
    const [nx, ny] = spine[Math.min(N, i + 2)];
    const [px, py] = spine[Math.max(0, i - 2)];
    const dx = nx - px, dy = ny - py, len = Math.hypot(dx, dy) || 1;
    // Belly normal points down-right of the direction of travel.
    const off = widthAt(t) * 0.34;
    disc(S(x + (-dy / len) * off * 0.7 + 4), S(y + (dx / len) * off * 0.7 + 6),
      S(widthAt(t) * 0.62), [0.98, 0.92, 0.78], 0.95, 3);
  }
  // Black patches on the back: small, irregular, unevenly spaced — two
  // overlapping discs each, so none of them reads as a perfect polka dot.
  const patches: Array<[number, number, number]> = [
    [0.30, 0.16, 15], [0.45, -0.20, 18], [0.60, 0.14, 12], [0.74, -0.16, 16], [0.86, 0.04, 10],
  ];
  for (const [t, side, r] of patches) {
    const i = Math.round(t * N);
    const [x, y] = spine[i];
    const [nx, ny] = spine[Math.min(N, i + 2)];
    const [px, py] = spine[Math.max(0, i - 2)];
    const dx = nx - px, dy = ny - py, len = Math.hypot(dx, dy) || 1;
    const off = widthAt(t) * 0.40 * side;
    const cx = x + (-dy / len) * off, cy = y + (dx / len) * off;
    disc(S(cx), S(cy), S(r), [0.08, 0.06, 0.08], 0.95, 3);
    disc(S(cx + r * 0.7), S(cy + r * 0.4), S(r * 0.6), [0.08, 0.06, 0.08], 0.95, 3);
  }
  // Dorsal fin: a dark orange ridge along the top of the body.
  const finPts: Array<[number, number]> = [];
  for (let i = 8; i <= 62; i += 2) {
    const t = i / N;
    const [x, y] = spine[i];
    const [nx, ny] = spine[Math.min(N, i + 2)];
    const [px, py] = spine[Math.max(0, i - 2)];
    const dx = nx - px, dy = ny - py, len = Math.hypot(dx, dy) || 1;
    const lift = widthAt(t) * (0.95 + 0.25 * Math.sin(t * 21));
    finPts.push([x + (dy / len) * lift, y + (-dx / len) * lift]);
  }
  polygon(finPts.map(([x, y]) => [S(x), S(y)] as [number, number]),
    [0.78, 0.28, 0.06], 0.95);
  // Pectoral fin sweeping back from the mid-body.
  const [hx, hy] = spine[N];
  polygon([
    [S(hx - 96), S(hy + 42)], [S(hx - 190), S(hy + 150)], [S(hx - 118), S(hy + 96)],
  ], [0.95, 0.55, 0.22], 0.95);
  // Tail: a big flowing fork, trailing down-left into the splash.
  const [tx, ty] = spine[0];
  polygon([
    [S(tx + 22), S(ty - 26)], [S(tx - 30), S(ty - 118)], [S(tx - 74), S(ty - 44)],
    [S(tx - 96), S(ty + 6)], [S(tx - 58), S(ty + 40)], [S(tx - 96), S(ty + 96)],
    [S(tx - 20), S(ty + 58)],
  ], [0.96, 0.62, 0.25], 0.97);
  thickLine(
    [[S(tx), S(ty)], [S(tx - 60), S(ty - 30)], [S(tx - 88), S(ty + 10)]],
    S(10), [0.9, 0.4, 0.12], 0.6,
  );
  // Head details: eye seated ON the head just behind the snout tip, a small
  // mouth at the tip, and two short barbels sweeping back from it.
  disc(S(hx - 20), S(hy - 10), S(10), [0.98, 0.95, 0.85], 1, 2);
  disc(S(hx - 18), S(hy - 11), S(5), [0.05, 0.04, 0.06], 1, 1.5);
  disc(S(hx - 16), S(hy - 13), S(2), [1, 1, 1], 0.9, 1);
  thickLine([[S(hx + 2), S(hy + 2)], [S(hx + 16), S(hy + 12)]], S(3.5), [0.7, 0.25, 0.05], 0.9);
  thickLine([[S(hx + 2), S(hy + 8)], [S(hx + 18), S(hy + 30)]], S(3), [0.95, 0.6, 0.3], 0.85);
  thickLine([[S(hx + 6), S(hy + 6)], [S(hx + 26), S(hy + 24)]], S(3), [0.95, 0.6, 0.3], 0.85);
  // Motion streaks trailing the body: pale curved speed lines.
  for (let k = 0; k < 7; k++) {
    const t = 0.15 + k * 0.1;
    const i = Math.round(t * N);
    const [x, y] = spine[i];
    const [nx, ny] = spine[Math.min(N, i + 3)];
    const [px, py] = spine[Math.max(0, i - 3)];
    const dx = nx - px, dy = ny - py, len = Math.hypot(dx, dy) || 1;
    const off = widthAt(t) + 26 + k * 6;
    const ax = x + (-dy / len) * off, ay = y + (dx / len) * off;
    thickLine(
      [[S(ax - dx * 0.55), S(ay - dy * 0.55)], [S(ax), S(ay)], [S(ax + dx * 0.35), S(ay + dy * 0.35)]],
      S(3.5), [0.75, 0.9, 1], 0.5 - k * 0.04,
    );
  }
  // Warm glow where the koi catches the moonlight.
  glow(S(hx), S(hy), S(190), [0.9, 0.75, 0.4], 0.22);
}

// ---------------------------------------------------------------------------
// Splash at the waterline: foam burst, droplets, droplets becoming stars.
// ---------------------------------------------------------------------------
function drawSplash(): void {
  const sx = 168, sy = 712;
  // Foam crown around the entry point.
  for (let i = 0; i < 46; i++) {
    const a = -Math.PI * (0.15 + rand() * 0.7);
    const r = 26 + rand() * 110;
    const x = sx + Math.cos(a) * r, y = sy + Math.sin(a) * r * 0.55;
    const rr = 3 + rand() * 11;
    disc(S(x), S(y), S(rr), [0.9, 0.96, 1], 0.55 + rand() * 0.4, 2);
  }
  // Droplets arcing upward along the koi's path toward the moon; the higher
  // they fly, the more they look like stars. Bias the spray up-right so it
  // follows the leap instead of fanning out to the left.
  for (let i = 0; i < 110; i++) {
    const t = rand();
    const a = -(0.45 + rand() * 1.15); // -26 deg .. -92 deg: up and to the right
    const dist = 60 + t * 460;
    const x = sx + Math.cos(a) * dist;
    const y = sy + Math.sin(a) * dist * 0.95 - t * 40;
    if (y < 60 || x < 10 || x > 1014) continue;
    const star = t > 0.45;
    const r = star ? 2 + rand() * 2.5 : 2.5 + rand() * 4;
    const bright = 0.6 + rand() * 0.4;
    if (star) {
      // Four-point star sparkle.
      const l = S(r * 3.2);
      thickLine([[S(x) - l, S(y)], [S(x) + l, S(y)]], S(1.4), [1, 0.95, 0.8], bright);
      thickLine([[S(x), S(y) - l], [S(x), S(y) + l]], S(1.4), [1, 0.95, 0.8], bright);
      disc(S(x), S(y), S(r), [1, 0.97, 0.85], bright, 1);
    } else {
      disc(S(x), S(y), S(r), [0.85, 0.93, 1], bright, 1.5);
    }
  }
}

// ---------------------------------------------------------------------------
// Title: TO THE MOON in glowing gold across the dark water.
// ---------------------------------------------------------------------------
function drawTitle(): void {
  const cx = 512, cy = 918, scale = 15;
  const gold: RGB = [1, 0.78, 0.25];
  // Wide soft halo first, then the crisp letters on top.
  for (let pass = 0; pass < 3; pass++) {
    drawText("TO THE MOON", cx, cy, scale + pass * 2.2, gold, 0.16);
  }
  drawText("TO THE MOON", cx, cy, scale, gold, 1);
  drawText("TO THE MOON", cx, cy, scale, [1, 0.95, 0.7], 0.35);
  // A thin gold underline shimmering on the water.
  thickLine([[S(268), S(958)], [S(756), S(958)]], S(2.5), [1, 0.8, 0.3], 0.7);
  thickLine([[S(330), S(968)], [S(694), S(968)]], S(1.8), [1, 0.85, 0.45], 0.45);
}

// ---------------------------------------------------------------------------
// Main: paint the scene, encode, write the file.
// ---------------------------------------------------------------------------
function main(): void {
  drawSky();
  drawStars();
  drawMoon();
  drawSea();
  drawKoi();
  drawSplash();
  drawTitle();
  const rgb = downsample();
  const png = encodePNG(rgb, W, H);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/entry.png`, png);
  console.log(`wrote ${outDir}/entry.png (${png.length} bytes)`);
}

main();
