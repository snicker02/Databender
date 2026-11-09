// Audacity-style databending: treat the byte region as a PCM signal.
// u8  = unsigned 8-bit (each byte one sample; BGR interleave → colour bleed)
// s16 = signed 16-bit little-endian (byte pairs; coarser, harsher artifacts)
import { clamp } from './util.js';

function read(b, s, e, fmt) {
  if (fmt === 's16') {
    const n = (e - s) >> 1, x = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = b[s + 2 * i] | (b[s + 2 * i + 1] << 8); if (v > 32767) v -= 65536; x[i] = v / 32768; }
    return x;
  }
  const n = e - s, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (b[s + i] - 128) / 128;
  return x;
}

function shape(v, mode) {
  if (mode === 'wrap') return v;                                   // wrapped on integer conversion
  if (mode === 'fold') { v = ((v + 1) % 4 + 4) % 4; return (v < 2 ? v : 4 - v) - 1; }
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function write(o, x, s, fmt, mode) {
  if (fmt === 's16') {
    for (let i = 0; i < x.length; i++) {
      let v = Math.round(shape(x[i], mode) * 32768);
      v = mode === 'wrap' ? v & 0xFFFF : clamp(v, -32768, 32767) & 0xFFFF;
      o[s + 2 * i] = v & 255; o[s + 2 * i + 1] = v >> 8;
    }
    return;
  }
  for (let i = 0; i < x.length; i++) {
    const v = Math.round(shape(x[i], mode) * 128) + 128;
    o[s + i] = mode === 'wrap' ? v & 255 : clamp(v, 0, 255);
  }
}

/** Run a sample-domain kernel over ctx.s..ctx.e. kernel(x, unitBytes) -> Float32Array */
function dsp(b, p, c, kernel) {
  const o = b.slice(), unit = p.fmt === 's16' ? 2 : 1;
  const x = read(b, c.s, c.e, p.fmt);
  if (!x.length) return o;
  write(o, kernel(x, unit), c.s, p.fmt, p.mode);
  return o;
}

/** Delay in bytes from "px" and "rows" params (rows use the BMP stride; JPEG falls back to W*3). */
const delayBytes = (p, c) => Math.max(1, (p.px | 0) * 3 + (p.rows | 0) * (c.stride || c.W * 3 || 1));

const FMT = { k: 'fmt', t: 'seg', label: 'Samples', opts: [['u8', 'u8'], ['s16', 's16']], def: 'u8', rnd: [0, 0.3] };
const MODE = { k: 'mode', t: 'seg', label: 'Overflow', opts: [['clip', 'Clip'], ['wrap', 'Wrap'], ['fold', 'Fold']], def: 'clip' };
const pct = v => v + '%';

export const AUDIO_EFFECTS = [
  { id: 'aecho', name: 'Echo', group: 'audio', kind: 'stream', hint: 'Feedback delay. Rows delay → vertical ghost copies; px → horizontal.',
    params: [{ k: 'px', t: 'range', label: 'Delay px', min: 0, max: 600, def: 40, rnd: [0, 300] },
      { k: 'rows', t: 'range', label: '+ rows', min: 0, max: 200, def: 0, rnd: [0, 60] },
      { k: 'decay', t: 'range', label: 'Decay', min: 0, max: 95, def: 55, fmt: pct, rnd: [30, 85] }, FMT, MODE],
    apply(b, p, c) {
      return dsp(b, p, c, (x, u) => {
        const D = Math.max(1, Math.round(delayBytes(p, c) / u)), g = p.decay / 100, y = new Float32Array(x.length);
        for (let i = 0; i < x.length; i++) y[i] = x[i] + (i >= D ? g * y[i - D] : 0);
        return y;
      });
    } },
  { id: 'areverb', name: 'Reverb', group: 'audio', kind: 'stream', hint: 'Four comb filters at co-prime delays — diffuse smear.',
    params: [{ k: 'px', t: 'range', label: 'Room px', min: 2, max: 400, def: 60, rnd: [10, 250] },
      { k: 'decay', t: 'range', label: 'Decay', min: 0, max: 95, def: 70, fmt: pct, rnd: [40, 90] },
      { k: 'mix', t: 'range', label: 'Wet', min: 0, max: 100, def: 50, fmt: pct, rnd: [30, 80] }, FMT, MODE],
    apply(b, p, c) {
      return dsp(b, p, c, (x, u) => {
        const base = Math.max(1, Math.round(p.px * 3 / u)), D = [1, 1.37, 1.93, 2.71].map(k => Math.max(1, Math.round(base * k)));
        const g = p.decay / 100, w = p.mix / 100, y = new Float32Array(x.length);
        for (let i = 0; i < x.length; i++) {
          let fb = 0; for (const d of D) if (i >= d) fb += y[i - d];
          y[i] = x[i] + g * fb * 0.25;
        }
        for (let i = 0; i < x.length; i++) y[i] = x[i] * (1 - w) + y[i] * w;
        return y;
      });
    } },
  { id: 'aamp', name: 'Amplify / distort', group: 'audio', kind: 'stream', hint: 'Gain around mid-grey. Wrap/Fold turn it into contour banding.',
    params: [{ k: 'gain', t: 'range', label: 'Gain', min: 0.1, max: 8, step: 0.05, def: 2, fmt: v => (+v).toFixed(2) + '×', rnd: [1.2, 5] }, FMT,
      { ...MODE, def: 'fold', rnd: undefined }],
    apply(b, p, c) { return dsp(b, p, c, x => { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * p.gain; return y; }); } },
  { id: 'alowpass', name: 'Low-pass', group: 'audio', kind: 'stream', hint: 'One-pole filter along the stream — channels bleed into each other.',
    params: [{ k: 'cut', t: 'range', label: 'Cutoff', min: 1, max: 100, def: 15, fmt: pct, rnd: [3, 40] }, FMT, MODE],
    apply(b, p, c) { return dsp(b, p, c, x => { const a = p.cut / 100, y = new Float32Array(x.length); let z = x[0]; for (let i = 0; i < x.length; i++) { z += a * (x[i] - z); y[i] = z; } return y; }); } },
  { id: 'ahighpass', name: 'High-pass', group: 'audio', kind: 'stream', hint: 'Keeps only the jitter — etched, edge-like glitch.',
    params: [{ k: 'cut', t: 'range', label: 'Cutoff', min: 1, max: 100, def: 10, fmt: pct, rnd: [2, 30] },
      { k: 'gain', t: 'range', label: 'Gain', min: 0.5, max: 6, step: 0.1, def: 2, fmt: v => (+v).toFixed(1) + '×', rnd: [1, 4] }, FMT, MODE],
    apply(b, p, c) { return dsp(b, p, c, x => { const a = p.cut / 100, y = new Float32Array(x.length); let z = x[0]; for (let i = 0; i < x.length; i++) { z += a * (x[i] - z); y[i] = (x[i] - z) * p.gain; } return y; }); } },
  { id: 'atremolo', name: 'Tremolo', group: 'audio', kind: 'stream', hint: 'Amplitude LFO over the stream — diagonal fade bands.',
    params: [{ k: 'depth', t: 'range', label: 'Depth', min: 0, max: 100, def: 70, fmt: pct, rnd: [40, 100] },
      { k: 'px', t: 'range', label: 'Period px', min: 2, max: 2000, def: 250, rnd: [20, 1200] }, FMT, MODE],
    apply(b, p, c) {
      return dsp(b, p, c, (x, u) => {
        const per = Math.max(2, p.px * 3 / u), d = p.depth / 100, y = new Float32Array(x.length);
        for (let i = 0; i < x.length; i++) y[i] = x[i] * (1 - d * (0.5 + 0.5 * Math.sin(2 * Math.PI * i / per)));
        return y;
      });
    } },
  { id: 'adecimate', name: 'Decimate', group: 'audio', kind: 'stream', hint: 'Sample-and-hold — stair-step colour bars.',
    params: [{ k: 'n', t: 'range', label: 'Hold', min: 2, max: 64, def: 6, rnd: [2, 24] }, FMT, MODE],
    apply(b, p, c) { return dsp(b, p, c, x => { const n = Math.max(2, p.n | 0), y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i - (i % n)]; return y; }); } },
];
