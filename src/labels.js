// Bitmap font labels using the *original fsv charset* (src/xmaps/charset.xbm).
// 16x32 1-bit glyphs, 32 cols × 4 rows = ASCII 32..127.
//
// The fsv convention (see src/tmaptext.c xbm_pixels): a 1-bit is BACKGROUND
// (transparent), a 0-bit is GLYPH (drawn). We honor that here.

import * as THREE from '/vendor/three/build/three.module.js';

const CHAR_W = 16;
const CHAR_H = 32;
const SHEET_W = 512;
const SHEET_H = 128;
const COLS = SHEET_W / CHAR_W;        // 32
const FALLBACK_GLYPH = 63;            // '?'

let charsetMask = null;               // ImageData (alpha-only) of the raw glyph sheet
let charsetReady = null;
const tintCache = new Map();          // hex color -> HTMLCanvasElement (tinted sheet)

function parseXBM(text) {
  const wMatch = text.match(/_width\s+(\d+)/);
  const hMatch = text.match(/_height\s+(\d+)/);
  if (!wMatch || !hMatch) throw new Error('XBM: missing width/height');
  const w = +wMatch[1], h = +hMatch[1];
  if (w !== SHEET_W || h !== SHEET_H) {
    console.warn(`charset.xbm dims unexpected: ${w}x${h} (expected ${SHEET_W}x${SHEET_H})`);
  }
  const bytes = [];
  const re = /0x([0-9a-fA-F]{2})/g;
  let m;
  while ((m = re.exec(text)) !== null) bytes.push(parseInt(m[1], 16));

  const bytesPerRow = Math.ceil(w / 8);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = bytes[y * bytesPerRow + (x >>> 3)] | 0;
      const bit = (b >>> (x & 7)) & 1;
      const pi = (y * w + x) * 4;
      // 0-bit = drawn glyph: opaque white. 1-bit = background: transparent.
      if (bit === 0) { out[pi] = 255; out[pi+1] = 255; out[pi+2] = 255; out[pi+3] = 255; }
    }
  }
  return new ImageData(out, w, h);
}

export async function preloadCharset() {
  if (charsetReady) return charsetReady;
  charsetReady = (async () => {
    const r = await fetch('/assets/fsv/charset.xbm');
    if (!r.ok) throw new Error(`charset fetch failed: ${r.status}`);
    const text = await r.text();
    charsetMask = parseXBM(text);
  })();
  return charsetReady;
}

function getTintedSheet(colorHex) {
  if (tintCache.has(colorHex)) return tintCache.get(colorHex);
  if (!charsetMask) throw new Error('preloadCharset() first');
  const cv = document.createElement('canvas');
  cv.width = SHEET_W; cv.height = SHEET_H;
  const ctx = cv.getContext('2d');
  // Paint mask, then color it via source-in compositing.
  ctx.putImageData(charsetMask, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = colorHex;
  ctx.fillRect(0, 0, SHEET_W, SHEET_H);
  ctx.globalCompositeOperation = 'source-over';
  tintCache.set(colorHex, cv);
  return cv;
}

function buildTextCanvas(text, color, scale) {
  const sheet = getTintedSheet(color);
  const len = Math.max(1, text.length);
  const cv = document.createElement('canvas');
  cv.width  = len * CHAR_W * scale;
  cv.height = CHAR_H * scale;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < text.length; i++) {
    let g = text.charCodeAt(i);
    if (g < 32 || g > 127) g = FALLBACK_GLYPH;
    g -= 32;
    const sx = (g % COLS) * CHAR_W;
    const sy = Math.floor(g / COLS) * CHAR_H;
    ctx.drawImage(
      sheet,
      sx, sy, CHAR_W, CHAR_H,
      i * CHAR_W * scale, 0, CHAR_W * scale, CHAR_H * scale
    );
  }
  return cv;
}

function makeMesh(canvas, baseHeight) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Mipmaps soften far/small text the way fsv's TEXT_USE_MIPMAPS did.
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    alphaTest: 0.35,
  });
  const aspect = canvas.width / canvas.height;
  const geo = new THREE.PlaneGeometry(baseHeight * aspect, baseHeight);
  return new THREE.Mesh(geo, mat);
}

// Honors `maxWidth` (in world units) by *shrinking* the plane until it fits —
// keeps short labels at their natural size and silently downsizes overrunning ones.
export function makeLabel(text, opts = {}) {
  const color = opts.color ?? '#7af0ff';
  const scale = opts.pixelScale ?? 1;
  let baseHeight = opts.height ?? 0.6;
  const maxWidth = opts.maxWidth;
  const canvas = buildTextCanvas(text, color, scale);
  if (maxWidth) {
    const aspect = canvas.width / canvas.height;
    const naturalWidth = baseHeight * aspect;
    if (naturalWidth > maxWidth) baseHeight *= maxWidth / naturalWidth;
    if (baseHeight < 0.06) return null; // would be illegibly small; skip
  }
  const mesh = makeMesh(canvas, baseHeight);
  mesh.rotation.x = -Math.PI / 2; // flat on top of node
  return mesh;
}

export function makeBillboardLabel(text, opts = {}) {
  const color = opts.color ?? '#7af0ff';
  const scale = opts.pixelScale ?? 2;
  const baseHeight = opts.height ?? 4.0;
  const canvas = buildTextCanvas(text, color, scale);
  return makeMesh(canvas, baseHeight);
}
