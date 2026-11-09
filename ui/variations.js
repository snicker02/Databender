// 3×3 variations grid. The host supplies generation + rendering.
/**
 * host: {
 *   make(mode, k, batchSeed) -> { steps, from:Uint8Array, extra:steps }   // candidate k
 *   render(bytes, canvas) -> Promise<boolean>                          // draw a thumbnail
 *   pick(candidate)                                                    // adopt
 *   nextBatchSeed() -> number
 * }
 */
export function createVariations(root, host, runSteps) {
  const grid = root.querySelector('.vgrid'), status = root.querySelector('.vstatus');
  let mode = 'extend', token = 0, cands = [];

  root.querySelector('.vmode').addEventListener('click', e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    mode = b.dataset.v; [...b.parentNode.children].forEach(c => c.classList.toggle('on', c === b)); generate();
  });
  root.querySelector('.vregen').addEventListener('click', () => generate());
  root.querySelector('.vclose').addEventListener('click', close);
  root.addEventListener('click', e => { if (e.target === root) close(); });

  async function generate() {
    const my = ++token, seed = host.nextBatchSeed();
    grid.innerHTML = ''; cands = [];
    const tiles = [];
    for (let k = 0; k < 9; k++) {
      const t = document.createElement('button'); t.type = 'button'; t.className = 'vtile';
      const c = document.createElement('canvas'); c.width = 240; c.height = 180; t.appendChild(c);
      const lab = document.createElement('span'); t.appendChild(lab);
      t.addEventListener('click', () => { if (cands[k]) { host.pick(cands[k]); close(); } });
      grid.appendChild(t); tiles.push({ t, c, lab });
    }
    for (let k = 0; k < 9; k++) {
      if (my !== token) return;
      status.textContent = 'rendering ' + (k + 1) + ' / 9';
      await new Promise(r => setTimeout(r, 0));
      const cand = host.make(mode, k, seed);
      const bytes = runSteps(cand.from, cand.extra);
      cands[k] = cand;
      const ok = await host.render(bytes, tiles[k].c);
      if (my !== token) return;
      tiles[k].lab.textContent = cand.label + (ok ? '' : ' · undecodable');
      tiles[k].t.classList.toggle('bad', !ok);
    }
    status.textContent = 'click a tile to adopt it · seed batch ' + seed;
  }
  function open() { root.hidden = false; generate(); }
  function close() { token++; root.hidden = true; }
  window.addEventListener('keydown', e => { if (!root.hidden && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
  return { open, close };
}
