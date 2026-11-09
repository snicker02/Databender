// JPEG container helpers: find the entropy-coded scan, keep markers decodable.

export const isJPEG = b => b && b.length > 4 && b[0] === 0xFF && b[1] === 0xD8;

/** Walk marker segments. Returns {scanStart, progressive} (scanStart = first byte after SOS header). */
export function jpegLayout(b) {
  const len = b.length;
  let i = 2, progressive = false;
  while (i + 3 < len) {
    if (b[i] !== 0xFF) break;
    const m = b[i + 1];
    if (m === 0xFF) { i++; continue; }                      // fill byte
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const segLen = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xC2 || m === 0xC6 || m === 0xCA || m === 0xCE) progressive = true;
    if (m === 0xDA) return { scanStart: Math.min(len, i + 2 + segLen), progressive };
    if (segLen < 2) break;
    i += 2 + segLen;
  }
  // Fallback: linear search for SOS
  for (let k = 2; k + 3 < len; k++) {
    if (b[k] === 0xFF && b[k + 1] === 0xDA) {
      const segLen = (b[k + 2] << 8) | b[k + 3];
      return { scanStart: Math.min(len, k + 2 + segLen), progressive };
    }
  }
  return { scanStart: Math.min(len, 2), progressive };
}

/** End of editable scan region — keeps a trailing EOI out of reach. */
export function scanEnd(b) {
  const n = b.length;
  return n >= 2 && b[n - 2] === 0xFF && b[n - 1] === 0xD9 ? n - 2 : n;
}

/**
 * Marker-safe copy: inside [s,e) any 0xFF not followed by a legal in-scan
 * code (00 stuffing or RSTn) becomes 0xFE, so a stray byte can't terminate
 * the scan. Guarantees a trailing EOI.
 */
export function sanitizeJPEG(b, s) {
  const e = scanEnd(b);
  const c = e === b.length ? new Uint8Array(b.length + 2) : new Uint8Array(b.length);
  c.set(b);
  if (e === b.length) { c[e] = 0xFF; c[e + 1] = 0xD9; }
  for (let i = s; i < e - 1; i++) {
    if (c[i] === 0xFF) {
      const n = c[i + 1];
      if (!(n === 0x00 || (n >= 0xD0 && n <= 0xD7))) c[i] = 0xFE;
    }
  }
  if (e - 1 >= s && c[e - 1] === 0xFF) c[e - 1] = 0xFE;   // FF right before EOI would swallow it
  return c;
}
