// 3D terrain viewer (WebGL1). Reads the already-rendered 2D canvas.
const M4 = {
  persp(fovy, asp, n, f) { const t = 1 / Math.tan(fovy / 2), nf = 1 / (n - f); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * nf, -1, 0, 0, 2 * f * n * nf, 0]; },
  lookAt(e, c, u) {
    let z0 = e[0] - c[0], z1 = e[1] - c[1], z2 = e[2] - c[2]; const zl = Math.hypot(z0, z1, z2) || 1; z0 /= zl; z1 /= zl; z2 /= zl;
    let x0 = u[1] * z2 - u[2] * z1, x1 = u[2] * z0 - u[0] * z2, x2 = u[0] * z1 - u[1] * z0; const xl = Math.hypot(x0, x1, x2) || 1; x0 /= xl; x1 /= xl; x2 /= xl;
    const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
    return [x0, y0, z0, 0, x1, y1, z1, 0, x2, y2, z2, 0, -(x0 * e[0] + x1 * e[1] + x2 * e[2]), -(y0 * e[0] + y1 * e[1] + y2 * e[2]), -(z0 * e[0] + z1 * e[1] + z2 * e[2]), 1];
  },
  mul(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; },
};
const VERT = 'attribute vec3 a_pos;attribute vec3 a_col;attribute vec3 a_nrm;uniform mat4 u_mvp;varying vec3 v_col;varying vec3 v_nrm;' +
  'void main(){v_col=a_col;v_nrm=a_nrm;gl_PointSize=2.0;gl_Position=u_mvp*vec4(a_pos,1.0);}';
const FRAG = 'precision mediump float;varying vec3 v_col;varying vec3 v_nrm;uniform vec3 u_light;uniform float u_flat;' +
  'void main(){vec3 n=normalize(v_nrm);float d=max(dot(n,normalize(u_light)),0.0);float shade=mix(0.35+0.75*d,1.0,u_flat);gl_FragColor=vec4(v_col*shade,1.0);}';

function heightRamp(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const S = [[0.05, 0.07, 0.11], [0.07, 0.55, 0.75], [1.0, 0.17, 0.30], [1.0, 0.95, 0.92]];
  const seg = t * (S.length - 1), i = Math.min(S.length - 2, Math.floor(seg)), f = seg - i, a = S[i], b = S[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
function blurGrid(g, R, radius) {
  if (radius <= 0) return; const cnt = 2 * radius + 1, P = new Float32Array(R + 1), tmp = new Float32Array(R * R);
  const pass1 = (get, set) => {
    for (let j = 0; j < R; j++) {
      const v0 = get(j, 0), vL = get(j, R - 1); P[0] = 0; for (let i = 0; i < R; i++) P[i + 1] = P[i] + get(j, i);
      for (let i = 0; i < R; i++) { const lo = i - radius, hi = i + radius, lC = lo < 0 ? -lo : 0, rC = hi > R - 1 ? hi - (R - 1) : 0, rl = lo < 0 ? 0 : lo, rh = hi > R - 1 ? R - 1 : hi; set(j, i, (P[rh + 1] - P[rl] + lC * v0 + rC * vL) / cnt); }
    }
  };
  pass1((j, i) => g[j * R + i], (j, i, v) => { tmp[j * R + i] = v; });
  pass1((i, j) => tmp[j * R + i], (i, j, v) => { g[j * R + i] = v; });
}

/** ui: element lookup fn; toast; download(blob,name) */
export function createTerrain(glc, cv, $, toast, download) {
  const V = { on: false, gl: null, prog: null, loc: {}, buf: {}, triCount: 0, lineCount: 0, vertCount: 0, blockCount: 0,
    az: 0.7, el: 0.6, rad: 1.8, tx: 0, ty: 0, tz: 0, zScale: 0.35, source: 'lum', res: 140, mode: 'solid', colour: 'image', blur: 0, auto: false, raf: 0, drag: null, dirty: true };

  function init() {
    const o = { antialias: true, alpha: false, preserveDrawingBuffer: true };
    const gl = glc.getContext('webgl', o) || glc.getContext('experimental-webgl', o);
    if (!gl) { toast('WebGL not available'); return false; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(p)); toast('shader link failed'); return false; }
    V.gl = gl; V.prog = p;
    V.loc = { pos: gl.getAttribLocation(p, 'a_pos'), col: gl.getAttribLocation(p, 'a_col'), nrm: gl.getAttribLocation(p, 'a_nrm'),
      mvp: gl.getUniformLocation(p, 'u_mvp'), light: gl.getUniformLocation(p, 'u_light'), flat: gl.getUniformLocation(p, 'u_flat') };
    for (const k of ['pos', 'col', 'nrm', 'tri', 'line', 'bpos', 'bcol', 'bnrm']) V.buf[k] = gl.createBuffer();
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    return true;
  }

  function gridVals(img, W, H, R) {
    const val = new Float32Array(R * R), rgb = new Float32Array(R * R * 3);
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const px = Math.min(W - 1, Math.round(i / (R - 1) * (W - 1))), py = Math.min(H - 1, Math.round(j / (R - 1) * (H - 1))), pi = (py * W + px) * 4;
      const r = img[pi], g = img[pi + 1], b = img[pi + 2], n = j * R + i;
      val[n] = V.source === 'lum' ? (0.299 * r + 0.587 * g + 0.114 * b) / 255 : V.source === 'r' ? r / 255 : V.source === 'g' ? g / 255 : b / 255;
      rgb[n * 3] = r / 255; rgb[n * 3 + 1] = g / 255; rgb[n * 3 + 2] = b / 255;
    }
    return { val, rgb };
  }

  function build() {
    const gl = V.gl; if (!gl || !cv.width) return;
    const W = cv.width, H = cv.height, img = cv.getContext('2d').getImageData(0, 0, W, H).data;
    buildSmooth(gl, img, W, H);
    if (V.mode === 'blocks') buildBlocks(gl, img, W, H); else V.blockCount = 0;
    V.dirty = false;
  }
  function buildSmooth(gl, img, W, H) {
    const R = Math.max(8, V.res | 0), z = V.zScale, useImg = V.colour === 'image', sizeZ = H / W || 1, sx = 1 / (R - 1), sz = sizeZ / (R - 1);
    const { val, rgb } = gridVals(img, W, H, R); blurGrid(val, R, V.blur | 0);
    const pos = new Float32Array(R * R * 3), col = new Float32Array(R * R * 3), nrm = new Float32Array(R * R * 3), Y = new Float32Array(R * R);
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const n = j * R + i, y = (val[n] - 0.5) * z; Y[n] = y;
      pos[n * 3] = i / (R - 1) - 0.5; pos[n * 3 + 1] = y; pos[n * 3 + 2] = (j / (R - 1) - 0.5) * sizeZ;
      const c = useImg ? [rgb[n * 3], rgb[n * 3 + 1], rgb[n * 3 + 2]] : heightRamp(val[n]);
      col[n * 3] = c[0]; col[n * 3 + 1] = c[1]; col[n * 3 + 2] = c[2];
    }
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const n = j * R + i, il = i > 0 ? i - 1 : i, ir = i < R - 1 ? i + 1 : i, jd = j > 0 ? j - 1 : j, ju = j < R - 1 ? j + 1 : j;
      const dhx = (Y[j * R + ir] - Y[j * R + il]) / (((ir - il) || 1) * sx), dhz = (Y[ju * R + i] - Y[jd * R + i]) / (((ju - jd) || 1) * sz);
      const l = Math.hypot(dhx, 1, dhz) || 1; nrm[n * 3] = -dhx / l; nrm[n * 3 + 1] = 1 / l; nrm[n * 3 + 2] = -dhz / l;
    }
    const tri = new Uint16Array((R - 1) * (R - 1) * 6), line = new Uint16Array(2 * (2 * R * (R - 1)));
    let t = 0, l = 0;
    for (let j = 0; j < R - 1; j++) for (let i = 0; i < R - 1; i++) { const a = j * R + i, b = a + 1, c = a + R, d = c + 1; tri[t++] = a; tri[t++] = c; tri[t++] = b; tri[t++] = b; tri[t++] = c; tri[t++] = d; }
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) { const a = j * R + i; if (i < R - 1) { line[l++] = a; line[l++] = a + 1; } if (j < R - 1) { line[l++] = a; line[l++] = a + R; } }
    const up = (b, d, el) => { gl.bindBuffer(el ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER, b); gl.bufferData(el ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW); };
    up(V.buf.pos, pos); up(V.buf.col, col); up(V.buf.nrm, nrm); up(V.buf.tri, tri, true); up(V.buf.line, line, true);
    V.triCount = t; V.lineCount = l; V.vertCount = R * R;
  }
  function buildBlocks(gl, img, W, H) {
    const R = Math.max(12, Math.min(V.res | 0, 96)), z = V.zScale, useImg = V.colour === 'image', sizeZ = H / W || 1, hw = 0.5 / (R - 1), hd = sizeZ / (R - 1) * 0.5;
    const { val, rgb } = gridVals(img, W, H, R); blurGrid(val, R, V.blur | 0);
    const P = [], C = [], N = [], Yof = n => (val[n] - 0.5) * z, colAt = n => (useImg ? [rgb[n * 3], rgb[n * 3 + 1], rgb[n * 3 + 2]] : heightRamp(val[n]));
    const v = (p, c, nx, ny, nz) => { P.push(p[0], p[1], p[2]); C.push(c[0], c[1], c[2]); N.push(nx, ny, nz); };
    const quad = (A, B, Cc, D, c, nx, ny, nz) => { v(A, c, nx, ny, nz); v(B, c, nx, ny, nz); v(Cc, c, nx, ny, nz); v(A, c, nx, ny, nz); v(Cc, c, nx, ny, nz); v(D, c, nx, ny, nz); };
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const n = j * R + i, y = Yof(n), c = colAt(n), cx = i / (R - 1) - 0.5, cz = (j / (R - 1) - 0.5) * sizeZ, x0 = cx - hw, x1 = cx + hw, z0 = cz - hd, z1 = cz + hd;
      quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], c, 0, 1, 0);
      if (i < R - 1) { const yr = Yof(n + 1); if (Math.abs(yr - y) > 1e-5) { const lo = Math.min(y, yr), hi = Math.max(y, yr), s = y > yr ? 1 : -1; quad([x1, lo, z0], [x1, lo, z1], [x1, hi, z1], [x1, hi, z0], c, s, 0, 0); } }
      if (j < R - 1) { const yf = Yof(n + R); if (Math.abs(yf - y) > 1e-5) { const lo = Math.min(y, yf), hi = Math.max(y, yf), s = y > yf ? 1 : -1; quad([x0, lo, z1], [x1, lo, z1], [x1, hi, z1], [x0, hi, z1], c, 0, 0, s); } }
    }
    const up = (b, d) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d), gl.DYNAMIC_DRAW); };
    up(V.buf.bpos, P); up(V.buf.bcol, C); up(V.buf.bnrm, N);
    V.blockCount = P.length / 3;
  }
  function size() {
    const gl = V.gl, w = glc.clientWidth || 600, h = glc.clientHeight || 440, dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (glc.width !== bw || glc.height !== bh) { glc.width = bw; glc.height = bh; }
    gl.viewport(0, 0, glc.width, glc.height);
  }
  function draw() {
    const gl = V.gl; if (!gl) return;
    if (V.dirty) build();
    size();
    gl.clearColor(0.051, 0.059, 0.075, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(V.prog);
    const el = Math.max(-1.5, Math.min(1.5, V.el)), r = V.rad, eye = [V.tx + r * Math.cos(el) * Math.sin(V.az), V.ty + r * Math.sin(el), V.tz + r * Math.cos(el) * Math.cos(V.az)];
    gl.uniformMatrix4fv(V.loc.mvp, false, new Float32Array(M4.mul(M4.persp(1.05, glc.width / glc.height || 1, 0.02, 50), M4.lookAt(eye, [V.tx, V.ty, V.tz], [0, 1, 0]))));
    gl.uniform3f(V.loc.light, 0.4, 0.85, 0.45);
    const bind = (b, loc) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0); };
    if (V.mode === 'blocks') {
      gl.uniform1f(V.loc.flat, 0); bind(V.buf.bpos, V.loc.pos); bind(V.buf.bcol, V.loc.col); bind(V.buf.bnrm, V.loc.nrm);
      if (V.blockCount) gl.drawArrays(gl.TRIANGLES, 0, V.blockCount);
      return;
    }
    bind(V.buf.pos, V.loc.pos); bind(V.buf.col, V.loc.col); bind(V.buf.nrm, V.loc.nrm);
    if (V.mode === 'points') { gl.uniform1f(V.loc.flat, 1); gl.drawArrays(gl.POINTS, 0, V.vertCount); }
    else if (V.mode === 'wire') { gl.uniform1f(V.loc.flat, 1); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, V.buf.line); gl.drawElements(gl.LINES, V.lineCount, gl.UNSIGNED_SHORT, 0); }
    else { gl.uniform1f(V.loc.flat, 0); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, V.buf.tri); gl.drawElements(gl.TRIANGLES, V.triCount, gl.UNSIGNED_SHORT, 0); }
  }
  function loop() { if (!V.on) return; if (V.auto) V.az += 0.005; draw(); V.raf = requestAnimationFrame(loop); }

  function start() {
    if (!V.gl && !init()) return false;
    V.on = true; glc.hidden = false; cv.hidden = true; $('d3bar').hidden = false;
    document.body.classList.add('v3'); $('btn3D').classList.add('primary');
    V.dirty = true; if (!V.raf) V.raf = requestAnimationFrame(loop);
    return true;
  }
  function stop() {
    V.on = false; if (V.raf) cancelAnimationFrame(V.raf); V.raf = 0;
    glc.hidden = true; $('d3bar').hidden = true; cv.hidden = false;
    document.body.classList.remove('v3'); $('btn3D').classList.remove('primary');
  }

  // input
  glc.addEventListener('contextmenu', e => e.preventDefault());
  glc.addEventListener('pointerdown', e => { V.drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 || e.button === 1 }; glc.setPointerCapture(e.pointerId); glc.classList.add('grabbing'); });
  glc.addEventListener('pointermove', e => {
    if (!V.drag) return;
    const dx = e.clientX - V.drag.x, dy = e.clientY - V.drag.y; V.drag.x = e.clientX; V.drag.y = e.clientY;
    if (V.drag.pan) {
      const el = Math.max(-1.5, Math.min(1.5, V.el)), az = V.az, f = [-Math.cos(el) * Math.sin(az), -Math.sin(el), -Math.cos(el) * Math.cos(az)];
      const cr = [f[2], 0, -f[0]], cl = Math.hypot(cr[0], cr[2]) || 1; cr[0] /= cl; cr[2] /= cl;
      const cu = [cr[1] * f[2] - cr[2] * f[1], cr[2] * f[0] - cr[0] * f[2], cr[0] * f[1] - cr[1] * f[0]], s = V.rad * 0.0018;
      V.tx += (-dx * cr[0] + dy * cu[0]) * s; V.ty += (-dx * cr[1] + dy * cu[1]) * s; V.tz += (-dx * cr[2] + dy * cu[2]) * s;
    } else { V.az -= dx * 0.01; V.el = Math.max(-1.5, Math.min(1.5, V.el + dy * 0.01)); }
  });
  const end = () => { V.drag = null; glc.classList.remove('grabbing'); };
  glc.addEventListener('pointerup', end); glc.addEventListener('pointercancel', end);
  glc.addEventListener('wheel', e => { e.preventDefault(); V.rad = Math.max(0.08, Math.min(14, V.rad * (1 + Math.sign(e.deltaY) * 0.08))); }, { passive: false });

  const seg = (id, cb) => $(id).addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; [...$(id).children].forEach(c => c.classList.toggle('on', c === b)); cb(b.dataset.v); });
  seg('d3src', v => { V.source = v; V.dirty = true; });
  seg('d3mode', v => { V.mode = v; V.dirty = true; });
  seg('d3col', v => { V.colour = v; V.dirty = true; });
  $('d3z').addEventListener('input', e => { V.zScale = +e.target.value / 100; $('d3zV').textContent = e.target.value + '%'; V.dirty = true; });
  $('d3res').addEventListener('input', e => { V.res = +e.target.value; $('d3rV').textContent = e.target.value; V.dirty = true; });
  $('d3blur').addEventListener('input', e => { V.blur = +e.target.value; $('d3bV').textContent = e.target.value; V.dirty = true; });
  $('d3auto').addEventListener('change', e => { V.auto = e.target.checked; });
  $('d3reset').addEventListener('click', () => Object.assign(V, { az: 0.7, el: 0.6, rad: 1.8, tx: 0, ty: 0, tz: 0 }));
  $('d3save').addEventListener('click', () => { if (!V.on) return; draw(); glc.toBlob(b => (b ? download(b, 'terrain.png') : toast('save failed')), 'image/png'); });

  return { start, stop, toggle: () => (V.on ? stop() : start()), isOn: () => V.on, markDirty: () => { V.dirty = true; } };
}
