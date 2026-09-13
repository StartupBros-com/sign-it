#!/usr/bin/env node
// make-jpg.mjs <in.png> <out.jpg>
// Composites a (possibly transparent) PNG onto white and writes a JPEG,
// so the image-clean tests have a "photo" input that isn't already PNG.

import fs from 'node:fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: make-jpg.mjs <in.png> <out.jpg>');
  process.exit(1);
}

const buf = fs.readFileSync(inPath);
const png = PNG.sync.read(buf);
const { width, height, data } = png;

const composited = Buffer.alloc(width * height * 4);
for (let i = 0; i < data.length; i += 4) {
  const alpha = data[i + 3] / 255;
  composited[i] = Math.round(data[i] * alpha + 255 * (1 - alpha));
  composited[i + 1] = Math.round(data[i + 1] * alpha + 255 * (1 - alpha));
  composited[i + 2] = Math.round(data[i + 2] * alpha + 255 * (1 - alpha));
  composited[i + 3] = 255;
}

const jpg = jpeg.encode({ width, height, data: composited }, 90);
fs.writeFileSync(outPath, jpg.data);
