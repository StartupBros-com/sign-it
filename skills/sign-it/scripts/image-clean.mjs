// Turns a photo or scan of a signature into a clean, transparent PNG.
//
// cleanSignatureImage(buffer) -> { png, width, height, cleaned }
//   - PNG input that already has any transparent pixel is returned as-is
//     (cleaned: false) — it was already prepared, don't touch it.
//   - PNG or JPEG input without transparency has its background cut away:
//     sample the four corners for a background colour, turn pixels close
//     to it transparent, keep dark ink fully opaque, then trim to the
//     bounding box of the surviving ink plus a small margin.
//   - HEIC and anything unrecognised are refused with a plain { code }.
//
// Errors are always plain objects: { code: 'heic' | 'too-small' | 'unreadable' }.
// Callers (scripts/sign-it.mjs) map these codes to user-facing messages.

import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

const HEIC_MARKERS = ['ftypheic', 'ftypheix', 'ftypmif1', 'ftypmsf1'];

const BG_SAMPLE_MAX = 8; // corner patch size, px
const DISTANCE_FLOOR = 24;
const DISTANCE_SCALE = 4;
const ALPHA_KEEP_THRESHOLD = 40;
const DARK_LUMINANCE = 60;
const TRIM_MARGIN = 8;
const MIN_WIDTH = 120;
const MIN_HEIGHT = 40;

export function imageKind(buffer) {
  if (!buffer || buffer.length < 4) return 'unknown';
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'jpeg';
  }
  const head = buffer.subarray(0, 32).toString('latin1');
  if (HEIC_MARKERS.some((marker) => head.includes(marker))) {
    return 'heic';
  }
  return 'unknown';
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function sampleBackground(data, width, height) {
  const cw = Math.max(1, Math.min(BG_SAMPLE_MAX, Math.floor(width / 2) || 1));
  const ch = Math.max(1, Math.min(BG_SAMPLE_MAX, Math.floor(height / 2) || 1));
  const regions = [
    [0, 0, cw, ch],
    [width - cw, 0, width, ch],
    [0, height - ch, cw, height],
    [width - cw, height - ch, width, height],
  ];
  const rs = [];
  const gs = [];
  const bs = [];
  for (const [x0, y0, x1, y1] of regions) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        rs.push(data[i]);
        gs.push(data[i + 1]);
        bs.push(data[i + 2]);
      }
    }
  }
  return { r: median(rs), g: median(gs), b: median(bs) };
}

function hasAnyTransparency(data) {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

// Declared size from the header only, before any decoder allocates: a small
// file can declare a huge canvas and neither pngjs nor jpeg-js caps memory.
const MAX_PIXELS = 40e6;
function declaredPixels(buffer, kind) {
  if (kind === 'png') { if (buffer.length < 24 || buffer.toString('latin1', 12, 16) !== 'IHDR') throw { code: 'unreadable' }; return buffer.readUInt32BE(16) * buffer.readUInt32BE(20); }
  // JPEG: walk markers to the first SOF (C0..CF except C4, C8, CC); height at +5, width at +7
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xFF) { i++; continue; }
    const m = buffer[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return buffer.readUInt16BE(i + 5) * buffer.readUInt16BE(i + 7);
    const len = buffer.readUInt16BE(i + 2); if (len < 2) break; i += 2 + len;
  }
  return 0;
}
function decode(buffer, kind) {
  if (declaredPixels(buffer, kind) > MAX_PIXELS) throw { code: 'too-large' };
  if (kind === 'png') {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
  }
  const jimg = jpeg.decode(buffer, { useTArray: true });
  return { width: jimg.width, height: jimg.height, data: Buffer.from(jimg.data) };
}

function cutBackground(width, height, data) {
  const bg = sampleBackground(data, width, height);
  const working = Buffer.from(data);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const dr = r - bg.r;
      const dg = g - bg.g;
      const db = b - bg.b;
      const distance = Math.sqrt(dr * dr + dg * dg + db * db);
      let alpha = Math.min(255, Math.max(0, (distance - DISTANCE_FLOOR) * DISTANCE_SCALE));
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luminance < DARK_LUMINANCE) alpha = 255;
      alpha = Math.round(alpha);
      working[i + 3] = alpha;
      if (alpha > ALPHA_KEEP_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    throw { code: 'too-small' };
  }

  minX = Math.max(0, minX - TRIM_MARGIN);
  minY = Math.max(0, minY - TRIM_MARGIN);
  maxX = Math.min(width - 1, maxX + TRIM_MARGIN);
  maxY = Math.min(height - 1, maxY + TRIM_MARGIN);

  const outWidth = maxX - minX + 1;
  const outHeight = maxY - minY + 1;
  if (outWidth < MIN_WIDTH || outHeight < MIN_HEIGHT) {
    throw { code: 'too-small' };
  }

  const cropped = Buffer.alloc(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    const srcRowStart = ((y + minY) * width + minX) * 4;
    const dstRowStart = y * outWidth * 4;
    working.copy(cropped, dstRowStart, srcRowStart, srcRowStart + outWidth * 4);
  }

  return { width: outWidth, height: outHeight, data: cropped };
}

export async function cleanSignatureImage(buffer) {
  const kind = imageKind(buffer);
  if (kind === 'heic') throw { code: 'heic' };
  if (kind === 'unknown') throw { code: 'unreadable' };

  let decoded;
  try {
    decoded = decode(buffer, kind);
  } catch (err) {
    if (err && err.code) throw err;
    throw { code: 'unreadable' };
  }

  if (kind === 'png' && hasAnyTransparency(decoded.data)) {
    return { png: buffer, width: decoded.width, height: decoded.height, cleaned: false };
  }

  const trimmed = cutBackground(decoded.width, decoded.height, decoded.data);

  const out = new PNG({ width: trimmed.width, height: trimmed.height });
  trimmed.data.copy(out.data);
  const pngBuffer = PNG.sync.write(out);

  return { png: pngBuffer, width: trimmed.width, height: trimmed.height, cleaned: true };
}
