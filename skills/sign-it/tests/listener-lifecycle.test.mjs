import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import vm from 'node:vm';
import test from 'node:test';

// Run the exact listener with synthetic image/storage dependencies. The CLI is
// never imported, no signature is used, and no real home/config is accessed.
const source = fs.readFileSync(process.env.SIGN_IT_LISTENER_SOURCE || new URL('../scripts/sign-it.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function cmdListen(flags)');
const end = source.indexOf('\nasync function cmdSetup(flags)', start);
assert.ok(start >= 0 && end > start);
const helpers = ['sendJson', 'saveSignature'].map(name => source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))?.[0] || '').join('\n');
const code = `${helpers}\n${source.slice(start, end)}\nthis.start = cmdListen;`;
const png = Buffer.from('89504e470d0a1a0a', 'hex');

async function listener(real = false) {
  let handler, server, expire, state, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const requests = new EventEmitter();
  const writes = [];
  let finishes = 0;
  const context = {
    Buffer, Date, ensureHome() {}, SKILL_DIR: '', PNG_MAGIC: png.toString('hex'),
    crypto: { randomBytes: () => Buffer.from('a') }, path: { join: () => 'draw.html' },
    f: () => ({ SIG: 'synthetic-current', SIG_PREV: 'synthetic-previous' }),
    fs: { existsSync: () => false, writeFileSync: (...args) => writes.push(args), chmodSync() {}, readFileSync: () => '__SAVE_URL__' },
    PNG: { sync: { read: () => ({ width: 120, height: 40, data: Buffer.from([0, 0, 0, 255]) }) } },
    readListener: () => state,
    writeListener: value => { state = value; if (value.url) ready(); },
    process: { exit: () => { finishes++; } },
    setTimeout: callback => { expire = callback; return 1; }, clearTimeout() {},
    http: { createServer(callback) {
      handler = callback;
      if (real) server = http.createServer((req, res) => { callback(req, res); requests.emit('request', req, res); });
      else server = { listen(_port, _host, cb) { cb(); }, address: () => ({ port: 1 }), close(cb) { cb(); } };
      return server;
    } },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  await context.start({});
  await started;
  function request() {
    const req = new EventEmitter(), res = new EventEmitter();
    Object.assign(req, { method: 'POST', url: '/61/save', destroy() { this.emit('aborted'); this.emit('error', new Error('aborted')); this.emit('close'); res.emit('close'); } });
    Object.assign(res, { writeHead(status) { this.status = status; }, end(body) { this.body = body; this.emit('finish'); } });
    handler(req, res);
    return { req, res };
  }
  return { request, requests, writes, expire: () => expire(), get state() { return state; }, get finishes() { return finishes; },
    get url() { return `${state.url}/save`; },
    async stop() { if (real) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } },
  };
}
function send(pair, body = png) { pair.req.emit('data', body); pair.req.emit('end'); }

for (const event of ['aborted', 'error', 'response-close', 'oversize']) {
  test(`${event} releases busy; stale events cannot release the next upload`, async () => {
    const h = await listener();
    const first = h.request();
    if (event === 'response-close') first.res.emit('close');
    else if (event === 'oversize') first.req.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
    else first.req.emit(event, new Error('synthetic disconnect'));
    const next = h.request();
    assert.equal(next.res.status, undefined, 'retry accepted');
    first.req.emit('aborted'); first.req.emit('error', new Error('late error'));
    first.res.emit('finish'); first.res.emit('close');
    // Even a stale end must never save bytes after another upload owns the slot.
    send(first);
    assert.equal(h.writes.length, 0);
    assert.equal(h.request().res.status, 409, 'new upload still owns busy');
    send(next);
    assert.equal(next.res.status, 200);
    assert.equal(h.writes.length, 1);
    assert.equal(h.finishes, 1);
    assert.equal(h.request().res.status, 410, 'consumed listener remains closed');
  });
}

test('rejected body permits retry; delayed close does not unlock another upload', async () => {
  const h = await listener(), first = h.request();
  send(first, Buffer.from('invalid'));
  assert.equal(first.res.status, 400);
  const next = h.request();
  first.res.emit('close');
  assert.equal(h.request().res.status, 409);
  send(next);
  assert.equal(next.res.status, 200);
  assert.equal(h.writes.length, 1);
});

test('expiry during a partial upload prevents a late save', async () => {
  const h = await listener(), first = h.request();
  h.expire();
  send(first);
  assert.equal(h.writes.length, 0);
  assert.equal(first.res.status, 410);
  assert.equal(h.state.expired, true);
  assert.equal(h.request().res.status, 410);
});

function post(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', agent: false }, res => {
      let text = ''; res.on('data', b => { text += b; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(body);
  });
}
for (const kind of ['aborted', 'oversize']) {
  test(`real HTTP ${kind} upload allows a later save`, { timeout: 10000 }, async t => {
    const h = await listener(true);
    t.after(() => h.stop());
    const observed = once(h.requests, 'request');
    const req = http.request(h.url, { method: 'POST', agent: false });
    req.on('error', () => {}); // Expected client ECONNRESET on destruction.
    req.flushHeaders();
    const [, response] = await observed;
    const closed = once(response, 'close');
    if (kind === 'aborted') req.destroy();
    else req.end(Buffer.alloc(4 * 1024 * 1024 + 1));
    await closed;
    const retry = await post(h.url, png);
    assert.equal(retry.status, 200);
    assert.deepEqual(JSON.parse(retry.text), { saved: true });
    assert.equal(h.writes.length, 1);
    assert.equal(h.state.saved, true);
  });
}


test('real HTTP expiry ends a late upload response without saving', { timeout: 10000 }, async t => {
  const h = await listener(true);
  t.after(() => h.stop());
  const observed = once(h.requests, 'request');
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request(h.url, { method: 'POST', agent: false }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    request.on('error', reject); request.flushHeaders();
  });
  await observed;
  h.expire();
  request.end(png);
  assert.equal(await result, 410);
  assert.equal(h.writes.length, 0);
});


test('pixel-limit rejection holds busy until response completion', async () => {
  const h = await listener(), first = h.request();
  first.res.end = body => { first.res.body = body; };
  const huge = Buffer.alloc(24);
  png.copy(huge); huge.write('IHDR', 12); huge.writeUInt32BE(10000, 16); huge.writeUInt32BE(10000, 20);
  send(first, huge);
  assert.equal(first.res.status, 413);
  assert.equal(h.request().res.status, 409);
  first.res.emit('finish');
  const next = h.request();
  first.res.emit('close');
  assert.equal(h.request().res.status, 409);
  send(next);
  assert.equal(next.res.status, 200);
  assert.equal(h.writes.length, 1);
});
