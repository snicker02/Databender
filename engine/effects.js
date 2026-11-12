// Effect registry. Each effect is declared once; the panel UI, the stack,
// random-corrupt and recipe files are all generated from these definitions.
//
//   apply(bytes, params, ctx) -> new Uint8Array   (never mutate `bytes`)
//
// ctx: { s, e }        editable byte region (header protection / selection band applied)
//      { W, H, off, stride }  BMP pixel geometry of the source (pixel effects)
//      { r0, r1 }       BMP storage rows to touch (bottom-up), selection band or full
//      rng()            per-step seeded RNG
//      fmt              'bmp' | 'jpeg'
//
// kind: 'stream' works on any container; 'pixel' needs BMP pixel alignment.
// len:  true if the effect can change file length (selection then uses a row band).
import { clamp, keyToBytes, parseHex, lum } from './util.js';
import { AUDIO_EFFECTS } from './audio.js';
import { ART_EFFECTS } from './art.js';

export const GROUPS = [
  ['bytes', 'Bytes', 'noise · bit ops · math'],
  ['displace', 'Displace', 'shift · sort · wave'],
  ['channels', 'Channels', 'bgr targeting'],
  ['sort', 'Pixel sort', 'keeps colour'],
  ['artcolour', 'Art · colour', 'gradient map · duotone · curves'],
  ['artform', 'Art · form', 'kaleido · halftone · shatter'],
  ['find', 'Find / replace', 'byte patterns'],
  ['struct', 'Structural', 'shear · echo · move'],
  ['chunk', 'Chunk (manual)', 'move · rotate · carve'],
  ['audio', 'Audio', 'audacity-style dsp'],
];

const pct = v => v + '%';
const f2 = v => (+v).toFixed(2);

// ---------- pixel helpers ----------
function rotRow(b, base, W, k, len) {
  k = ((k % W) + W) % W; if (!k || base + W * 3 > len) return;
  const tmp = new Uint8Array(W * 3);
  for (let x = 0; x < W; x++) { const q = ((x + k) % W) * 3; tmp[x * 3] = b[base + q]; tmp[x * 3 + 1] = b[base + q + 1]; tmp[x * 3 + 2] = b[base + q + 2]; }
  b.set(tmp, base);
}
function swapBlock(b, off, stride, x0, y0, x1, y1, bs, len) {
  for (let dy = 0; dy < bs; dy++) {
    const r0 = off + (y0 + dy) * stride + x0 * 3, r1 = off + (y1 + dy) * stride + x1 * 3;
    for (let dx = 0; dx < bs * 3; dx++) { const p = r0 + dx, q = r1 + dx; if (p < len && q < len) { const t = b[p]; b[p] = b[q]; b[q] = t; } }
  }
}
function sortPixelLine(b, start, step, count, t, len) {
  let i = 0;
  while (i < count) {
    const p = start + i * step;
    if (p + 2 >= len) break;
    if (lum(b[p + 2], b[p + 1], b[p]) < t) { i++; continue; }
    let j = i; const seg = [];
    while (j < count) {
      const q = start + j * step; if (q + 2 >= len) break;
      const l = lum(b[q + 2], b[q + 1], b[q]);
      if (l < t) break;
      seg.push([l, b[q], b[q + 1], b[q + 2]]); j++;
    }
    seg.sort((a, c) => a[0] - c[0]);
    for (let k = 0; k < seg.length; k++) { const w = start + (i + k) * step; if (w + 2 < len) { b[w] = seg[k][1]; b[w + 1] = seg[k][2]; b[w + 2] = seg[k][3]; } }
    i = j === i ? i + 1 : j;
  }
}
/** Iterate whole pixels of rows r0..r1 (padding-correct). fn(p, x, row). */
function eachPixel(c, len, fn) {
  for (let r = c.r0; r < c.r1; r++) {
    const base = c.off + r * c.stride; if (base + c.W * 3 > len) break;
    for (let x = 0; x < c.W; x++) fn(base + x * 3, x, r);
  }
}
function chunkBounds(p, c) {
  const span = Math.max(1, c.e - c.s);
  const ss = clamp(c.s + Math.floor((p.pos / 100) * span), c.s, Math.max(c.s, c.e - 1));
  let sl = Math.max(1, Math.floor((p.size / 100) * span)); sl = Math.max(1, Math.min(sl, c.e - ss));
  const dd = clamp(c.s + Math.floor((p.dst / 100) * span), c.s, c.e);
  return { ss, sl, dd };
}
const chunkParams = [
  { k: 'pos', t: 'range', label: 'Position', min: 0, max: 100, def: 25, fmt: pct },
  { k: 'size', t: 'range', label: 'Size', min: 1, max: 40, def: 8, fmt: pct },
  { k: 'dst', t: 'range', label: 'Destination', min: 0, max: 100, def: 60, fmt: pct },
];
const chunkReadout = (p, c) => { const { ss, sl, dd } = chunkBounds(p, c); return 'src 0x' + ss.toString(16) + ' · ' + sl.toLocaleString() + 'B → 0x' + dd.toString(16); };
const SWAP_PERMS = { rb: [2, 1, 0], rg: [0, 2, 1], gb: [1, 0, 2], rot: [1, 2, 0] };
const intensity = { k: 'inten', t: 'range', label: 'Intensity', min: 1, max: 100, def: 50, fmt: pct, rnd: [20, 90] };

const LIST = [
  // ================= BYTES =================
  { id: 'noise', name: 'Noise', group: 'bytes', kind: 'stream', hint: 'Replaces a fraction of bytes with random values.',
    params: [{ k: 'amt', t: 'range', label: 'Density', min: 0, max: 100, def: 3, fmt: pct, rnd: [1, 8] }],
    apply(b, p, c) { const o = b.slice(), a = p.amt / 100, r = c.rng; for (let i = c.s; i < c.e; i++) if (r() < a) o[i] = (r() * 256) | 0; return o; } },
  { id: 'bitrot', name: 'Rotate bits', group: 'bytes', kind: 'stream',
    params: [{ k: 'n', t: 'range', label: 'Bit rotate', min: 1, max: 7, def: 1 }],
    apply(b, p, c) { const o = b.slice(), n = p.n | 0; for (let i = c.s; i < c.e; i++) { const v = o[i]; o[i] = ((v << n) | (v >>> (8 - n))) & 255; } return o; } },
  { id: 'xor', name: 'XOR', group: 'bytes', kind: 'stream', hint: 'Hex pairs are read as bytes; other text is used verbatim as the key.',
    params: [{ k: 'key', t: 'text', label: 'Key (hex or text)', def: 'ff', ph: 'ff · a4c1 · glitch' }],
    apply(b, p, c) { const key = keyToBytes(p.key), o = b.slice(); for (let i = c.s, k = 0; i < c.e; i++, k++) o[i] ^= key[k % key.length]; return o; } },
  { id: 'invert', name: 'Invert (negative)', group: 'bytes', kind: 'stream', params: [],
    apply(b, p, c) { const o = b.slice(); for (let i = c.s; i < c.e; i++) o[i] = 255 - o[i]; return o; } },
  { id: 'bitcrush', name: 'Bit crush', group: 'bytes', kind: 'stream',
    params: [{ k: 'bits', t: 'range', label: 'Keep bits', min: 1, max: 7, def: 3, rnd: [2, 5] }],
    apply(b, p, c) { const mask = (0xFF << (8 - p.bits)) & 0xFF, o = b.slice(); for (let i = c.s; i < c.e; i++) o[i] &= mask; return o; } },
  { id: 'byteadd', name: 'Byte add / cycle', group: 'bytes', kind: 'stream', hint: 'Wrapping byte math — solarizes and cycles colours.',
    params: [{ k: 'amt', t: 'range', label: 'Add', min: -255, max: 255, def: 64, rnd: [-200, 200] }],
    apply(b, p, c) { const o = b.slice(), a = p.amt | 0; for (let i = c.s; i < c.e; i++) o[i] = (o[i] + a) & 255; return o; } },
  { id: 'dither', name: 'Ordered dither', group: 'bytes', kind: 'pixel', hint: 'Bayer posterize — retro halftone banding.',
    params: [{ k: 'levels', t: 'range', label: 'Levels', min: 2, max: 8, def: 4 }],
    apply(b, p, c) {
      const o = b.slice(), M = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], step = 255 / (Math.max(2, p.levels) - 1);
      eachPixel(c, o.length, (q, x, r) => { const thr = (M[r & 3][x & 3] / 16 - 0.5) * step; for (let k = 0; k < 3; k++) { const v = Math.round((o[q + k] + thr) / step) * step; o[q + k] = v < 0 ? 0 : v > 255 ? 255 : v; } });
      return o;
    } },
  { id: 'emboss', name: 'Emboss', group: 'bytes', kind: 'pixel', random: true, params: [],
    apply(b, p, c) {
      const o = b.slice();
      eachPixel(c, o.length, (q, x, r) => { const qx = x > 0 ? x - 1 : x, qr = r > 0 ? r - 1 : r, s = c.off + qr * c.stride + qx * 3; for (let k = 0; k < 3; k++) { const v = 128 + (b[q + k] - b[s + k]); o[q + k] = v < 0 ? 0 : v > 255 ? 255 : v; } });
      return o;
    } },
  { id: 'sinebands', name: 'Sine bands', group: 'bytes', kind: 'pixel', hint: 'Position-modulated values — rolling colour interference.',
    params: [{ k: 'amp', t: 'range', label: 'Amp', min: 0, max: 128, def: 40, rnd: [15, 95] },
      { k: 'freq', t: 'range', label: 'Freq', min: 0.01, max: 1.5, step: 0.01, def: 0.2, fmt: f2, rnd: [0.05, 0.85] }],
    apply(b, p, c) {
      const o = b.slice();
      eachPixel(c, o.length, (q, x, r) => { const ph = p.freq * (x + r); o[q] = (o[q] + Math.round(p.amp * Math.sin(ph + 4.188))) & 255; o[q + 1] = (o[q + 1] + Math.round(p.amp * Math.sin(ph + 2.094))) & 255; o[q + 2] = (o[q + 2] + Math.round(p.amp * Math.sin(ph))) & 255; });
      return o;
    } },

  // ================= DISPLACE =================
  { id: 'shift', name: 'Byte shift', group: 'displace', kind: 'stream', hint: 'Rotates the byte stream — cycles BGR and drags the frame.',
    params: [{ k: 'n', t: 'range', label: 'Shift', min: 1, max: 30, def: 1, rnd: [1, 12] }],
    apply(b, p, c) { const o = b.slice(), L = c.e - c.s; if (L <= 0) return o; const n = p.n | 0; for (let i = 0; i < L; i++) o[c.s + i] = b[c.s + ((i + n) % L)]; return o; } },
  { id: 'sort', name: 'Sort bytes', group: 'displace', kind: 'stream', hint: 'Raw byte sort desaturates toward gray — use Pixel sort for colour.',
    params: [{ k: 'win', t: 'range', label: 'Window', min: 4, max: 1024, step: 4, def: 64, rnd: [8, 512] }],
    apply(b, p, c) { const o = b.slice(), w = Math.max(1, p.win | 0); for (let i = c.s; i < c.e; i += w) o.subarray(i, Math.min(i + w, c.e)).sort(); return o; } },
  { id: 'reverse', name: 'Reverse region', group: 'displace', kind: 'stream', random: false, params: [],
    apply(b, p, c) { const o = b.slice(); o.subarray(c.s, c.e).reverse(); return o; } },
  { id: 'wave', name: 'Wave warp', group: 'displace', kind: 'pixel', hint: 'Smooth sine displacement per row.',
    params: [{ k: 'amp', t: 'range', label: 'Amp', min: 0, max: 60, def: 8, rnd: [3, 33] },
      { k: 'freq', t: 'range', label: 'Freq', min: 0.01, max: 2, step: 0.01, def: 0.3, fmt: f2, rnd: [0.05, 1.25] }],
    apply(b, p, c) { const o = b.slice(); for (let r = c.r0; r < c.r1; r++) rotRow(o, c.off + r * c.stride, c.W, Math.round(p.amp * Math.sin(p.freq * r)), o.length); return o; } },
  { id: 'datasmear', name: 'Data smear', group: 'displace', kind: 'pixel', hint: 'Holds and repeats pixels — horizontal melt streaks.',
    params: [{ k: 'amt', t: 'range', label: 'Smear', min: 0, max: 100, def: 50, fmt: pct, rnd: [30, 90] }],
    apply(b, p, c) {
      const o = b.slice(), a = p.amt / 100, r = c.rng;
      for (let y = c.r0; y < c.r1; y++) {
        const base = c.off + y * c.stride; if (base + c.W * 3 > o.length) break;
        let hold = -1, run = 0;
        for (let x = 0; x < c.W; x++) { const q = base + x * 3; if (run > 0 && hold >= 0) { o[q] = o[hold]; o[q + 1] = o[hold + 1]; o[q + 2] = o[hold + 2]; run--; } else if (r() < a * 0.35) { hold = q; run = 1 + Math.floor(r() * c.W * 0.3 * a); } }
      }
      return o;
    } },
  { id: 'interlace', name: 'Interlace tear', group: 'displace', kind: 'pixel', hint: 'Even/odd rows pushed opposite ways — VHS tearing.',
    params: [{ k: 'n', t: 'range', label: 'Offset px', min: 0, max: 40, def: 6, rnd: [2, 22] }],
    apply(b, p, c) { const o = b.slice(), n = p.n | 0; if (n) for (let r = c.r0; r < c.r1; r++) rotRow(o, c.off + r * c.stride, c.W, (r & 1) ? -n : n, o.length); return o; } },
  { id: 'ghost', name: 'Ghost / trail', group: 'displace', kind: 'pixel', hint: 'Blends an offset copy over the image.',
    params: [{ k: 'dx', t: 'range', label: 'Shift px', min: 1, max: 80, def: 10, rnd: [3, 43] },
      { k: 'op', t: 'range', label: 'Opacity', min: 0, max: 100, def: 50, fmt: pct, rnd: [30, 80] }],
    apply(b, p, c) {
      const o = b.slice(), a = p.op / 100, inv = 1 - a, dx = p.dx | 0;
      eachPixel(c, o.length, (q, x) => { if (x - dx < 0) return; const s = q - dx * 3; o[q] = (b[q] * inv + b[s] * a) | 0; o[q + 1] = (b[q + 1] * inv + b[s + 1] * a) | 0; o[q + 2] = (b[q + 2] * inv + b[s + 2] * a) | 0; });
      return o;
    } },

  // ================= CHANNELS =================
  { id: 'channel', name: 'Corrupt channel', group: 'channels', kind: 'pixel', hint: 'Randomizes one colour channel only (padding-aligned).',
    params: [{ k: 'ch', t: 'seg', label: 'Target', opts: [[0, 'Blue'], [1, 'Green'], [2, 'Red']], def: 2 },
      { k: 'amt', t: 'range', label: 'Amount', min: 0, max: 100, def: 40, fmt: pct, rnd: [10, 80] }],
    apply(b, p, c) { const o = b.slice(), a = p.amt / 100, r = c.rng, ch = p.ch | 0; eachPixel(c, o.length, q => { if (r() < a) o[q + ch] = (r() * 256) | 0; }); return o; } },
  { id: 'rgbshift', name: 'RGB split', group: 'channels', kind: 'pixel', hint: 'Offsets one channel — chromatic aberration.',
    params: [{ k: 'ch', t: 'seg', label: 'Channel', opts: [[2, 'Red'], [1, 'Green'], [0, 'Blue']], def: 2 },
      { k: 'px', t: 'range', label: 'Shift px', min: -40, max: 40, def: 6, rnd: [-20, 20] }],
    apply(b, p, c) { const o = b.slice(), ch = p.ch | 0, px = p.px | 0; eachPixel(c, o.length, (q, x) => { const sx = x + px; o[q + ch] = sx >= 0 && sx < c.W ? b[q + px * 3 + ch] : 0; }); return o; } },
  { id: 'channelswap', name: 'Channel swap', group: 'channels', kind: 'pixel',
    params: [{ k: 'mode', t: 'select', label: 'Swap', opts: [['rb', 'R ↔ B'], ['rg', 'R ↔ G'], ['gb', 'G ↔ B'], ['rot', 'Rotate R→G→B']], def: 'rb' }],
    apply(b, p, c) { const o = b.slice(), m = SWAP_PERMS[p.mode] || SWAP_PERMS.rb; eachPixel(c, o.length, q => { const s = [b[q], b[q + 1], b[q + 2]]; o[q] = s[m[0]]; o[q + 1] = s[m[1]]; o[q + 2] = s[m[2]]; }); return o; } },
  { id: 'huerotate', name: 'Hue rotate', group: 'channels', kind: 'pixel', hint: 'Continuous colour rotation — keeps structure.',
    params: [{ k: 'deg', t: 'range', label: 'Degrees', min: 0, max: 360, def: 120, rnd: [0, 360] }],
    apply(b, p, c) {
      const a = p.deg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
      const m = [0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928,
        0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.140, 0.072 - cs * 0.072 - sn * 0.283,
        0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072];
      const o = b.slice(), cl = v => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
      eachPixel(c, o.length, q => { const B = b[q], G = b[q + 1], R = b[q + 2]; o[q + 2] = cl(R * m[0] + G * m[1] + B * m[2]); o[q + 1] = cl(R * m[3] + G * m[4] + B * m[5]); o[q] = cl(R * m[6] + G * m[7] + B * m[8]); });
      return o;
    } },

  // ================= PIXEL SORT =================
  { id: 'pixelsort', name: 'Pixel sort', group: 'sort', kind: 'pixel', hint: 'Adapts to the image’s own brightness range, so it works on dark shots too.',
    params: [{ k: 'amt', t: 'range', label: 'Amount', min: 0, max: 100, def: 60, fmt: pct, rnd: [40, 100] },
      { k: 'dir', t: 'seg', label: 'Direction', opts: [[0, 'Horizontal'], [1, 'Vertical']], def: 0, rnd: [0, 0.3] }],
    apply(b, p, c) {
      const o = b.slice(), len = o.length; let lo = 255, hi = 0;
      eachPixel(c, len, q => { const l = lum(o[q + 2], o[q + 1], o[q]); if (l < lo) lo = l; if (l > hi) hi = l; });
      if (hi <= lo) return o;
      const cut = hi - (p.amt / 100) * (hi - lo);
      if (+p.dir === 1) { for (let x = 0; x < c.W; x++) sortPixelLine(o, c.off + c.r0 * c.stride + x * 3, c.stride, c.r1 - c.r0, cut, len); }
      else { for (let r = c.r0; r < c.r1; r++) sortPixelLine(o, c.off + r * c.stride, 3, c.W, cut, len); }
      return o;
    } },

  // ================= FIND / REPLACE =================
  { id: 'findrepl', name: 'Find / replace', group: 'find', kind: 'stream', len: true, hint: 'Unequal lengths cascade a diagonal shear through the frame.',
    params: [{ k: 'find', t: 'text', label: 'Find (hex)', def: '00', ph: 'ff00' }, { k: 'repl', t: 'text', label: 'With (hex)', def: 'ff', ph: 'ff' }],
    apply(b, p, c) {
      const find = parseHex(p.find), repl = parseHex(p.repl);
      if (!find.length) return b.slice();
      const out = new Uint8Array(b.length + Math.ceil((c.e - c.s) / find.length) * Math.max(0, repl.length - find.length) + 8);
      let w = 0; out.set(b.subarray(0, c.s), 0); w = c.s;
      let i = c.s;
      while (i < c.e) {
        let m = i + find.length <= c.e;
        if (m) for (let k = 0; k < find.length; k++) if (b[i + k] !== find[k]) { m = false; break; }
        if (m) { for (let k = 0; k < repl.length; k++) out[w++] = repl[k]; i += find.length; } else out[w++] = b[i++];
      }
      out.set(b.subarray(c.e), w); w += b.length - c.e;
      return out.slice(0, w);
    } },

  // ================= STRUCTURAL =================
  { id: 'echo', name: 'Chunk echo', group: 'struct', kind: 'stream', len: true, params: [intensity],
    apply(b, p, c) {
      const t = p.inten / 100, r = c.rng, span = c.e - c.s; if (span < 8) return b.slice();
      const chunk = Math.max(3, Math.floor(span * 0.01 * (0.4 + t))), cs = c.s + Math.floor(r() * (span - chunk)), reps = 1 + Math.floor(r() * (1 + t * 4));
      const out = new Uint8Array(b.length + chunk * reps);
      out.set(b.subarray(0, cs + chunk), 0);
      for (let n = 0; n < reps; n++) out.set(b.subarray(cs, cs + chunk), cs + chunk * (n + 1));
      out.set(b.subarray(cs + chunk), cs + chunk * (reps + 1));
      return out;
    } },
  { id: 'move', name: 'Chunk move', group: 'struct', kind: 'stream', len: true, random: false, params: [intensity],
    apply(b, p, c) {
      const t = p.inten / 100, r = c.rng, span = c.e - c.s; if (span < 16) return b.slice();
      const chunk = Math.max(3, Math.floor(span * 0.02 * (0.4 + t))), cs = c.s + Math.floor(r() * (span - chunk)), piece = b.slice(cs, cs + chunk);
      const rem = new Uint8Array(b.length - chunk); rem.set(b.subarray(0, cs), 0); rem.set(b.subarray(cs + chunk), cs);
      const dst = clamp(c.s + Math.floor(r() * (c.e - chunk - c.s)), c.s, rem.length);
      const out = new Uint8Array(b.length); out.set(rem.subarray(0, dst), 0); out.set(piece, dst); out.set(rem.subarray(dst), dst + chunk);
      return out;
    } },
  { id: 'carve', name: 'Carve bytes', group: 'struct', kind: 'stream', len: true, random: false, params: [intensity],
    apply(b, p, c) {
      const t = p.inten / 100, r = c.rng, span = c.e - c.s; if (span < 16) return b.slice();
      const chunk = Math.max(1, Math.floor(span * 0.02 * t)), cs = c.s + Math.floor(r() * (span - chunk));
      const out = new Uint8Array(b.length - chunk); out.set(b.subarray(0, cs), 0); out.set(b.subarray(cs + chunk), cs);
      return out;
    } },
  { id: 'rowshift', name: 'Row jitter', group: 'struct', kind: 'pixel', len: true, hint: 'Injects random bytes after each row — cumulative shear.', params: [intensity],
    apply(b, p, c) {
      const t = p.inten / 100, r = c.rng, maxJit = Math.max(1, Math.floor(c.stride * 0.15 * t));
      const parts = [b.subarray(0, c.off + c.r0 * c.stride)]; let total = parts[0].length;
      for (let y = c.r0; y < c.r1; y++) {
        const a = c.off + y * c.stride; if (a >= b.length) break;
        const row = b.subarray(a, Math.min(b.length, a + c.stride)); parts.push(row); total += row.length;
        const j = Math.floor(r() * maxJit); if (j) { const n = new Uint8Array(j); for (let k = 0; k < j; k++) n[k] = (r() * 256) | 0; parts.push(n); total += j; }
      }
      const tailStart = Math.min(b.length, c.off + c.r1 * c.stride); parts.push(b.subarray(tailStart)); total += b.length - tailStart;
      const out = new Uint8Array(total); let w = 0; for (const s of parts) { out.set(s, w); w += s.length; }
      return out;
    } },
  { id: 'rowstutter', name: 'Row stutter', group: 'struct', kind: 'pixel', hint: 'Datamosh freeze — a short slice repeats down a band.', params: [intensity],
    apply(b, p, c) {
      const t = p.inten / 100, r = c.rng, o = b.slice(), len = o.length, H = c.r1 - c.r0; if (H < 3) return o;
      const blk = Math.max(1, Math.floor(1 + r() * 6)), band = Math.max(blk + 1, Math.floor(H * (0.15 + 0.5 * t)));
      const start = c.r0 + Math.floor(r() * Math.max(1, H - blk - band));
      let dst = start + blk; const end = Math.min(c.r1, dst + band);
      for (let k = 0; dst < end; dst++, k++) { const sB = c.off + (start + (k % blk)) * c.stride, dB = c.off + dst * c.stride; for (let x = 0; x < c.stride; x++) if (dB + x < len && sB + x < len) o[dB + x] = o[sB + x]; }
      return o;
    } },
  { id: 'sliceshuffle', name: 'Slice shuffle', group: 'struct', kind: 'pixel', params: [intensity],
    apply(b, p, c) {
      const t = p.inten / 100, r = c.rng, o = b.slice(), H = c.r1 - c.r0;
      const n = Math.max(2, Math.floor(3 + r() * 20 * t)), bandH = Math.ceil(H / n);
      for (let i = 0; i < n; i++) { const y0 = c.r0 + i * bandH, y1 = Math.min(c.r1, y0 + bandH), sh = Math.round((r() * 2 - 1) * c.W * 0.5 * t); if (sh) for (let y = y0; y < y1; y++) rotRow(o, c.off + y * c.stride, c.W, sh, o.length); }
      return o;
    } },
  { id: 'blockshuffle', name: 'Block shuffle', group: 'struct', kind: 'pixel', hint: 'Swaps square blocks — mosaic.', params: [intensity],
    apply(b, p, c) {
      const t = p.inten / 100, r = c.rng, o = b.slice(), H = c.r1 - c.r0;
      const bs = Math.max(4, Math.floor(8 + r() * 40)), cols = Math.floor(c.W / bs), rows = Math.floor(H / bs);
      if (cols < 2 || rows < 2) return o;
      const swaps = Math.floor(cols * rows * 0.5 * t) + 1;
      for (let n = 0; n < swaps; n++) { const ax = Math.floor(r() * cols), ay = Math.floor(r() * rows), bx = Math.floor(r() * cols), by = Math.floor(r() * rows); if (ax !== bx || ay !== by) swapBlock(o, c.off, c.stride, ax * bs, c.r0 + ay * bs, bx * bs, c.r0 + by * bs, bs, o.length); }
      return o;
    } },

  // ================= CHUNK (manual) =================
  { id: 'chunkmove', name: 'Chunk: move', group: 'chunk', kind: 'stream', len: true, random: false, params: chunkParams, readout: chunkReadout,
    apply(b, p, c) {
      const { ss, sl, dd } = chunkBounds(p, c), piece = b.slice(ss, ss + sl);
      const rem = new Uint8Array(b.length - sl); rem.set(b.subarray(0, ss), 0); rem.set(b.subarray(ss + sl), ss);
      const d = clamp(dd <= ss ? dd : dd >= ss + sl ? dd - sl : ss, 0, rem.length);
      const out = new Uint8Array(b.length); out.set(rem.subarray(0, d), 0); out.set(piece, d); out.set(rem.subarray(d), d + sl);
      return out;
    } },
  { id: 'chunkecho', name: 'Chunk: echo', group: 'chunk', kind: 'stream', len: true, random: false, params: chunkParams, readout: chunkReadout,
    apply(b, p, c) { const { ss, sl, dd } = chunkBounds(p, c), d = clamp(dd, 0, b.length); const out = new Uint8Array(b.length + sl); out.set(b.subarray(0, d), 0); out.set(b.subarray(ss, ss + sl), d); out.set(b.subarray(d), d + sl); return out; } },
  { id: 'chunkcarve', name: 'Chunk: carve', group: 'chunk', kind: 'stream', len: true, random: false, params: chunkParams.slice(0, 2), readout: chunkReadout,
    apply(b, p, c) { const { ss, sl } = chunkBounds({ ...p, dst: 0 }, c); const out = new Uint8Array(b.length - sl); out.set(b.subarray(0, ss), 0); out.set(b.subarray(ss + sl), ss); return out; } },
  { id: 'chunkrotate', name: 'Chunk: rotate', group: 'chunk', kind: 'stream', random: false,
    params: [...chunkParams.slice(0, 2), { k: 'rot', t: 'range', label: 'Rotate', min: -100, max: 100, def: 25, fmt: pct }], readout: chunkReadout,
    apply(b, p, c) { const { ss, sl } = chunkBounds({ ...p, dst: 0 }, c), o = b.slice(); let k = Math.round((p.rot / 100) * sl); k = ((k % sl) + sl) % sl; if (k) for (let i = 0; i < sl; i++) o[ss + i] = b[ss + ((i + k) % sl)]; return o; } },
  { id: 'chunkreverse', name: 'Chunk: reverse', group: 'chunk', kind: 'stream', random: false, params: chunkParams.slice(0, 2), readout: chunkReadout,
    apply(b, p, c) { const { ss, sl } = chunkBounds({ ...p, dst: 0 }, c), o = b.slice(); o.subarray(ss, ss + sl).reverse(); return o; } },

  ...ART_EFFECTS,
  ...AUDIO_EFFECTS,

  // ================= HIDDEN =================
  // Hand edits from the hex view. Absolute offset; ignores region/selection.
  { id: 'poke', name: 'Hex edit', group: null, kind: 'stream', raw: true, random: false,
    params: [{ k: 'offset', t: 'num', def: 0 }, { k: 'value', t: 'num', def: 0 }],
    apply(b, p) { const o = b.slice(); if (p.offset >= 0 && p.offset < o.length) o[p.offset] = p.value & 255; return o; } },
];

export const EFFECTS = Object.fromEntries(LIST.map(e => [e.id, e]));
export const EFFECT_LIST = LIST;

export function defaultParams(def) {
  const o = {}; for (const q of def.params) o[q.k] = q.def; return o;
}

/** Random params inside each param's `rnd` window (or its full range). */
export function randomParams(def, r) {
  const o = defaultParams(def);
  for (const q of def.params) {
    if (q.t === 'range') {
      const [lo, hi] = q.rnd || [q.min, q.max], st = q.step || 1;
      o[q.k] = +clamp(Math.round((lo + r() * (hi - lo)) / st) * st, q.min, q.max).toFixed(4);
    } else if (q.t === 'seg' || q.t === 'select') {
      if (q.rnd) o[q.k] = r() < q.rnd[1] ? q.opts[1][0] : q.opts[0][0];       // weighted two-option
      else o[q.k] = q.opts[Math.floor(r() * q.opts.length)][0];
    }
  }
  return o;
}

/** Short human summary of a step's params for the stack list. */
export function summarize(def, p) {
  return def.params.map(q => {
    const v = p[q.k];
    if (q.t === 'seg' || q.t === 'select') { const f = q.opts.find(o => String(o[0]) === String(v)); return f ? f[1] : v; }
    if (q.t === 'text') return '"' + String(v).slice(0, 10) + '"';
    if (q.t === 'num') return q.k === 'offset' ? '@0x' + (+v).toString(16) : '=' + (+v).toString(16).padStart(2, '0');
    return q.fmt ? q.fmt(v) : v;
  }).join(' · ');
}
