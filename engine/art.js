// "Artsy" pixel effects. Each works on a display-order RGB copy of the whole
// BMP (y down), so geometric effects can sample anywhere; only storage rows
// r0..r1 are written back, and the pipeline composites selections exactly.

const pct = v => v + '%';
const deg = v => v + '°';

// ---------- image bridge ----------
function readImg(b, c) {
  const W = c.W, H = c.H, px = new Uint8ClampedArray(W * H * 3), len = b.length;
  for (let y = 0; y < H; y++) {
    const base = c.off + (H - 1 - y) * c.stride;
    for (let x = 0; x < W; x++) {
      const p = base + x * 3, q = (y * W + x) * 3;
      if (p + 2 < len) { px[q] = b[p + 2]; px[q + 1] = b[p + 1]; px[q + 2] = b[p]; }
    }
  }
  return px;
}
function writeImg(o, c, px) {
  const W = c.W, H = c.H, len = o.length;
  for (let r = c.r0; r < c.r1; r++) {
    const y = H - 1 - r, base = c.off + r * c.stride;
    for (let x = 0; x < W; x++) {
      const p = base + x * 3; if (p + 2 >= len) return;
      const q = (y * W + x) * 3; o[p] = px[q + 2]; o[p + 1] = px[q + 1]; o[p + 2] = px[q];
    }
  }
}
/** Wrap an image-space kernel fn(src, p, c, W, H) -> dst into an effect apply(). */
const art = fn => function (b, p, c) {
  if (c.W < 2 || c.H < 2) return b.slice();
  const o = b.slice();
  writeImg(o, c, fn(readImg(b, c), p, c, c.W, c.H));
  return o;
};

const lumAt = (s, i) => 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
/** Mirrored repeat — sampling outside the frame reflects instead of clamping. */
function mir(v, n) {
  if (n <= 1) return 0;
  const per = 2 * n - 2; let k = Math.round(v) % per; if (k < 0) k += per;
  return k < n ? k : per - k;
}
const cl = (v, n) => (v < 0 ? 0 : v > n - 1 ? n - 1 : Math.round(v));
function copyPx(d, i, s, j) { d[i] = s[j]; d[i + 1] = s[j + 1]; d[i + 2] = s[j + 2]; }
function hsl(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

// ---------- palettes ----------
export const PALETTES = {
  synthwave: ['0d0221', '261447', '6a0d83', 'ce4993', 'ee5d6c', 'fb9062', 'eeaf61'],
  vapor: ['2b0548', 'b967ff', 'ff71ce', '01cdfe', '05ffa1', 'fffb96'],
  thermal: ['000000', '1f0c48', '6a00a8', 'c42a6a', 'f57d15', 'fbd73f', 'ffffff'],
  ember: ['000000', '3d0000', '950101', 'ff2a00', 'ff7b00', 'ffd000', 'fff6d0'],
  cyanotype: ['0b1f3a', '123e6b', '2f6fa6', '8fb8d8', 'e8f1f8'],
  ice: ['000814', '001d3d', '003566', '4cc9f0', 'caf0f8', 'ffffff'],
  sepia: ['2b1d0e', '704214', 'b08850', 'e8d3a8', 'fff6e0'],
  acid: ['000000', '39ff14', 'ff00ff', '00ffff', 'ffff00'],
  infrared: ['14001f', '7a0177', 'ff2a6d', 'ffd319', 'fff8f0'],
  gameboy: ['0f380f', '306230', '8bac0f', '9bbc0f'],
  bruise: ['0b0b0b', '2d1b4e', '5b2a86', '9a348e', 'd8b4a0', 'f2e8cf'],
  rainbow: ['ff0000', 'ffff00', '00ff00', '00ffff', '0000ff', 'ff00ff', 'ff0000'],
};
function buildLut(stops) {
  const cs = stops.map(h => { const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; });
  const o = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (cs.length - 1), k = Math.min(cs.length - 2, Math.floor(t)), f = t - k;
    for (let ch = 0; ch < 3; ch++) o[i * 3 + ch] = cs[k][ch] + (cs[k + 1][ch] - cs[k][ch]) * f;
  }
  return o;
}
const LUTS = Object.fromEntries(Object.entries(PALETTES).map(([k, v]) => [k, buildLut(v)]));
const PAL_OPTS = Object.keys(PALETTES).map(k => [k, k[0].toUpperCase() + k.slice(1)]);

// ---------- blur helper (bloom) ----------
function boxBlur(a, W, H, r) {
  const tmp = new Float32Array(a.length), inv = 1 / (2 * r + 1);
  for (let y = 0; y < H; y++) {                           // horizontal → tmp
    const row = y * W; let s = 0;
    for (let k = -r; k <= r; k++) s += a[row + Math.min(W - 1, Math.max(0, k))];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = s * inv;
      s += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {                           // vertical → a
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(H - 1, Math.max(0, k)) * W + x];
    for (let y = 0; y < H; y++) {
      a[y * W + x] = s * inv;
      s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
}

export const ART_EFFECTS = [
  // ================= ART · COLOUR =================
  { id: 'gradmap', name: 'Gradient map', group: 'artcolour', kind: 'pixel', hint: 'Luminance → palette. More cycles = psychedelic contour banding.',
    params: [{ k: 'pal', t: 'select', label: 'Palette', opts: PAL_OPTS, def: 'synthwave' },
      { k: 'cycles', t: 'range', label: 'Cycles', min: 1, max: 8, step: 0.25, def: 1, rnd: [1, 4] },
      { k: 'offset', t: 'range', label: 'Phase', min: 0, max: 100, def: 0, fmt: pct, rnd: [0, 100] },
      { k: 'wrap', t: 'seg', label: 'Repeat', opts: [['ping', 'Ping-pong'], ['wrap', 'Hard wrap']], def: 'ping' },
      { k: 'mix', t: 'range', label: 'Mix', min: 0, max: 100, def: 100, fmt: pct, rnd: [60, 100] }],
    apply: art((s, p, c, W, H) => {
      const T = LUTS[p.pal] || LUTS.synthwave, m = p.mix / 100, cy = p.cycles, off = p.offset / 100, d = new Uint8ClampedArray(s.length);
      for (let i = 0; i < s.length; i += 3) {
        let t = lumAt(s, i) / 255 * cy + off;
        if (p.wrap === 'wrap') { const f = t - Math.floor(t); t = f === 0 && t > 0 ? 1 : f; }
        else { t %= 2; t = t <= 1 ? t : 2 - t; }
        const k = Math.min(255, Math.max(0, Math.round(t * 255))) * 3;
        d[i] = s[i] + (T[k] - s[i]) * m; d[i + 1] = s[i + 1] + (T[k + 1] - s[i + 1]) * m; d[i + 2] = s[i + 2] + (T[k + 2] - s[i + 2]) * m;
      }
      return d;
    }) },
  { id: 'duotone', name: 'Duotone', group: 'artcolour', kind: 'pixel', hint: 'Two-ink print: shadow hue → highlight hue.',
    params: [{ k: 'sh', t: 'range', label: 'Shadow hue', min: 0, max: 360, def: 250, fmt: deg, rnd: [0, 360] },
      { k: 'hh', t: 'range', label: 'Highlight hue', min: 0, max: 360, def: 40, fmt: deg, rnd: [0, 360] },
      { k: 'con', t: 'range', label: 'Contrast', min: 50, max: 300, def: 130, fmt: pct, rnd: [90, 200] },
      { k: 'mix', t: 'range', label: 'Mix', min: 0, max: 100, def: 100, fmt: pct, rnd: [70, 100] }],
    apply: art((s, p) => {
      const a = hsl(p.sh, 0.75, 0.13), b = hsl(p.hh, 0.9, 0.86), k = p.con / 100, m = p.mix / 100, d = new Uint8ClampedArray(s.length);
      for (let i = 0; i < s.length; i += 3) {
        let t = (lumAt(s, i) / 255 - 0.5) * k + 0.5; t = t < 0 ? 0 : t > 1 ? 1 : t;
        for (let ch = 0; ch < 3; ch++) d[i + ch] = s[i + ch] + (a[ch] + (b[ch] - a[ch]) * t - s[i + ch]) * m;
      }
      return d;
    }) },
  { id: 'solarcurve', name: 'Solar curves', group: 'artcolour', kind: 'pixel', hint: 'Cosine tone curve folded N times — metallic, liquid chrome. Rainbow splits the channels.',
    params: [{ k: 'folds', t: 'range', label: 'Folds', min: 0.5, max: 8, step: 0.25, def: 2, rnd: [1, 5] },
      { k: 'rainbow', t: 'range', label: 'Rainbow', min: 0, max: 100, def: 30, fmt: pct, rnd: [0, 100] },
      { k: 'mix', t: 'range', label: 'Mix', min: 0, max: 100, def: 100, fmt: pct, rnd: [60, 100] }],
    apply: art((s, p) => {
      const lut = new Float32Array(256 * 3), m = p.mix / 100, d = new Uint8ClampedArray(s.length);
      for (let v = 0; v < 256; v++) for (let ch = 0; ch < 3; ch++) lut[v * 3 + ch] = 127.5 - 127.5 * Math.cos(Math.PI * p.folds * v / 255 + ch * (p.rainbow / 100) * 2.0944);
      for (let i = 0; i < s.length; i += 3) for (let ch = 0; ch < 3; ch++) d[i + ch] = s[i + ch] + (lut[s[i + ch] * 3 + ch] - s[i + ch]) * m;
      return d;
    }) },

  // ================= ART · FORM =================
  { id: 'kaleido', name: 'Kaleidoscope', group: 'artform', kind: 'pixel', random: false, hint: 'Wedges fold around the centre; mirror modes reflect halves/quadrants.',
    params: [{ k: 'mode', t: 'select', label: 'Mode', opts: [['kal', 'Kaleidoscope'], ['mx', 'Mirror ←→'], ['my', 'Mirror ↑↓'], ['quad', 'Quad mirror']], def: 'kal' },
      { k: 'n', t: 'range', label: 'Wedges', min: 2, max: 24, def: 6 },
      { k: 'rot', t: 'range', label: 'Rotate', min: 0, max: 360, def: 0, fmt: deg },
      { k: 'cx', t: 'range', label: 'Centre X', min: 0, max: 100, def: 50, fmt: pct },
      { k: 'cy', t: 'range', label: 'Centre Y', min: 0, max: 100, def: 50, fmt: pct }],
    apply: art((s, p, c, W, H) => {
      const d = new Uint8ClampedArray(s.length), cx = (W - 1) * p.cx / 100, cy = (H - 1) * p.cy / 100;
      const seg = 2 * Math.PI / Math.max(2, p.n | 0), rot = p.rot * Math.PI / 180, mode = p.mode;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let sx = x, sy = y;
        if (mode === 'mx') { if (x > cx) sx = 2 * cx - x; }
        else if (mode === 'my') { if (y > cy) sy = 2 * cy - y; }
        else if (mode === 'quad') { if (x > cx) sx = 2 * cx - x; if (y > cy) sy = 2 * cy - y; }
        else {
          const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
          let a = Math.atan2(dy, dx) - rot; a = ((a % seg) + seg) % seg; if (a > seg / 2) a = seg - a; a += rot;
          sx = cx + r * Math.cos(a); sy = cy + r * Math.sin(a);
        }
        copyPx(d, (y * W + x) * 3, s, (mir(sy, H) * W + mir(sx, W)) * 3);
      }
      return d;
    }) },
  { id: 'twirl', name: 'Twirl', group: 'artform', kind: 'pixel', random: false, hint: 'Polar swirl, strongest at the centre.',
    params: [{ k: 'str', t: 'range', label: 'Strength', min: -720, max: 720, def: 180, fmt: deg },
      { k: 'rad', t: 'range', label: 'Radius', min: 10, max: 150, def: 70, fmt: pct },
      { k: 'cx', t: 'range', label: 'Centre X', min: 0, max: 100, def: 50, fmt: pct },
      { k: 'cy', t: 'range', label: 'Centre Y', min: 0, max: 100, def: 50, fmt: pct }],
    apply: art((s, p, c, W, H) => {
      const d = new Uint8ClampedArray(s.length), cx = (W - 1) * p.cx / 100, cy = (H - 1) * p.cy / 100;
      const R = Math.hypot(W, H) / 2 * p.rad / 100, k = p.str * Math.PI / 180;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy), i = (y * W + x) * 3;
        if (r >= R) { copyPx(d, i, s, i); continue; }
        const f = 1 - r / R, a = Math.atan2(dy, dx) + k * f * f;
        copyPx(d, i, s, (mir(cy + r * Math.sin(a), H) * W + mir(cx + r * Math.cos(a), W)) * 3);
      }
      return d;
    }) },
  { id: 'radialchroma', name: 'Radial chroma', group: 'artform', kind: 'pixel', hint: 'Lens-style RGB split radiating from the centre — zoom or spin.',
    params: [{ k: 'amt', t: 'range', label: 'Amount', min: 0, max: 80, def: 15, rnd: [5, 40] },
      { k: 'mode', t: 'seg', label: 'Mode', opts: [['zoom', 'Zoom'], ['spin', 'Spin']], def: 'zoom' }],
    apply: art((s, p, c, W, H) => {
      const d = new Uint8ClampedArray(s.length), cx = (W - 1) / 2, cy = (H - 1) / 2, k = p.amt / 1000, spin = p.mode === 'spin';
      const ca = Math.cos(k * 2), sa = Math.sin(k * 2);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = x - cx, dy = y - cy, i = (y * W + x) * 3;
        let rx, ry, bx, by;
        if (spin) { rx = cx + dx * ca - dy * sa; ry = cy + dx * sa + dy * ca; bx = cx + dx * ca + dy * sa; by = cy - dx * sa + dy * ca; }
        else { rx = cx + dx * (1 - k); ry = cy + dy * (1 - k); bx = cx + dx * (1 + k); by = cy + dy * (1 + k); }
        d[i] = s[(cl(ry, H) * W + cl(rx, W)) * 3];
        d[i + 1] = s[i + 1];
        d[i + 2] = s[(cl(by, H) * W + cl(bx, W)) * 3 + 2];
      }
      return d;
    }) },
  { id: 'selfdisplace', name: 'Self-displace', group: 'artform', kind: 'pixel', hint: 'Pixels push themselves by their own brightness — liquid, smeared contours.',
    params: [{ k: 'amt', t: 'range', label: 'Amount px', min: 0, max: 300, def: 40, rnd: [10, 150] },
      { k: 'axis', t: 'seg', label: 'Axis', opts: [['h', 'Horiz'], ['v', 'Vert'], ['both', 'Both']], def: 'h' },
      { k: 'src', t: 'seg', label: 'Driver', opts: [['lum', 'Luma'], ['r', 'R'], ['g', 'G'], ['b', 'B']], def: 'lum' }],
    apply: art((s, p, c, W, H) => {
      const d = new Uint8ClampedArray(s.length), ch = { r: 0, g: 1, b: 2 }[p.src];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3, v = ((ch === undefined ? lumAt(s, i) : s[i + ch]) / 255 - 0.5) * 2 * p.amt;
        const v2 = (s[i + 2] / 255 - 0.5) * 2 * p.amt;
        const sx = p.axis === 'v' ? x : x + v, sy = p.axis === 'h' ? y : y + (p.axis === 'both' ? v2 : v);
        copyPx(d, i, s, (mir(sy, H) * W + mir(sx, W)) * 3);
      }
      return d;
    }) },
  { id: 'drip', name: 'Pixel drip', group: 'artform', kind: 'pixel', hint: 'Bright pixels run down (or up) the frame like wet paint.',
    params: [{ k: 'len', t: 'range', label: 'Length', min: 2, max: 100, def: 30, fmt: pct, rnd: [10, 70] },
      { k: 'dens', t: 'range', label: 'Density', min: 1, max: 100, def: 40, fmt: pct, rnd: [15, 80] },
      { k: 'thr', t: 'range', label: 'Threshold', min: 0, max: 100, def: 55, fmt: pct, rnd: [30, 80] },
      { k: 'dir', t: 'seg', label: 'Direction', opts: [['down', 'Down'], ['up', 'Up']], def: 'down', rnd: [0, 0.25] },
      { k: 'fade', t: 'seg', label: 'Tail', opts: [['on', 'Fade'], ['off', 'Solid']], def: 'on' }],
    apply: art((s, p, c, W, H) => {
      const d = s.slice(), r = c.rng, thr = p.thr / 100 * 255, dens = p.dens / 100 * 0.08, maxL = Math.max(1, p.len / 100 * H), fade = p.fade === 'on', up = p.dir === 'up';
      for (let x = 0; x < W; x++) {
        let rem = 0, L0 = 1, cr = 0, cg = 0, cb = 0;
        for (let k = 0; k < H; k++) {
          const y = up ? H - 1 - k : k, i = (y * W + x) * 3;
          if (rem > 0) {
            const f = fade ? rem / L0 : 1;
            d[i] = cr * f + s[i] * (1 - f); d[i + 1] = cg * f + s[i + 1] * (1 - f); d[i + 2] = cb * f + s[i + 2] * (1 - f); rem--;
          } else if (lumAt(s, i) >= thr && r() < dens) {
            rem = L0 = 1 + Math.floor(r() * maxL); cr = s[i]; cg = s[i + 1]; cb = s[i + 2];
          }
        }
      }
      return d;
    }) },
  { id: 'crystal', name: 'Crystallize / shatter', group: 'artform', kind: 'pixel', hint: 'Jittered Voronoi cells. Shatter displaces each shard; grout draws stained-glass leading.',
    params: [{ k: 'size', t: 'range', label: 'Cell px', min: 3, max: 80, def: 18, rnd: [6, 50] },
      { k: 'jit', t: 'range', label: 'Jitter', min: 0, max: 100, def: 80, fmt: pct, rnd: [40, 100] },
      { k: 'mode', t: 'seg', label: 'Mode', opts: [['crystal', 'Crystal'], ['shatter', 'Shatter']], def: 'crystal' },
      { k: 'shat', t: 'range', label: 'Shard offset', min: 0, max: 120, def: 25, rnd: [5, 60] },
      { k: 'grout', t: 'range', label: 'Grout px', min: 0, max: 6, step: 0.5, def: 0, rnd: [0, 2] }],
    apply: art((s, p, c, W, H) => {
      const S = Math.max(2, p.size | 0), r = c.rng, jit = p.jit / 100, gw = Math.ceil(W / S) + 1, gh = Math.ceil(H / S) + 1, n = gw * gh;
      const PX = new Float32Array(n), PY = new Float32Array(n), OX = new Float32Array(n), OY = new Float32Array(n);
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
        const k = gy * gw + gx;
        PX[k] = (gx + 0.5 + (r() - 0.5) * jit) * S; PY[k] = (gy + 0.5 + (r() - 0.5) * jit) * S;
        OX[k] = (r() * 2 - 1) * p.shat; OY[k] = (r() * 2 - 1) * p.shat;
      }
      const d = new Uint8ClampedArray(s.length), shatter = p.mode === 'shatter', grout = p.grout;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const gx = Math.floor(x / S), gy = Math.floor(y / S);
        let b1 = -1, d1 = Infinity, d2 = Infinity;
        for (let oy = -1; oy <= 1; oy++) { const Y = gy + oy; if (Y < 0 || Y >= gh) continue;
          for (let ox = -1; ox <= 1; ox++) { const X = gx + ox; if (X < 0 || X >= gw) continue;
            const k = Y * gw + X, dd = (PX[k] - x) ** 2 + (PY[k] - y) ** 2;
            if (dd < d1) { d2 = d1; d1 = dd; b1 = k; } else if (dd < d2) d2 = dd; } }
        const i = (y * W + x) * 3;
        if (grout > 0 && Math.sqrt(d2) - Math.sqrt(d1) < grout) { d[i] = d[i + 1] = d[i + 2] = 8; continue; }
        const j = shatter ? (mir(y + OY[b1], H) * W + mir(x + OX[b1], W)) * 3 : (cl(PY[b1], H) * W + cl(PX[b1], W)) * 3;
        copyPx(d, i, s, j);
      }
      return d;
    }) },
  { id: 'quadtree', name: 'Quadtree mosaic', group: 'artform', kind: 'pixel', hint: 'Splits blocks only where there’s detail — big flat tiles, fine edges.',
    params: [{ k: 'min', t: 'range', label: 'Min block', min: 2, max: 32, def: 4, rnd: [2, 12] },
      { k: 'max', t: 'range', label: 'Max block', min: 8, max: 256, def: 64, rnd: [24, 160] },
      { k: 'detail', t: 'range', label: 'Detail', min: 1, max: 100, def: 60, fmt: pct, rnd: [30, 85] },
      { k: 'outline', t: 'seg', label: 'Outline', opts: [['none', 'None'], ['dark', 'Dark'], ['light', 'Light']], def: 'dark' }],
    apply: art((s, p, c, W, H) => {
      const d = new Uint8ClampedArray(s.length), thr = Math.pow((100 - p.detail) / 100, 2) * 4000 + 4;
      const mn = Math.max(1, p.min | 0), mx = Math.max(mn * 2, p.max | 0), oc = p.outline === 'light' ? 235 : 10;
      const stack = [[0, 0, W, H]];
      while (stack.length) {
        const [x0, y0, w, h] = stack.pop();
        let sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0; const n = w * h;
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
          const i = (y * W + x) * 3, l = lumAt(s, i); sr += s[i]; sg += s[i + 1]; sb += s[i + 2]; sl += l; sl2 += l * l;
        }
        const varL = sl2 / n - (sl / n) ** 2;
        if ((w > mx || h > mx || varL > thr) && w >= 2 * mn && h >= 2 * mn) {
          const hw = w >> 1, hh = h >> 1;
          stack.push([x0, y0, hw, hh], [x0 + hw, y0, w - hw, hh], [x0, y0 + hh, hw, h - hh], [x0 + hw, y0 + hh, w - hw, h - hh]);
          continue;
        }
        const R = sr / n, G = sg / n, B = sb / n, line = p.outline !== 'none';
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
          const i = (y * W + x) * 3;
          if (line && (x === x0 || y === y0)) { d[i] = d[i + 1] = d[i + 2] = oc; }
          else { d[i] = R; d[i + 1] = G; d[i + 2] = B; }
        }
      }
      return d;
    }) },
  { id: 'halftone', name: 'Halftone', group: 'artform', kind: 'pixel', random: false, hint: 'Rotated dot screen, antialiased. Ink on paper, light on black, or colour dots.',
    params: [{ k: 'cell', t: 'range', label: 'Cell px', min: 3, max: 40, def: 8 },
      { k: 'ang', t: 'range', label: 'Angle', min: 0, max: 90, def: 45, fmt: deg },
      { k: 'mode', t: 'seg', label: 'Style', opts: [['ink', 'Ink'], ['light', 'Light'], ['color', 'Colour']], def: 'ink' },
      { k: 'gain', t: 'range', label: 'Dot gain', min: 50, max: 200, def: 100, fmt: pct }],
    apply: art((s, p, c, W, H) => {
      const d = new Uint8ClampedArray(s.length), S = Math.max(2, p.cell), a = p.ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), g = p.gain / 100;
      const paper = [244, 238, 224], ink = [22, 20, 26];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const u = x * ca + y * sa, v = -x * sa + y * ca, cu = (Math.floor(u / S) + 0.5) * S, cv = (Math.floor(v / S) + 0.5) * S;
        const X = cl(cu * ca - cv * sa, W), Y = cl(cu * sa + cv * ca, H), j = (Y * W + X) * 3, l = lumAt(s, j) / 255;
        const dist = Math.hypot(u - cu, v - cv), i = (y * W + x) * 3;
        const amt = p.mode === 'ink' ? 1 - l : l, R = S * 0.7071 * Math.sqrt(amt) * g;
        const cov = Math.min(1, Math.max(0, R - dist + 0.5));
        if (p.mode === 'ink') for (let ch = 0; ch < 3; ch++) d[i + ch] = paper[ch] + (ink[ch] - paper[ch]) * cov;
        else if (p.mode === 'light') d[i] = d[i + 1] = d[i + 2] = 245 * cov;
        else { const m = Math.max(s[j], s[j + 1], s[j + 2], 1), k = 255 / m; for (let ch = 0; ch < 3; ch++) d[i + ch] = s[j + ch] * k * cov; }
      }
      return d;
    }) },
  { id: 'crt', name: 'CRT scanlines', group: 'artform', kind: 'pixel', hint: 'Dark scanlines plus an RGB aperture-grille mask.',
    params: [{ k: 'period', t: 'range', label: 'Line period', min: 2, max: 8, def: 3, rnd: [2, 5] },
      { k: 'line', t: 'range', label: 'Line dark', min: 0, max: 100, def: 45, fmt: pct, rnd: [25, 70] },
      { k: 'mask', t: 'range', label: 'RGB mask', min: 0, max: 100, def: 35, fmt: pct, rnd: [10, 60] },
      { k: 'boost', t: 'range', label: 'Boost', min: 100, max: 200, def: 125, fmt: pct, rnd: [100, 150] }],
    apply: art((s, p, c, W, H) => {
      const d = new Uint8ClampedArray(s.length), per = Math.max(2, p.period | 0), ln = 1 - p.line / 100, mk = 1 - p.mask / 100, bo = p.boost / 100;
      for (let y = 0; y < H; y++) { const lf = (y % per === per - 1 ? ln : 1) * bo;
        for (let x = 0; x < W; x++) { const i = (y * W + x) * 3, keep = x % 3;
          for (let ch = 0; ch < 3; ch++) d[i + ch] = s[i + ch] * lf * (ch === keep ? 1 : mk); } }
      return d;
    }) },
  { id: 'neon', name: 'Neon edges', group: 'artform', kind: 'pixel', hint: 'Sobel edges lit up — in source colour, white, or rainbow by edge direction.',
    params: [{ k: 'gain', t: 'range', label: 'Gain', min: 0.5, max: 8, step: 0.1, def: 2.5, fmt: v => (+v).toFixed(1) + '×', rnd: [1.5, 5] },
      { k: 'col', t: 'seg', label: 'Colour', opts: [['src', 'Source'], ['white', 'White'], ['angle', 'Rainbow']], def: 'angle' },
      { k: 'base', t: 'range', label: 'Keep image', min: 0, max: 100, def: 10, fmt: pct, rnd: [0, 40] }],
    apply: art((s, p, c, W, H) => {
      const d = new Uint8ClampedArray(s.length), Lm = new Float32Array(W * H), b = p.base / 100;
      for (let i = 0, j = 0; j < Lm.length; i += 3, j++) Lm[j] = lumAt(s, i);
      const HUE = new Float32Array(361 * 3);
      for (let h = 0; h <= 360; h++) { const c3 = hsl(h - 180, 1, 0.58); HUE[h * 3] = c3[0]; HUE[h * 3 + 1] = c3[1]; HUE[h * 3 + 2] = c3[2]; }
      const mode = p.col, gain = p.gain / 1020;
      for (let y = 0; y < H; y++) {
        const ym = (y > 0 ? y - 1 : 0) * W, y0 = y * W, yp = (y < H - 1 ? y + 1 : y) * W;
        for (let x = 0; x < W; x++) {
          const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : x;
          const gx = Lm[ym + xp] + 2 * Lm[y0 + xp] + Lm[yp + xp] - Lm[ym + xm] - 2 * Lm[y0 + xm] - Lm[yp + xm];
          const gy = Lm[yp + xm] + 2 * Lm[yp + x] + Lm[yp + xp] - Lm[ym + xm] - 2 * Lm[ym + x] - Lm[ym + xp];
          let e = Math.sqrt(gx * gx + gy * gy) * gain; if (e > 1) e = 1;
          const i = (y0 + x) * 3;
          let r, g, bl;
          if (mode === 'white') r = g = bl = 255;
          else if (mode === 'angle') { const h = (Math.round(Math.atan2(gy, gx) * 57.2958) + 180) * 3; r = HUE[h]; g = HUE[h + 1]; bl = HUE[h + 2]; }
          else { const m = 255 / Math.max(s[i], s[i + 1], s[i + 2], 1); r = s[i] * m; g = s[i + 1] * m; bl = s[i + 2] * m; }
          d[i] = s[i] * b + r * e; d[i + 1] = s[i + 1] * b + g * e; d[i + 2] = s[i + 2] * b + bl * e;
        }
      }
      return d;
    }) },
  { id: 'contour', name: 'Topographic', group: 'artform', kind: 'pixel', random: false, hint: 'Iso-luminance contour lines like a relief map; Flat posterizes brightness but keeps hue.',
    params: [{ k: 'bands', t: 'range', label: 'Bands', min: 3, max: 48, def: 12 },
      { k: 'mode', t: 'seg', label: 'Mode', opts: [['over', 'Over'], ['only', 'Lines only'], ['flat', 'Flat']], def: 'over' },
      { k: 'ink', t: 'seg', label: 'Ink', opts: [['dark', 'Dark'], ['light', 'Light']], def: 'dark' },
      { k: 'w', t: 'range', label: 'Width', min: 1, max: 4, def: 1 }],
    apply: art((s, p, c, W, H) => {
      const d = new Uint8ClampedArray(s.length), nb = Math.max(2, p.bands | 0), band = new Uint8Array(W * H), wd = Math.max(1, p.w | 0);
      for (let i = 0, j = 0; j < band.length; i += 3, j++) band[j] = Math.min(nb - 1, Math.floor(lumAt(s, i) * nb / 256));
      const inkC = p.ink === 'light' ? 240 : 12, bg = p.ink === 'light' ? 10 : 242;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const j = y * W + x, i = j * 3, bv = band[j];
        let edge = false;
        for (let k = 1; k <= wd && !edge; k++) edge = (x + k < W && band[j + k] !== bv) || (y + k < H && band[j + k * W] !== bv);
        if (edge) { d[i] = d[i + 1] = d[i + 2] = inkC; continue; }
        if (p.mode === 'only') { d[i] = d[i + 1] = d[i + 2] = bg; }
        else if (p.mode === 'flat') { const l = Math.max(1, lumAt(s, i)), k = (bv + 0.5) * 256 / nb / l; d[i] = s[i] * k; d[i + 1] = s[i + 1] * k; d[i + 2] = s[i + 2] * k; }
        else copyPx(d, i, s, i);
      }
      return d;
    }) },
  { id: 'bloom', name: 'Bloom', group: 'artform', kind: 'pixel', hint: 'Bright areas glow outward (three-pass box blur ≈ gaussian).',
    params: [{ k: 'thr', t: 'range', label: 'Threshold', min: 0, max: 100, def: 60, fmt: pct, rnd: [35, 80] },
      { k: 'rad', t: 'range', label: 'Radius px', min: 1, max: 60, def: 12, rnd: [4, 30] },
      { k: 'int', t: 'range', label: 'Intensity', min: 0, max: 300, def: 120, fmt: pct, rnd: [60, 200] }],
    apply: art((s, p, c, W, H) => {
      const n = W * H, t = p.thr / 100 * 255, r = Math.max(1, p.rad | 0), k = p.int / 100, d = new Uint8ClampedArray(s.length);
      const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
      for (let j = 0; j < n; j++) for (let q = 0; q < 3; q++) { const v = s[j * 3 + q] - t; ch[q][j] = v > 0 ? v : 0; }
      for (const a of ch) for (let pass = 0; pass < 3; pass++) boxBlur(a, W, H, r);
      for (let j = 0; j < n; j++) for (let q = 0; q < 3; q++) d[j * 3 + q] = s[j * 3 + q] + ch[q][j] * k;
      return d;
    }) },
];
