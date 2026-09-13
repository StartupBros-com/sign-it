#!/usr/bin/env node
// make-badimg.mjs <heic|tiny> <out>
// Writes small stub files that scripts/image-clean.mjs must refuse.

import fs from 'node:fs';
import { PNG } from 'pngjs';

const [, , kind, outPath] = process.argv;
if (!kind || !outPath) {
  console.error('usage: make-badimg.mjs <heic|tiny> <out>');
  process.exit(1);
}

if (kind === 'heic') {
  // Minimal ISOBMFF-shaped stub: 4-byte box size, then "ftypheic" at offset 4.
  const buf = Buffer.alloc(64);
  buf.write('ftypheic', 4, 'ascii');
  fs.writeFileSync(outPath, buf);
} else if (kind === 'tiny') {
  const png = new PNG({ width: 20, height: 10 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200;
    png.data[i + 1] = 200;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  fs.writeFileSync(outPath, PNG.sync.write(png));
} else {
  console.error(`unknown kind: ${kind}`);
  process.exit(1);
}
