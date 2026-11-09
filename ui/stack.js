// Effect stack list (render only; all mutations go through handlers).
import { EFFECTS, summarize } from '../engine/effects.js';
import { stepActive } from '../engine/pipeline.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** handlers: select(i), toggle(i), remove(i), move(i,dir), reseed(i) */
export function createStack(listEl, handlers) {
  listEl.addEventListener('click', e => {
    const row = e.target.closest('.st'); if (!row) return;
    const i = +row.dataset.i, act = e.target.closest('[data-a]');
    if (act) { e.stopPropagation(); const a = act.dataset.a; if (a === 'up') handlers.move(i, -1); else if (a === 'dn') handlers.move(i, 1); else if (a === 'del') handlers.remove(i); else if (a === 'seed') handlers.reseed(i); else if (a === 'on') handlers.toggle(i); return; }
    handlers.select(i);
  });

  return {
    render(steps, env, editIdx) {
      if (!steps.length) { listEl.innerHTML = '<div class="hint stempty">Stack is empty. Every Apply adds a step here — click a step to edit it live.</div>'; return; }
      let html = '';
      steps.forEach((s, i) => {
        const def = EFFECTS[s.fx], live = stepActive(s, env), skipped = s.on && !live;
        html += `<div class="st${i === editIdx ? ' sel' : ''}${s.on ? '' : ' off'}${skipped ? ' skip' : ''}" data-i="${i}">` +
          `<span class="sti">${i + 1}</span>` +
          `<button type="button" class="sto" data-a="on" title="Enable / disable">${s.on ? '●' : '○'}</button>` +
          `<span class="stn">${esc(def.name)}${s.sel ? ' <em title="Limited to a selection">⌖</em>' : ''}${skipped ? ' <em title="Pixel step skipped in JPEG mode">n/a</em>' : ''}</span>` +
          `<span class="stp">${esc(summarize(def, s.p))}</span>` +
          `<span class="sta">` +
          (def.raw ? '' : `<button type="button" data-a="seed" title="Reseed (seed ${s.seed})">↻</button>`) +
          `<button type="button" data-a="up" title="Move up"${i ? '' : ' disabled'}>↑</button>` +
          `<button type="button" data-a="dn" title="Move down"${i < steps.length - 1 ? '' : ' disabled'}>↓</button>` +
          `<button type="button" data-a="del" title="Delete">✕</button></span></div>`;
      });
      listEl.innerHTML = html;
    },
  };
}
