// Non-destructive pipeline: source bytes + ordered steps → result bytes.
// Each step = { fx, p, seed, on, sel }  (sel: normalized rect {x0,y0,x1,y1} in display space, or null)
import { EFFECTS, EFFECT_LIST, randomParams } from './effects.js';
import { mulberry32, hashStr, mixSeed, clamp } from './util.js';
import { scanEnd } from './jpeg.js';

export const RECIPE_VERSION = 2;

/**
 * env: { fmt:'bmp'|'jpeg', W, H, off, stride, protect, scanStart }
 * (off/stride describe the BMP pixel layout of the source; scanStart the JPEG scan)
 */
export function stepActive(step, env) {
  const def = EFFECTS[step.fx];
  if (!def || !step.on) return false;
  if (env.fmt === 'jpeg' && def.kind === 'pixel') return false;
  return true;
}

export const regionOf = (b, env) => baseRegion(b, env);

function baseRegion(b, env) {
  if (env.fmt === 'jpeg') {
    return env.protect ? [Math.min(env.scanStart, b.length), Math.max(Math.min(env.scanStart, b.length), scanEnd(b))] : [0, b.length];
  }
  return env.protect ? [Math.min(env.off, b.length), b.length] : [0, b.length];
}

/** Selection rect (normalized, y down) → BMP storage rows/cols. */
function selRows(sel, env) {
  const H = env.H, W = env.W;
  const y0 = clamp(Math.floor(sel.y0 * H), 0, H), y1 = clamp(Math.ceil(sel.y1 * H), 0, H);
  const x0 = clamp(Math.floor(sel.x0 * W), 0, W), x1 = clamp(Math.ceil(sel.x1 * W), 0, W);
  return { r0: H - y1, r1: H - y0, x0, x1 };
}

export function applyStep(b, step, env) {
  const def = EFFECTS[step.fx];
  const rng = mulberry32(mixSeed(step.seed >>> 0, hashStr(step.fx)));
  const c = { fmt: env.fmt, W: env.W, H: env.H, off: env.off, stride: env.stride, r0: 0, r1: env.H, rng };
  if (def.raw) { c.s = 0; c.e = b.length; return def.apply(b, step.p, c); }
  let [s, e] = baseRegion(b, env);
  const sel = step.sel;

  if (!sel) { c.s = s; c.e = e; return def.apply(b, step.p, c); }

  if (env.fmt === 'jpeg') {
    // Baseline scans run roughly top→bottom: map the selection's rows to a proportional slice of the scan.
    const span = e - s;
    c.s = s + Math.floor(clamp(sel.y0, 0, 1) * span); c.e = Math.max(c.s, s + Math.ceil(clamp(sel.y1, 0, 1) * span));
    return def.apply(b, step.p, c);
  }

  const { r0, r1, x0, x1 } = selRows(sel, env);
  if (r1 <= r0 || x1 <= x0) return b.slice();
  c.r0 = r0; c.r1 = r1;
  const bandS = Math.max(s, env.off + r0 * env.stride), bandE = Math.min(e, env.off + r1 * env.stride);
  c.s = Math.min(bandS, bandE); c.e = bandE;
  const res = def.apply(b, step.p, c);
  if (def.len || res.length !== b.length) return res;              // length-changing: band only
  // length-preserving: composite exactly the selected rectangle
  const o = b.slice(), len = b.length;
  for (let r = r0; r < r1; r++) {
    const a = env.off + r * env.stride + x0 * 3, z = Math.min(len, env.off + r * env.stride + x1 * 3);
    if (a >= len) break;
    o.set(res.subarray(a, z), a);
  }
  return o;
}

/**
 * Replay with a per-step output cache. cache[i] = output after step i.
 * Recomputes from `from` onward. Returns final bytes.
 */
export function replay(base, steps, env, cache, from = 0) {
  cache.length = Math.min(cache.length, steps.length);
  from = clamp(from, 0, steps.length);
  let cur = from === 0 ? base : (cache[from - 1] || null);
  if (!cur) { from = 0; cur = base; }
  for (let i = from; i < steps.length; i++) {
    cur = stepActive(steps[i], env) ? applyStep(cur, steps[i], env) : cur;
    cache[i] = cur;
  }
  cache.length = steps.length;
  return steps.length ? cache[steps.length - 1] : base;
}

export const runSteps = (base, steps, env) => replay(base, steps, env, [], 0);

// ---------- step + recipe helpers ----------
export function makeStep(fx, p, seed, sel = null) {
  return { fx, p: { ...p }, seed: seed >>> 0, on: true, sel: sel ? { ...sel } : null };
}
export const cloneSteps = steps => steps.map(s => ({ ...s, p: { ...s.p }, sel: s.sel ? { ...s.sel } : null }));

/** Pool for random corrupt, filtered by container. */
export function randomPool(fmt) {
  return EFFECT_LIST.filter(d => d.group && d.random !== false && (fmt !== 'jpeg' || d.kind === 'stream'));
}

// Ops that only touch a few spots of the stream — safe across a whole JPEG scan.
const JPEG_SPARSE = new Set(['noise', 'findrepl', 'echo', 'move', 'carve']);

/**
 * n random steps. JPEG scans are fragile: whole-stream ops (xor, crush, dsp…)
 * on the full scan just yield noise, so there they get a random band of the
 * scan (classic "glitch starts partway down and cascades") unless the user
 * has a selection; sparse ops get low strengths.
 */
export function randomSteps(r, n, fmt, seedBase, sel = null) {
  const pool = randomPool(fmt), out = [];
  for (let k = 0; k < n; k++) {
    const def = pool[Math.floor(r() * pool.length)];
    const p = randomParams(def, r);
    let s = sel;
    if (fmt === 'jpeg') {
      if (def.id === 'noise') p.amt = +(0.01 + r() * 0.12).toFixed(2);
      if (def.id === 'byteadd') p.amt = Math.round((r() * 2 - 1) * 8) || 1;
      if (def.id === 'sort') p.win = 4 + 4 * Math.floor(r() * 6);
      if (def.id === 'findrepl') { p.find = ['00', '01', 'a0', '7f'][Math.floor(r() * 4)]; p.repl = ['10', '02', 'a1', '7e'][Math.floor(r() * 4)]; }
      if (!sel && !JPEG_SPARSE.has(def.id)) {
        const y0 = +(0.05 + r() * 0.8).toFixed(3), h = +(0.004 + r() * r() * 0.08).toFixed(3);
        s = { x0: 0, y0, x1: 1, y1: Math.min(1, +(y0 + h).toFixed(3)) };
      }
    }
    out.push(makeStep(def.id, p, mixSeed(seedBase, k + 1), s));
  }
  return out;
}

export function serializeRecipe(o) {
  return JSON.stringify({ app: 'databender', version: RECIPE_VERSION, ...o, steps: o.steps.map(s => ({ fx: s.fx, p: s.p, seed: s.seed, on: s.on, sel: s.sel })) }, null, 1);
}

export function parseRecipe(text) {
  const j = JSON.parse(text);
  if (!j || j.app !== 'databender' || !Array.isArray(j.steps)) throw new Error('not a databender recipe');
  const steps = j.steps.filter(s => s && EFFECTS[s.fx]).map(s => {
    const def = EFFECTS[s.fx], p = {};
    for (const q of def.params) p[q.k] = s.p && s.p[q.k] !== undefined ? s.p[q.k] : q.def;
    const sel = s.sel && ['x0', 'y0', 'x1', 'y1'].every(k => typeof s.sel[k] === 'number') ? s.sel : null;
    return { fx: s.fx, p, seed: (s.seed >>> 0) || 1, on: s.on !== false, sel };
  });
  return { ...j, steps, dropped: j.steps.length - steps.length };
}
