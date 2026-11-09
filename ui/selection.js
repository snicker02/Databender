// Drag a rectangle on the 2D canvas → normalized selection {x0,y0,x1,y1} (y down).
export function createSelection(scope, cv, box, onChange) {
  let rect = null, drag = null;

  const norm = e => {
    const r = cv.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  function place() {
    if (!rect || cv.hidden) { box.hidden = true; return; }
    const r = cv.getBoundingClientRect(), s = scope.getBoundingClientRect();
    box.hidden = false;
    box.style.left = (r.left - s.left + rect.x0 * r.width) + 'px';
    box.style.top = (r.top - s.top + rect.y0 * r.height) + 'px';
    box.style.width = ((rect.x1 - rect.x0) * r.width) + 'px';
    box.style.height = ((rect.y1 - rect.y0) * r.height) + 'px';
  }
  const fromPts = (a, b) => ({ x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) });

  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { a: norm(e), moved: false }; cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const b = norm(e), r = cv.getBoundingClientRect();
    if (Math.abs(b[0] - drag.a[0]) * r.width > 3 || Math.abs(b[1] - drag.a[1]) * r.height > 3) drag.moved = true;
    if (drag.moved) { rect = fromPts(drag.a, b); place(); }
  });
  const up = e => {
    if (!drag) return;
    const moved = drag.moved, drag0 = drag.a; drag = null;
    if (!moved) { rect = null; place(); onChange(null); return; }
    const r = fromPts(drag0, norm(e));
    rect = r.x1 - r.x0 > 0.002 && r.y1 - r.y0 > 0.002 ? r : null;
    place(); onChange(rect ? { ...rect } : null);
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', () => { drag = null; });
  window.addEventListener('resize', place);
  new ResizeObserver(place).observe(scope);

  return {
    set(r) { rect = r ? { ...r } : null; place(); },
    get: () => (rect ? { ...rect } : null),
    place,
  };
}
