// Builds the effect rack from the effect registry.
import { GROUPS, EFFECT_LIST, defaultParams } from '../engine/effects.js';

const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * handlers: onApply(fx, params), onParam(fx, params), onFocusFx(fx)
 * returns API to read/write controls and reflect editing / container state.
 */
export function buildRack(container, handlers) {
  const blocks = {};      // fx -> { el, values, setters, readout, btn, tag, def }
  const groupEls = {};

  for (const [gid, gname, gk] of GROUPS) {
    const defs = EFFECT_LIST.filter(d => d.group === gid);
    if (!defs.length) continue;
    const det = h('details', 'mod fxgroup');
    det.dataset.group = gid;
    det.appendChild(h('summary', null, `<span class="dot"></span>${esc(gname)}<span class="k">${esc(gk)}</span>`));
    const body = h('div', 'modbody');
    det.appendChild(body);
    for (const def of defs) body.appendChild(buildBlock(def));
    container.appendChild(det);
    groupEls[gid] = det;
  }

  function buildBlock(def) {
    const el = h('div', 'fx'); el.dataset.fx = def.id;
    const head = h('div', 'fxhead', `<span class="fxname">${esc(def.name)}</span>` +
      (def.kind === 'pixel' ? '<span class="badge" title="Needs BMP pixel layout">px</span>' : '') +
      (def.len ? '<span class="badge len" title="Changes file length">±len</span>' : '') +
      '<span class="fxtag"></span>');
    el.appendChild(head);
    const values = defaultParams(def), setters = {};
    const emit = () => handlers.onParam(def.id, { ...values });

    for (const q of def.params) {
      const ctl = h('div', 'ctl');
      if (q.t === 'range') {
        const lab = h('div', 'lab', `${esc(q.label)} <b></b>`), out = lab.querySelector('b');
        const inp = h('input'); inp.type = 'range'; inp.min = q.min; inp.max = q.max; inp.step = q.step || 1; inp.value = q.def;
        const show = v => { out.textContent = q.fmt ? q.fmt(v) : v; };
        inp.addEventListener('input', () => { values[q.k] = +inp.value; show(inp.value); emit(); });
        setters[q.k] = v => { inp.value = v; values[q.k] = +inp.value; show(inp.value); };
        show(q.def); ctl.append(lab, inp);
      } else if (q.t === 'seg') {
        ctl.appendChild(h('div', 'lab', esc(q.label)));
        const seg = h('div', 'seg');
        const btns = q.opts.map(([v, l]) => { const b = h('button', null, esc(l)); b.type = 'button'; b.dataset.v = v; seg.appendChild(b); return b; });
        const mark = v => btns.forEach(b => b.classList.toggle('on', b.dataset.v === String(v)));
        const cast = s => (typeof q.opts[0][0] === 'number' ? +s : s);
        seg.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; values[q.k] = cast(b.dataset.v); mark(b.dataset.v); emit(); });
        setters[q.k] = v => { values[q.k] = v; mark(v); };
        mark(q.def); ctl.appendChild(seg);
      } else if (q.t === 'select') {
        const row = h('div', 'row');
        row.appendChild(h('span', 'lab', esc(q.label)));
        const sel = h('select', 'grow');
        for (const [v, l] of q.opts) { const o = h('option', null, esc(l)); o.value = v; sel.appendChild(o); }
        sel.value = q.def;
        sel.addEventListener('change', () => { values[q.k] = sel.value; emit(); });
        setters[q.k] = v => { sel.value = v; values[q.k] = v; };
        row.appendChild(sel); ctl.appendChild(row);
      } else if (q.t === 'text') {
        const row = h('div', 'row');
        row.appendChild(h('span', 'lab', esc(q.label)));
        const inp = h('input', 'grow'); inp.type = 'text'; inp.value = q.def; inp.placeholder = q.ph || '';
        inp.addEventListener('input', () => { values[q.k] = inp.value; emit(); });
        setters[q.k] = v => { inp.value = v; values[q.k] = v; };
        row.appendChild(inp); ctl.appendChild(row);
      } else continue;
      el.appendChild(ctl);
    }
    const readout = def.readout ? h('div', 'hint readout') : null;
    if (readout) el.appendChild(readout);
    if (def.hint) el.appendChild(h('div', 'hint', esc(def.hint)));
    const btn = h('button', 'apply', '+ Apply'); btn.type = 'button';
    btn.addEventListener('click', () => handlers.onApply(def.id, { ...values }));
    el.appendChild(btn);
    el.addEventListener('pointerdown', () => handlers.onFocusFx && handlers.onFocusFx(def.id), true);
    blocks[def.id] = { el, values, setters, readout, btn, tag: head.querySelector('.fxtag'), def };
    return el;
  }

  return {
    get: fx => ({ ...blocks[fx].values }),
    set(fx, params) { const b = blocks[fx]; if (!b) return; for (const k in params) if (b.setters[k]) b.setters[k](params[k]); },
    setEditing(fx, idx) {
      for (const id in blocks) {
        const b = blocks[id], on = id === fx;
        b.el.classList.toggle('editing', on);
        b.tag.textContent = on ? 'editing step ' + (idx + 1) : '';
      }
    },
    reveal(fx) {
      const b = blocks[fx]; if (!b) return;
      const g = groupEls[b.def.group]; if (g) g.open = true;
      b.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    setContainer(fmt) {
      for (const id in blocks) {
        const b = blocks[id], off = fmt === 'jpeg' && b.def.kind === 'pixel';
        b.el.classList.toggle('na', off);
        b.btn.disabled = off;
        b.btn.title = off ? 'Pixel effects need the BMP container' : '';
      }
    },
    setReadout(fx, text) { const b = blocks[fx]; if (b && b.readout) b.readout.textContent = text; },
    readoutIds: () => Object.keys(blocks).filter(id => blocks[id].readout),
  };
}
