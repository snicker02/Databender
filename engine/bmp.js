// 24-bit BMP encoder + tolerant raw decoder with "decode-as" reinterpretation.
import { clamp, u32, i32 } from './util.js';

export const BMP_HEADER = 54;

/** Row geometry for a 24-bit BMP of width W. */
export function geom(W) {
  const pad = (4 - ((W * 3) % 4)) % 4;
  return { pad, stride: W * 3 + pad };
}

/** RGBA pixels {width,height,data} → bottom-up 24-bit BMP bytes. */
export function encodeBMP(img) {
  const w = img.width, h = img.height, data = img.data;
  const { stride } = geom(w), size = BMP_HEADER + stride * h;
  const b = new Uint8Array(size), dv = new DataView(b.buffer);
  b[0] = 0x42; b[1] = 0x4D;
  dv.setUint32(2, size, true); dv.setUint32(10, BMP_HEADER, true);
  dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
  dv.setUint32(30, 0, true); dv.setUint32(34, stride * h, true);
  dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true);
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y, row = BMP_HEADER + y * stride;
    for (let x = 0; x < w; x++) {
      const i = (srcY * w + x) * 4, o = row + x * 3;
      b[o] = data[i + 2]; b[o + 1] = data[i + 1]; b[o + 2] = data[i];
    }
  }
  return b;
}

export const isBMP = b => b && b.length > 26 && b[0] === 0x42 && b[1] === 0x4D;

/** Header facts for a (possibly corrupted) BMP. */
export function bmpInfo(b) {
  const w = clamp(Math.abs(i32(b, 18)) || 1, 1, 8192);
  const h = clamp(Math.abs(i32(b, 22)) || 1, 1, 8192);
  let off = u32(b, 10);
  if (!(off >= 14 && off < b.length)) off = BMP_HEADER;
  return { w, h, off, bpp: b[28] | (b[29] << 8) };
}

/** Pixel formats the decoder can (mis)read the stream as. */
export const DECODE_FORMATS = {
  bgr24: 3, rgb24: 3, bgra32: 4, gray8: 1, rgb565: 2,
};

/**
 * Tolerant decode. Never throws: short streams fill with black, broken
 * offsets wrap. `view` reinterprets the stream for raw-import style shears.
 * Returns {width,height,data:Uint8ClampedArray RGBA} (top-down).
 */
export function decodeBMP(bytes, W, H, view = {}) {
  const len = bytes.length;
  const fmt = DECODE_FORMATS[view.fmt] ? view.fmt : 'bgr24';
  const bpp = DECODE_FORMATS[fmt];
  if (view.trustDims && len >= 26) {
    W = clamp(i32(bytes, 18) || 1, 1, 4096);
    H = clamp(Math.abs(i32(bytes, 22)) || 1, 1, 4096);
  }
  W = clamp(Math.round(W + (view.dw | 0)), 1, 4096);
  const rowBytes = W * bpp;
  const padRow = view.pad === false ? 0 : (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + padRow;

  let start = len >= 14 ? u32(bytes, 10) : BMP_HEADER;
  if (len > 0) {
    start = ((start % len) + len) % len;
    if (len - start < rowBytes) start = 0;
    start = ((start + (view.nudge | 0)) % len + len) % len;
  } else start = 0;

  if (view.fill) H = clamp(Math.ceil((len - start) / stride), 1, 4096);
  H = clamp(H | 0, 1, 4096);

  const flip = view.flip !== false;
  const d = new Uint8ClampedArray(W * H * 4);
  let p = start;
  const at = q => (q < len ? bytes[q] : 0);
  for (let y = 0; y < H; y++) {
    const outY = flip ? H - 1 - y : y, base = outY * W * 4;
    for (let x = 0; x < W; x++) {
      let r, g, b;
      switch (fmt) {
        case 'rgb24': r = at(p); g = at(p + 1); b = at(p + 2); break;
        case 'bgra32': b = at(p); g = at(p + 1); r = at(p + 2); break;
        case 'gray8': r = g = b = at(p); break;
        case 'rgb565': {
          const v = at(p) | (at(p + 1) << 8);
          r = ((v >> 11) & 31) * 255 / 31; g = ((v >> 5) & 63) * 255 / 63; b = (v & 31) * 255 / 31; break;
        }
        default: b = at(p); g = at(p + 1); r = at(p + 2);
      }
      p += bpp;
      const oi = base + x * 4;
      d[oi] = r; d[oi + 1] = g; d[oi + 2] = b; d[oi + 3] = 255;
    }
    p += padRow;
  }
  return { width: W, height: H, data: d };
}
