// Virtualized hex view of the result bytes. Edits are reported, not applied.
const ROWH = 20, BPR = 16;

/** opts: { scroll, inner, getBytes(), getHdrEnd(), onEdit(offset, value) } */
export function createHex(opts) {
  const { scroll, inner } = opts;
  let editing = null, raf = 0;

  const parseByte = v => { const s = (v || '').replace(/[^0-9a-fA-F]/g, '').slice(0, 2); return s ? parseInt(s, 16) & 255 : null; };

  function closeEdit(commit) {
    if (editing == null) return;
    const ed = inner.querySelector('#hexedit'), o = editing; editing = null;
    if (commit && ed) { const v = parseByte(ed.value), b = opts.getBytes(); if (v != null && b && v !== b[o]) { opts.onEdit(o, v); return; } }
    draw();
  }

  function draw() {
    raf = 0;
    const bytes = opts.getBytes(); if (!bytes) { inner.innerHTML = ''; return; }
    const len = bytes.length, rows = Math.ceil(len / BPR);
    inner.style.height = rows * ROWH + 'px';
    const st = scroll.scrollTop, vh = scroll.clientHeight;
    const first = Math.max(0, Math.floor(st / ROWH) - 4), last = Math.min(rows, Math.ceil((st + vh) / ROWH) + 4);
    const hdrEnd = opts.getHdrEnd();
    let html = '';
    for (let rr = first; rr < last; rr++) {
      const off = rr * BPR; let bh = '', ascii = '';
      for (let c = 0; c < BPR; c++) {
        const o = off + c;
        if (o >= len) { bh += '   ' + (c === 7 ? ' ' : ''); ascii += ' '; continue; }
        const v = bytes[o], hx = v.toString(16).padStart(2, '0');
        if (editing === o) bh += `<input class="edit" id="hexedit" maxlength="2" value="${hx}">`;
        else bh += `<span class="by${o < hdrEnd ? ' hdr' : v === 0 ? ' b0' : ''}" data-o="${o}">${hx}</span>`;
        bh += c === 7 ? '  ' : ' ';
        ascii += v >= 32 && v < 127 ? (v === 60 ? '&lt;' : v === 38 ? '&amp;' : v === 62 ? '&gt;' : String.fromCharCode(v)) : '·';
      }
      html += `<div class="hxrow" style="top:${rr * ROWH}px"><span class="hxoff">${off.toString(16).padStart(8, '0')}</span><span class="hxbytes">${bh}</span><span class="hxascii">${ascii}</span></div>`;
    }
    inner.innerHTML = html;
    const ed = inner.querySelector('#hexedit');
    if (ed) {
      ed.focus(); ed.select();
      ed.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); closeEdit(true); } else if (e.key === 'Escape') { e.stopPropagation(); closeEdit(false); } });
      ed.addEventListener('blur', () => { if (editing != null) closeEdit(true); });
    }
  }

  inner.addEventListener('mousedown', e => {
    const t = e.target.closest('.by'); if (!t) return;
    e.preventDefault();
    const o = +t.dataset.o;
    if (editing != null) closeEdit(true);
    editing = o; draw();
  });
  scroll.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(draw); });

  return {
    render() { if (!raf) raf = requestAnimationFrame(draw); },
    goto(offset) { scroll.scrollTop = Math.floor(offset / BPR) * ROWH; },
  };
}
