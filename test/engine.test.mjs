// Headless engine tests: node test/engine.test.mjs
import { encodeBMP, decodeBMP, geom, bmpInfo, BMP_HEADER } from '../engine/bmp.js';
import { jpegLayout, sanitizeJPEG, scanEnd } from '../engine/jpeg.js';
import { EFFECTS, EFFECT_LIST, GROUPS, defaultParams, randomParams, summarize } from '../engine/effects.js';
import { applyStep, replay, runSteps, makeStep, randomSteps, serializeRecipe, parseRecipe, cloneSteps } from '../engine/pipeline.js';
import { mulberry32 } from '../engine/util.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function img(W, H, f) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = f(x, y), i = (y * W + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  return { width: W, height: H, data: d };
}
// width 37 → 111 bytes/row → 1 byte padding (exercises the drift bug)
const W = 37, H = 23;
const src = img(W, H, (x, y) => [(x * 7) & 255, (y * 11) & 255, ((x + y) * 5) & 255]);
const bmp = encodeBMP(src);
const { stride } = geom(W);
const env = { fmt: 'bmp', W, H, off: BMP_HEADER, stride, protect: true, scanStart: 0 };

// --- BMP roundtrip
{
  const d = decodeBMP(bmp, W, H, {});
  ok(d.width === W && d.height === H, 'decode dims');
  ok(eq(Array.from(d.data), Array.from(src.data)), 'bmp roundtrip exact');
  const inf = bmpInfo(bmp); ok(inf.w === W && inf.h === H && inf.off === 54 && inf.bpp === 24, 'bmpInfo');
  ok(stride === 112, 'stride with padding');
  // decode-as never throws, any combo
  for (const fmt of ['bgr24', 'rgb24', 'bgra32', 'gray8', 'rgb565']) for (const pad of [true, false]) {
    const r = decodeBMP(bmp, W, H, { fmt, pad, dw: -5, nudge: 7, fill: true, flip: false });
    ok(r.data.length === r.width * r.height * 4, 'decode-as ' + fmt + pad);
  }
  ok(decodeBMP(new Uint8Array(0), W, H, {}).width === W, 'empty decode safe');
  ok(decodeBMP(bmp.slice(0, 60), W, H, {}).height === H, 'truncated decode safe');
}

// --- Every effect: runs, deterministic, header protected, length rules
for (const def of EFFECT_LIST) {
  const p = def.id === 'poke' ? { offset: 100, value: 7 } : defaultParams(def);
  const st = makeStep(def.id, p, 1234);
  let a, b;
  try { a = applyStep(bmp, st, env); b = applyStep(bmp, st, env); } catch (e) { ok(false, def.id + ' threw ' + e.message); continue; }
  ok(a instanceof Uint8Array, def.id + ' returns Uint8Array');
  ok(eq(a, b), def.id + ' deterministic');
  ok(eq(bmp, encodeBMP(src)), def.id + ' did not mutate input');
  if (!def.raw) ok(eq(a.subarray(0, 54), bmp.subarray(0, 54)), def.id + ' header protected');
  if (!def.len) ok(a.length === bmp.length, def.id + ' length preserved');
  ok(typeof summarize(def, p) === 'string', def.id + ' summarize');
  const r = mulberry32(9); const rp = randomParams(def, r);
  for (const q of def.params) if (q.t === 'range') ok(rp[q.k] >= q.min && rp[q.k] <= q.max, def.id + '.' + q.k + ' random in range');
}
ok(EFFECT_LIST.filter(d => d.group).every(d => GROUPS.some(g => g[0] === d.group)), 'all groups exist');
ok(EFFECT_LIST.length >= 40, 'effect count ' + EFFECT_LIST.length);

// --- Different seeds → different results (repeat-apply bug fix)
{
  const a = applyStep(bmp, makeStep('noise', { amt: 5 }, 1), env), b = applyStep(bmp, makeStep('noise', { amt: 5 }, 2), env);
  ok(!eq(a, b), 'seed changes noise');
}

// --- Channel targeting stays aligned across padded rows (drift bug fix)
{
  const out = applyStep(bmp, makeStep('channel', { ch: 2, amt: 100 }, 5), env);
  const d0 = decodeBMP(bmp, W, H, {}).data, d1 = decodeBMP(out, W, H, {}).data;
  let gbSame = true, rChanged = 0;
  for (let i = 0; i < d0.length; i += 4) { if (d0[i + 1] !== d1[i + 1] || d0[i + 2] !== d1[i + 2]) gbSame = false; if (d0[i] !== d1[i]) rChanged++; }
  ok(gbSame, 'channel=red leaves G,B untouched on every row');
  ok(rChanged > W * H * 0.9, 'channel=red hits red');
  const sw = decodeBMP(applyStep(bmp, makeStep('channelswap', { mode: 'rb' }, 1), env), W, H, {}).data;
  let swapOk = true; for (let i = 0; i < d0.length; i += 4) if (sw[i] !== d0[i + 2] || sw[i + 2] !== d0[i] || sw[i + 1] !== d0[i + 1]) swapOk = false;
  ok(swapOk, 'channel swap R<->B exact on all rows');
  const h0 = decodeBMP(applyStep(bmp, makeStep('huerotate', { deg: 0 }, 1), env), W, H, {}).data;
  let hueMax = 0; for (let i = 0; i < d0.length; i++) hueMax = Math.max(hueMax, Math.abs(h0[i] - d0[i]));
  ok(hueMax <= 1, 'hue rotate 0° ≈ identity (max diff ' + hueMax + ')');
}

// --- Selection composite: only pixels inside the rect change
{
  const sel = { x0: 0.25, y0: 0.2, x1: 0.6, y1: 0.7 };
  const out = applyStep(bmp, makeStep('invert', {}, 1, sel), env);
  const d0 = decodeBMP(bmp, W, H, {}).data, d1 = decodeBMP(out, W, H, {}).data;
  const X0 = Math.floor(0.25 * W), X1 = Math.ceil(0.6 * W), Y0 = Math.floor(0.2 * H), Y1 = Math.ceil(0.7 * H);
  let inside = true, outside = true;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, inR = x >= X0 && x < X1 && y >= Y0 && y < Y1;
    if (inR && d1[i] !== 255 - d0[i]) inside = false;
    if (!inR && d1[i] !== d0[i]) outside = false;
  }
  ok(inside, 'selection: inside inverted'); ok(outside, 'selection: outside untouched');
  const ps = applyStep(bmp, makeStep('pixelsort', { amt: 100, dir: 1 }, 1, sel), env);
  const dp = decodeBMP(ps, W, H, {}).data; let outsideP = true;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, inR = x >= X0 && x < X1 && y >= Y0 && y < Y1; if (!inR && (dp[i] !== d0[i] || dp[i + 1] !== d0[i + 1])) outsideP = false; }
  ok(outsideP, 'selection: vertical pixel sort stays inside');
  const ec = applyStep(bmp, makeStep('echo', { inten: 50 }, 3, sel), env);
  ok(ec.length > bmp.length, 'selection: echo still grows');
  const rowsBefore = 54 + (H - Y1) * stride;
  ok(eq(ec.subarray(0, rowsBefore), bmp.subarray(0, rowsBefore)), 'selection: echo leaves rows below band untouched');
}

// --- Pipeline replay + cache
{
  const steps = [makeStep('noise', { amt: 3 }, 11), makeStep('echo', { inten: 40 }, 12), makeStep('pixelsort', { amt: 60, dir: 0 }, 13), makeStep('aecho', defaultParams(EFFECTS.aecho), 14)];
  const cache = [];
  const full = replay(bmp, steps, env, cache, 0);
  ok(cache.length === 4, 'cache filled');
  steps[2].p.amt = 30;
  const partial = replay(bmp, steps, env, cache, 2);
  const fresh = runSteps(bmp, steps, env);
  ok(eq(partial, fresh), 'partial replay == fresh replay');
  ok(!eq(partial, full), 'param edit changes output');
  steps[1].on = false;
  const off = replay(bmp, steps, env, cache, 1);
  ok(eq(off, runSteps(bmp, steps, env)), 'toggle replay consistent');
  ok(off.length === bmp.length, 'disabled echo → length restored');
  ok(replay(bmp, [], env, [], 0) === bmp, 'empty stack returns base');
  const jenv = { ...env, fmt: 'jpeg' };
  const st = [makeStep('pixelsort', { amt: 60, dir: 0 }, 1)];
  ok(runSteps(bmp, st, jenv) === bmp, 'pixel step skipped in jpeg mode');
}

// --- Recipe roundtrip
{
  const steps = randomSteps(mulberry32(5), 6, 'bmp', 777, { x0: 0, y0: 0, x1: 0.5, y1: 0.5 });
  const txt = serializeRecipe({ fmt: 'bmp', steps });
  const r = parseRecipe(txt);
  ok(r.steps.length === 6 && r.dropped === 0, 'recipe roundtrip count');
  ok(eq(runSteps(bmp, r.steps, env), runSteps(bmp, cloneSteps(steps), env)), 'recipe roundtrip reproduces output');
  const bad = parseRecipe(JSON.stringify({ app: 'databender', steps: [{ fx: 'nope' }, { fx: 'noise', p: {} }] }));
  ok(bad.steps.length === 1 && bad.dropped === 1 && bad.steps[0].p.amt === 3, 'recipe tolerant of unknown fx / missing params');
  let threw = false; try { parseRecipe('{"x":1}'); } catch { threw = true; } ok(threw, 'rejects non-recipe');
  const js = randomSteps(mulberry32(1), 30, 'jpeg', 1);
  ok(js.every(s => EFFECTS[s.fx].kind === 'stream'), 'jpeg random pool = stream only');
}

// --- JPEG helpers on a synthetic stream
{
  // SOI, APP0(len16), SOS(len 12) , scan..., EOI
  const app0 = [0xFF, 0xE0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sos = [0xFF, 0xDA, 0x00, 0x0C, ...new Array(10).fill(1)];
  const scan = [0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD3, 0x56, 0xFF, 0xC4, 0x99, 0xFF];
  const j = Uint8Array.from([0xFF, 0xD8, ...app0, ...sos, ...scan, 0xFF, 0xD9]);
  const L = jpegLayout(j); const s = 2 + app0.length + sos.length;
  ok(L.scanStart === s && !L.progressive, 'jpeg scan start ' + L.scanStart + ' vs ' + s);
  ok(scanEnd(j) === j.length - 2, 'scanEnd keeps EOI');
  const c = sanitizeJPEG(j, s), sc = Array.from(c.subarray(s, c.length - 2));
  ok(sc[1] === 0xFF && sc[2] === 0x00, 'keeps FF00 stuffing');
  ok(sc[4] === 0xFF && sc[5] === 0xD3, 'keeps RSTn');
  ok(sc[7] === 0xFE, 'neutralizes stray FFC4');
  ok(sc[10] === 0xFE, 'neutralizes FF before EOI');
  ok(c[c.length - 2] === 0xFF && c[c.length - 1] === 0xD9, 'EOI intact');
  const noEOI = sanitizeJPEG(j.slice(0, j.length - 2), s);
  ok(noEOI[noEOI.length - 2] === 0xFF && noEOI[noEOI.length - 1] === 0xD9, 'appends missing EOI');
  const jenv = { fmt: 'jpeg', W: 10, H: 10, off: 0, stride: 30, protect: true, scanStart: s };
  for (const def of EFFECT_LIST.filter(d => d.kind === 'stream' && !d.raw)) {
    const o = applyStep(j, makeStep(def.id, defaultParams(def), 3), jenv);
    ok(eq(o.subarray(0, s), j.subarray(0, s)), 'jpeg header protected by ' + def.id);
    ok(o[o.length - 2] === 0xFF && o[o.length - 1] === 0xD9, 'jpeg EOI protected by ' + def.id);
  }
}

// --- Art effects: identities at neutral settings, symmetry, selection containment, speed
{
  const D = o => decodeBMP(o, W, H, {}).data, d0 = D(bmp);
  const same = (fx, p, tol = 1) => { const d = D(applyStep(bmp, makeStep(fx, { ...defaultParams(EFFECTS[fx]), ...p }, 1), env)); let m = 0; for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i] - d0[i])); ok(m <= tol, fx + ' identity at neutral (max diff ' + m + ')'); };
  same('gradmap', { mix: 0 }); same('duotone', { mix: 0 }); same('solarcurve', { mix: 0 });
  same('twirl', { str: 0 }); same('radialchroma', { amt: 0 }); same('selfdisplace', { amt: 0 });
  same('crt', { line: 0, mask: 0, boost: 100 }); same('bloom', { int: 0 }); same('neon', { gain: 0.5, base: 100 }, 130);
  same('kaleido', { mode: 'mx', cx: 100 });
  const q = D(applyStep(bmp, makeStep('kaleido', { ...defaultParams(EFFECTS.kaleido), mode: 'quad' }, 1), env));
  let sym = true; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const a = (y * W + x) * 4, b = (y * W + (W - 1 - x)) * 4, c = ((H - 1 - y) * W + x) * 4; if (q[a] !== q[b] || q[a] !== q[c]) sym = false; }
  ok(sym, 'quad mirror is exactly symmetric in x and y');
  const g = D(applyStep(bmp, makeStep('gradmap', { pal: 'gameboy', cycles: 1, offset: 0, wrap: 'ping', mix: 100 }, 1), env));
  const gb = new Set(); for (let i = 0; i < g.length; i += 4) gb.add(g[i + 1] >= g[i] && g[i + 1] >= g[i + 2]); ok(gb.size === 1 && gb.has(true), 'gameboy gradient map is green-dominant everywhere');
  const sel = { x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.6 };
  for (const fx of ['kaleido', 'twirl', 'crystal', 'halftone', 'bloom', 'drip', 'quadtree']) {
    const o = D(applyStep(bmp, makeStep(fx, defaultParams(EFFECTS[fx]), 4, sel), env));
    const X0 = Math.floor(0.3 * W), X1 = Math.ceil(0.7 * W), Y0 = Math.floor(0.3 * H), Y1 = Math.ceil(0.6 * H);
    let outside = true; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (x >= X0 && x < X1 && y >= Y0 && y < Y1) continue; const i = (y * W + x) * 4; if (o[i] !== d0[i] || o[i + 1] !== d0[i + 1] || o[i + 2] !== d0[i + 2]) outside = false; }
    ok(outside, fx + ' stays inside selection');
  }
  // speed at full working size
  const BW = 1200, BH = 900, big = encodeBMP(img(BW, BH, (x, y) => [(x * 3) & 255, (y * 5) & 255, (x ^ y) & 255]));
  const benv = { fmt: 'bmp', W: BW, H: BH, off: 54, stride: geom(BW).stride, protect: true, scanStart: 0 };
  const times = [];
  for (const d of EFFECT_LIST.filter(e => e.group === 'artcolour' || e.group === 'artform')) {
    const t0 = performance.now(); applyStep(big, makeStep(d.id, defaultParams(d), 1), benv); const ms = performance.now() - t0;
    times.push(d.id + ' ' + ms.toFixed(0) + 'ms'); ok(ms < 1500, d.id + ' under 1.5s at 1200x900 (' + ms.toFixed(0) + 'ms)');
  }
  console.log('art timings @1200x900:', times.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
