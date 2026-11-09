// DATABENDER v2 — app wiring. Engine lives in ./engine, UI pieces in ./ui.
import { encodeBMP, decodeBMP, bmpInfo, isBMP, geom, BMP_HEADER } from './engine/bmp.js';
import { isJPEG, jpegLayout, sanitizeJPEG } from './engine/jpeg.js';
import { EFFECTS } from './engine/effects.js';
import { replay, runSteps, makeStep, cloneSteps, randomSteps, serializeRecipe, parseRecipe, regionOf, stepActive } from './engine/pipeline.js';
import { mulberry32, mixSeed } from './engine/util.js';
import { buildRack } from './ui/panel.js';
import { createStack } from './ui/stack.js';
import { createHex } from './ui/hex.js';
import { createTerrain } from './ui/terrain.js';
import { createSelection } from './ui/selection.js';
import { createVariations } from './ui/variations.js';

export const VERSION = '2.0.1';
const MAXDIM = 1200, UNDO_CAP = 100;
const $ = id => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d', { willReadFrequently: true });
const VIEW_DEFAULT = { dw: 0, fmt: 'bgr24', pad: true, flip: true, fill: false, nudge: 0, trustDims: false };

const S = {
  src: null,                 // { img:{width,height,data}, W, H, name, raw:{bmp?,jpeg?}, enc:{bmp?,jpeg?:{q,bytes}} }
  fmt: 'bmp', jq: 80, useRawJpeg: true, jsafe: true, protect: true,
  base: null, env: null, steps: [], cache: [], bytes: null,
  edit: -1, sel: null, seed: 1337, counter: 0,
  view: { ...VIEW_DEFAULT },
  undo: [], redo: [], ab: false, lastEditUndo: 0,
  pendingFrom: Infinity, raf: 0, renderTok: 0, baseTok: 0, frameOk: true,
};
window.__databender = S;   // handy for console poking / tests

// ---------- small utils ----------
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 1700); }
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1500); }
const stem = () => ((S.src && S.src.name) || 'databend').replace(/\.[^.]+$/, '');
const def = fx => EFFECTS[fx];

function loadImageEl(blob) {
  return new Promise(res => {
    const url = URL.createObjectURL(blob), im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im.naturalWidth ? im : null); };
    im.onerror = () => { URL.revokeObjectURL(url); res(null); };
    im.src = url;
  });
}
function rgbaFrom(el, maxDim = 0) {
  let w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
  const s = maxDim ? Math.min(1, maxDim / Math.max(w, h)) : 1;
  w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); x.drawImage(el, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h);
  return { img: { width: w, height: h, data: d.data }, scaled: s < 1 };
}
function encodeJPEG(img, q) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return new Promise((res, rej) => c.toBlob(b => (b ? b.arrayBuffer().then(a => res(new Uint8Array(a))) : rej(new Error('jpeg encode failed'))), 'image/jpeg', q));
}

// ---------- decode (bytes → drawable) ----------
async function decodeFor(bytes) {
  if (!bytes || !S.env) return null;
  if (S.fmt === 'bmp') {
    const d = decodeBMP(bytes, S.env.W, S.env.H, S.view);
    return { data: new ImageData(d.data, d.width, d.height) };
  }
  const b = S.jsafe ? sanitizeJPEG(bytes, S.env.scanStart) : bytes;
  const el = await loadImageEl(new Blob([b], { type: 'image/jpeg' }));
  return el ? { el } : null;
}
function drawInto(canvas, res) {
  const w = res.data ? res.data.width : res.el.naturalWidth, h = res.data ? res.data.height : res.el.naturalHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const x = canvas === cv ? ctx : canvas.getContext('2d');
  if (res.data) x.putImageData(res.data, 0, 0); else { x.clearRect(0, 0, w, h); x.drawImage(res.el, 0, 0); }
}
async function renderMain() {
  const tok = ++S.renderTok;
  const res = await decodeFor(S.ab ? S.base : S.bytes);
  if (tok !== S.renderTok) return;
  S.frameOk = !!res;
  $('decfail').hidden = S.frameOk;
  if (res) drawInto(cv, res);
  terrain.markDirty();
  selection.place();
  $('mDim').textContent = cv.width + '×' + cv.height;
}
async function renderThumb(bytes, canvas) {
  const res = await decodeFor(bytes), x = canvas.getContext('2d');
  x.fillStyle = '#0a0c10'; x.fillRect(0, 0, canvas.width, canvas.height);
  if (!res) return false;
  const tmp = document.createElement('canvas'); drawInto(tmp, res);
  const s = Math.min(canvas.width / tmp.width, canvas.height / tmp.height), w = tmp.width * s, h = tmp.height * s;
  x.imageSmoothingQuality = 'high';
  x.drawImage(tmp, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  return true;
}

// ---------- base / env / replay ----------
async function getBase() {
  const src = S.src;
  if (S.fmt === 'bmp') return src.raw.bmp || (src.enc.bmp || (src.enc.bmp = encodeBMP(src.img)));
  if (src.raw.jpeg && S.useRawJpeg) return src.raw.jpeg;
  if (src.enc.jpeg && src.enc.jpeg.q === S.jq) return src.enc.jpeg.bytes;
  const bytes = await encodeJPEG(src.img, S.jq / 100);
  src.enc.jpeg = { q: S.jq, bytes };
  return bytes;
}
function buildEnv(base) {
  const src = S.src;
  if (S.fmt === 'jpeg') return { fmt: 'jpeg', W: src.W, H: src.H, off: 0, stride: src.W * 3, protect: S.protect, scanStart: jpegLayout(base).scanStart };
  let W = src.W, H = src.H, off = BMP_HEADER;
  if (src.raw.bmp) { const inf = bmpInfo(base); W = inf.w; H = inf.h; off = inf.off; }
  return { fmt: 'bmp', W, H, off, stride: geom(W).stride, protect: S.protect, scanStart: 0 };
}
async function rebase() {
  if (!S.src) return;
  const tok = ++S.baseTok;
  let base;
  try { base = await getBase(); } catch (e) { toast(e.message); return; }
  if (tok !== S.baseTok) return;
  S.base = base; S.env = buildEnv(base); S.cache = [];
  schedule(0);
}
function schedule(from) {
  S.pendingFrom = Math.min(S.pendingFrom, from);
  if (!S.raf) S.raf = requestAnimationFrame(flush);
}
function flush() {
  S.raf = 0;
  const from = S.pendingFrom; S.pendingFrom = Infinity;
  if (!S.base) return;
  S.bytes = replay(S.base, S.steps, S.env, S.cache, from === Infinity ? S.steps.length : from);
  renderMain();
  renderUI();
}

// ---------- UI refresh ----------
function renderUI() {
  const env = S.env || { fmt: S.fmt };
  stack.render(S.steps, env, S.edit);
  const active = S.steps.filter(s => stepActive(s, env)).length;
  $('stackK').textContent = S.steps.length + ' step' + (S.steps.length === 1 ? '' : 's');
  $('btnUndo').disabled = !S.undo.length; $('btnRedo').disabled = !S.redo.length;
  const sel = S.edit >= 0 && S.steps[S.edit] ? S.steps[S.edit].sel : S.sel;
  $('mSel').hidden = !sel; if (sel) $('mSelV').textContent = Math.round((sel.x1 - sel.x0) * 100) + '×' + Math.round((sel.y1 - sel.y0) * 100) + '%' + (S.edit >= 0 ? ' (step ' + (S.edit + 1) + ')' : '');
  if (!S.bytes) return;
  $('mFmt').textContent = S.fmt.toUpperCase();
  $('mLen').textContent = S.bytes.length.toLocaleString();
  $('mOffLab').firstChild.textContent = S.fmt === 'jpeg' ? 'scan@ ' : 'data@ ';
  $('mOff').textContent = '0x' + (S.fmt === 'jpeg' ? S.env.scanStart : S.env.off).toString(16);
  const d = S.bytes.length - S.base.length; $('mDelta').textContent = (d >= 0 ? '+' : '') + d;
  $('mSteps').textContent = active + (active !== S.steps.length ? ' / ' + S.steps.length : '');
  hex.render();
  updateReadouts();
}
function updateReadouts() {
  if (!S.bytes || !S.env) return;
  const [s, e] = regionOf(S.bytes, S.env);
  for (const id of rack.readoutIds()) rack.setReadout(id, def(id).readout(rack.get(id), { s, e }));
}
function syncFormatUI() {
  [...$('fmtSeg').children].forEach(b => b.classList.toggle('on', b.dataset.v === S.fmt));
  $('jpegOpts').hidden = S.fmt !== 'jpeg'; $('bmpOpts').hidden = S.fmt !== 'bmp';
  $('jrawWrap').hidden = !(S.src && S.src.raw.jpeg);
  $('btnRaw').textContent = S.fmt === 'jpeg' ? 'Save .jpg' : 'Save .bmp';
  $('jumpPix').textContent = S.fmt === 'jpeg' ? 'Jump to scan' : 'Jump to pixels';
  rack.setContainer(S.fmt);
}
function syncViewUI() {
  const v = S.view;
  $('dw').value = v.dw; $('dwV').textContent = v.dw; $('dfmt').value = v.fmt; $('dnudge').value = v.nudge; $('dnV').textContent = v.nudge;
  $('dpad').checked = v.pad; $('dflip').checked = v.flip; $('dfill').checked = v.fill; $('trustdims').checked = v.trustDims;
  $('protect').checked = S.protect; $('jsafe').checked = S.jsafe; $('jq').value = S.jq; $('jqV').textContent = S.jq;
}

// ---------- undo / redo ----------
const snapshot = () => ({ src: S.src, fmt: S.fmt, steps: cloneSteps(S.steps), view: { ...S.view } });
function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > UNDO_CAP) S.undo.shift(); S.redo = []; }
function coalescedUndo() { const now = performance.now(); if (now - S.lastEditUndo > 700) pushUndo(); S.lastEditUndo = now; }
function firstDiff(a, b) { let i = 0; const n = Math.min(a.length, b.length); while (i < n && JSON.stringify(a[i]) === JSON.stringify(b[i])) i++; return i; }
async function restore(snap) {
  const needBase = snap.src !== S.src || snap.fmt !== S.fmt;
  const from = needBase ? 0 : firstDiff(S.steps, snap.steps);
  S.steps = cloneSteps(snap.steps); stopEdit(false);
  if (snap.view && JSON.stringify(snap.view) !== JSON.stringify(S.view)) { S.view = { ...snap.view }; syncViewUI(); renderMain(); }
  if (needBase) { S.src = snap.src; S.fmt = snap.fmt; syncFormatUI(); await rebase(); } else schedule(from);
  renderUI();
}
function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); toast('undo'); }
function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); toast('redo'); }

// ---------- steps ----------
const nextSeed = () => mixSeed(S.seed, 0x51ED + S.counter++);
function addSteps(list, msg) {
  pushUndo();
  const from = S.steps.length;
  S.steps.push(...list);
  stopEdit(false);
  schedule(from);
  if (msg) toast(msg);
}
function onApply(fx, params) {
  if (!S.base) return;
  const d = def(fx);
  if (S.fmt === 'jpeg' && d.kind === 'pixel') { toast('pixel effects need the BMP container'); return; }
  addSteps([makeStep(fx, params, nextSeed(), S.sel)], d.name + (S.sel ? ' · in selection' : ''));
}
function onParam(fx, params) {
  const st = S.steps[S.edit];
  if (st && st.fx === fx) { coalescedUndo(); st.p = params; schedule(S.edit); }
  else updateReadouts();
}
function startEdit(i) {
  const st = S.steps[i]; if (!st) return;
  const d = def(st.fx);
  S.edit = i;
  if (d.raw) { hex.goto(st.p.offset); rack.setEditing(null); }
  else { rack.set(st.fx, st.p); rack.setEditing(st.fx, i); rack.reveal(st.fx); }
  selection.set(st.sel); $('selbox').classList.add('edit');
  renderUI();
}
function stopEdit(render = true) {
  S.edit = -1; rack.setEditing(null); selection.set(S.sel); $('selbox').classList.remove('edit');
  if (render) renderUI();
}
const stackHandlers = {
  select: i => (S.edit === i ? stopEdit() : startEdit(i)),
  toggle: i => { pushUndo(); S.steps[i].on = !S.steps[i].on; schedule(i); },
  remove: i => { pushUndo(); S.steps.splice(i, 1); stopEdit(false); schedule(i); },
  move: (i, dir) => { const j = i + dir; if (j < 0 || j >= S.steps.length) return; pushUndo(); [S.steps[i], S.steps[j]] = [S.steps[j], S.steps[i]]; stopEdit(false); schedule(Math.min(i, j)); },
  reseed: i => { pushUndo(); S.steps[i].seed = nextSeed(); schedule(i); toast('step ' + (i + 1) + ' reseeded'); },
};
function randomCorrupt() {
  if (!S.base) return;
  const k = S.counter++, r = mulberry32(mixSeed(S.seed, 0xA5A5 + k)), n = 2 + Math.floor(r() * 3);
  addSteps(randomSteps(r, n, S.fmt, mixSeed(S.seed, k * 7919 + 13), S.sel), 'corrupted · seed ' + S.seed + ' #' + k + ' · +' + n + ' steps');
}

// ---------- loading ----------
function newSource(img, name, raw = {}) { return { img, W: img.width, H: img.height, name, raw, enc: {} }; }
async function setSource(src, msg) {
  if (S.src) pushUndo();
  if (S.src && !$('keepStack').checked) S.steps = [];
  S.src = src; S.sel = null; stopEdit(false); selection.set(null);
  ['btnRandom', 'btnVar', 'btnReset', 'btnAB', 'btnPng', 'btnRaw', 'btnBake', 'btn3D'].forEach(id => { $(id).disabled = false; });
  $('empty').hidden = true; $('meta').hidden = false; $('hexwrap').hidden = false; $('selhint').hidden = false;
  if (!terrain.isOn()) cv.hidden = false;
  $('rack').classList.remove('locked');
  syncFormatUI();
  await rebase();
  toast(msg + (S.steps.length ? ' · stack re-applied (' + S.steps.length + ')' : ''));
}
async function handleFile(file) {
  if (!file) return;
  const name = file.name || 'image';
  if (/\.json$/i.test(name) || file.type === 'application/json') { loadRecipeText(await file.text()); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isBMP(bytes)) {
    const inf = bmpInfo(bytes), img = decodeBMP(bytes, inf.w, inf.h, {});
    await setSource(newSource(img, name, { bmp: bytes }), 'loaded raw .bmp · ' + bytes.length.toLocaleString() + ' bytes' + (inf.bpp !== 24 ? ' · ' + inf.bpp + '-bit read as 24' : ''));
    return;
  }
  const el = await loadImageEl(new Blob([bytes], { type: file.type || 'image/*' }));
  if (!el) { toast('could not decode that image'); return; }
  const { img, scaled } = rgbaFrom(el, MAXDIM);
  const raw = {}; let note = scaled ? 'scaled to ' + img.width + '×' + img.height : 'loaded ' + img.width + '×' + img.height;
  if (isJPEG(bytes) && !scaled) {
    if (jpegLayout(bytes).progressive) note += ' · progressive JPEG → re-encoded as baseline';
    else { raw.jpeg = bytes; note += ' · original JPEG bytes kept'; }
  }
  await setSource(newSource(img, name, raw), note);
}

// ---------- recipes ----------
function saveRecipe() {
  const txt = serializeRecipe({ fmt: S.fmt, jq: S.jq, protect: S.protect, jsafe: S.jsafe, view: S.view, seed: S.seed, steps: S.steps });
  download(new Blob([txt], { type: 'application/json' }), stem() + '-recipe.json');
}
async function loadRecipeText(text) {
  let r;
  try { r = parseRecipe(text); } catch (e) { toast('recipe: ' + e.message); return; }
  pushUndo();
  S.steps = r.steps; stopEdit(false);
  if (r.view) S.view = { ...VIEW_DEFAULT, ...r.view };
  if (typeof r.protect === 'boolean') S.protect = r.protect;
  if (typeof r.jsafe === 'boolean') S.jsafe = r.jsafe;
  if (r.jq) S.jq = Math.max(5, Math.min(100, r.jq | 0));
  if (r.fmt === 'bmp' || r.fmt === 'jpeg') S.fmt = r.fmt;
  syncViewUI(); syncFormatUI();
  const msg = 'recipe · ' + r.steps.length + ' steps' + (r.dropped ? ' (' + r.dropped + ' unknown dropped)' : '');
  if (S.src) { await rebase(); toast(msg); } else { renderUI(); toast(msg + ' — now load an image'); }
}

// ---------- build UI ----------
const rack = buildRack($('fxRack'), { onApply, onParam });
const stack = createStack($('stack'), stackHandlers);
const hex = createHex({
  scroll: $('hexscroll'), inner: $('hexinner'),
  getBytes: () => S.bytes,
  getHdrEnd: () => (!S.env || !S.protect ? 0 : S.fmt === 'jpeg' ? S.env.scanStart : S.env.off),
  onEdit: (o, v) => addSteps([makeStep('poke', { offset: o, value: v }, 0)], 'byte 0x' + o.toString(16) + ' = ' + v.toString(16).padStart(2, '0')),
});
const terrain = createTerrain($('gl'), cv, $, toast, download);
const selection = createSelection($('scope'), cv, $('selbox'), rect => {
  if (!S.base) return;
  const st = S.steps[S.edit];
  if (st) { pushUndo(); st.sel = rect; schedule(S.edit); toast(rect ? 'step ' + (S.edit + 1) + ' limited to selection' : 'step ' + (S.edit + 1) + ' selection cleared'); }
  else S.sel = rect;
  renderUI();
});
const variations = createVariations($('vover'), {
  nextBatchSeed: () => mixSeed(S.seed, 0xBEEF + S.counter++),
  make(mode, k, batch) {
    const r = mulberry32(mixSeed(batch, k + 1));
    const names = st => st.map(s => def(s.fx).name).join(' + ');
    if (mode === 'reseed' && S.steps.length) {
      const steps = cloneSteps(S.steps).map((s, i) => (def(s.fx).raw ? s : { ...s, seed: mixSeed(batch, k * 131 + i + 1) }));
      return { from: S.base, extra: steps, steps, label: 'reseed ' + (k + 1) };
    }
    if (mode === 'extend') {
      const extra = randomSteps(r, 1 + Math.floor(r() * 2), S.fmt, mixSeed(batch, 100 + k), S.sel);
      return { from: S.bytes, extra, steps: [...cloneSteps(S.steps), ...extra], label: '+ ' + names(extra) };
    }
    const extra = randomSteps(r, 2 + Math.floor(r() * 3), S.fmt, mixSeed(batch, 200 + k), null);
    return { from: S.base, extra, steps: extra, label: names(extra) };
  },
  render: renderThumb,
  pick(c) { const from = firstDiff(S.steps, c.steps); pushUndo(); S.steps = cloneSteps(c.steps); stopEdit(false); schedule(from); toast('variation adopted'); },
}, (from, steps) => runSteps(from, steps, S.env));

// ---------- wiring ----------
$('ver').textContent = 'v' + VERSION;
$('rack').classList.add('locked');
syncFormatUI(); syncViewUI(); renderUI();

$('file').addEventListener('change', e => { handleFile(e.target.files[0]); e.target.value = ''; });
$('stLoad').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadRecipeText(await f.text()); });
const scopeEl = $('scope');
['dragenter', 'dragover'].forEach(ev => scopeEl.addEventListener(ev, e => { e.preventDefault(); scopeEl.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => scopeEl.addEventListener(ev, e => { e.preventDefault(); scopeEl.classList.remove('drag'); }));
scopeEl.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

$('btnRandom').addEventListener('click', randomCorrupt);
$('btnVar').addEventListener('click', () => { if (S.base) variations.open(); });
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);
$('btnReset').addEventListener('click', () => {
  if (!S.base) return;
  const viewDirty = JSON.stringify(S.view) !== JSON.stringify(VIEW_DEFAULT);
  if (!S.steps.length && !viewDirty && !S.sel) { toast('already at source'); return; }
  pushUndo();
  S.steps = []; S.sel = null; stopEdit(false); selection.set(null);
  if (viewDirty) { S.view = { ...VIEW_DEFAULT }; syncViewUI(); }
  schedule(0); toast('reset to source');
});
const setAB = on => { if (!S.base || S.ab === on) return; S.ab = on; scopeEl.classList.toggle('ab', on); renderMain(); };
$('btnAB').addEventListener('pointerdown', () => setAB(true));
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => $('btnAB').addEventListener(ev, () => setAB(false)));
$('btnPng').addEventListener('click', () => cv.toBlob(b => download(b, stem() + '-databend.png'), 'image/png'));
$('btnRaw').addEventListener('click', () => {
  if (!S.bytes) return;
  if (S.fmt === 'jpeg') download(new Blob([S.jsafe ? sanitizeJPEG(S.bytes, S.env.scanStart) : S.bytes], { type: 'image/jpeg' }), stem() + '-databend.jpg');
  else download(new Blob([S.bytes], { type: 'image/bmp' }), stem() + '-databend.bmp');
});
$('btnBake').addEventListener('click', async () => {
  if (!S.bytes || !S.frameOk) { toast('nothing decodable to bake'); return; }
  const d = ctx.getImageData(0, 0, cv.width, cv.height);
  pushUndo();
  S.src = newSource({ width: d.width, height: d.height, data: d.data }, stem() + '-baked.png');
  S.steps = []; S.view = { ...VIEW_DEFAULT }; stopEdit(false); syncViewUI(); syncFormatUI();
  await rebase(); toast('baked ' + d.width + '×' + d.height + ' → new source');
});
$('btn3D').addEventListener('click', () => { terrain.toggle(); selection.place(); });

$('stSave').addEventListener('click', saveRecipe);
$('stReseed').addEventListener('click', () => { if (!S.steps.length) return; pushUndo(); S.steps.forEach(s => { if (!def(s.fx).raw) s.seed = nextSeed(); }); schedule(0); toast('all steps reseeded'); });
$('stClear').addEventListener('click', () => { if (!S.steps.length) return; pushUndo(); S.steps = []; stopEdit(false); schedule(0); toast('stack cleared'); });

$('fmtSeg').addEventListener('click', async e => {
  const b = e.target.closest('[data-v]'); if (!b || b.dataset.v === S.fmt) return;
  pushUndo(); S.fmt = b.dataset.v; syncFormatUI();
  if (S.src) { await rebase(); const skipped = S.steps.filter(s => s.on && !stepActive(s, S.env)).length; toast(S.fmt.toUpperCase() + ' container' + (skipped ? ' · ' + skipped + ' pixel steps skipped' : '')); }
});
$('protect').addEventListener('change', e => { S.protect = e.target.checked; if (S.env) { S.env.protect = S.protect; S.cache = []; schedule(0); } });
$('jsafe').addEventListener('change', e => { S.jsafe = e.target.checked; renderMain(); });
$('jraw').addEventListener('change', e => { S.useRawJpeg = e.target.checked; rebase(); });
let jqT = 0;
$('jq').addEventListener('input', e => {
  S.jq = +e.target.value; $('jqV').textContent = S.jq;
  if (S.src && S.src.raw.jpeg && S.useRawJpeg) { S.useRawJpeg = false; $('jraw').checked = false; }
  clearTimeout(jqT); jqT = setTimeout(rebase, 160);
});
const viewCtl = (id, key, read, lab) => $(id).addEventListener('input', e => { S.view[key] = read(e.target); if (lab) $(lab).textContent = S.view[key]; renderMain(); });
viewCtl('dw', 'dw', t => +t.value, 'dwV');
viewCtl('dnudge', 'nudge', t => +t.value, 'dnV');
viewCtl('dpad', 'pad', t => t.checked);
viewCtl('dflip', 'flip', t => t.checked);
viewCtl('dfill', 'fill', t => t.checked);
viewCtl('trustdims', 'trustDims', t => t.checked);
$('dfmt').addEventListener('change', e => { S.view.fmt = e.target.value; renderMain(); });
$('dReset').addEventListener('click', () => { S.view = { ...VIEW_DEFAULT }; syncViewUI(); renderMain(); });

$('seed').addEventListener('input', e => { S.seed = (+e.target.value >>> 0) || 0; S.counter = 0; $('seedVal').textContent = S.seed; });
$('seedRnd').addEventListener('click', () => { S.seed = Math.floor(Math.random() * 1e6); S.counter = 0; $('seed').value = S.seed; $('seedVal').textContent = S.seed; });

$('gotoBtn').addEventListener('click', gotoOffset);
$('goto').addEventListener('keydown', e => { if (e.key === 'Enter') gotoOffset(); });
function gotoOffset() { const v = parseInt(($('goto').value || '').replace(/[^0-9a-fA-F]/g, ''), 16); if (!isNaN(v)) hex.goto(v); }
$('jumpPix').addEventListener('click', () => { if (S.env) hex.goto(S.fmt === 'jpeg' ? S.env.scanStart : S.env.off); });

const typing = t => t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && /^(text|number|search)$/.test(t.type)));
window.addEventListener('keydown', e => {
  if (typing(e.target)) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  if (k === 'r' && S.base) randomCorrupt();
  else if (k === 'v' && S.base && $('vover').hidden) variations.open();
  else if (e.key === '\\' && !e.repeat) setAB(true);
  else if (e.key === 'Escape') { if (S.edit >= 0) stopEdit(); else if (S.sel) { S.sel = null; selection.set(null); renderUI(); } }
});
window.addEventListener('keyup', e => { if (e.key === '\\') setAB(false); });
