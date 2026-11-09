// Shared byte / math / rng helpers. Pure — no DOM.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Mix two 32-bit values into a well-spread seed. */
export function mixSeed(a, b) {
  let h = (a ^ Math.imul(b + 0x9E3779B9, 0x85EBCA6B)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7FEB352D); h ^= h >>> 15; h = Math.imul(h, 0x846CA68B); h ^= h >>> 16;
  return h >>> 0;
}

export const rngFor = (seed, name) => mulberry32(((seed >>> 0) ^ hashStr(name)) >>> 0);

export const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
export const i32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));

export function parseHex(str) {
  const c = (str || '').replace(/[^0-9a-fA-F]/g, '');
  const o = [];
  for (let i = 0; i + 2 <= c.length; i += 2) o.push(parseInt(c.substr(i, 2), 16));
  return o;
}

/** Hex pairs → bytes; anything else → its char codes. Never empty. */
export function keyToBytes(str) {
  str = (str || '').trim();
  const compact = str.replace(/\s/g, '');
  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0 && compact.length > 0) return parseHex(compact);
  const o = [];
  for (let i = 0; i < str.length; i++) o.push(str.charCodeAt(i) & 255);
  return o.length ? o : [0xff];
}

export const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
