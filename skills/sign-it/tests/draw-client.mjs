#!/usr/bin/env node
// tests/draw-client.mjs <url> <png> [--post-only]
//
// A drawing-listener test client. GETs the page at <url> (the drawing
// canvas served by `setup --listen`), then POSTs <png> as a
// data:image/png;base64,... body to <url>/save. Prints "GET <status>" and
// its body (skipped with --post-only, for probing a listener that already
// consumed its token), then "POST <status>" and its body. Exits 0 only
// when the POST returned 200; a network error is printed as status 0, also
// non-zero.
import http from 'node:http';
import fs from 'node:fs';

function request(url, opts, body) {
  return new Promise((resolve) => {
    const req = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (err) => resolve({ status: 0, body: `ERROR ${err.message}` }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const [, , urlArg, pngArg, mode] = process.argv;
if (!urlArg || !pngArg) {
  process.stderr.write('usage: draw-client.mjs <url> <png> [--post-only]\n');
  process.exit(1);
}

const base = new URL(urlArg);
const saveUrl = new URL(base.pathname.replace(/\/?$/, '/save'), base);

if (mode !== '--post-only') {
  const getRes = await request(base, { method: 'GET' });
  console.log(`GET ${getRes.status}`);
  console.log(getRes.body);
}

const png = fs.readFileSync(pngArg);
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
const postRes = await request(saveUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(dataUrl) },
}, dataUrl);
console.log(`POST ${postRes.status}`);
console.log(postRes.body);

process.exit(postRes.status === 200 ? 0 : 1);
