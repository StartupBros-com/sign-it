import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Evaluate only the exact storage statements with supplied filesystem/path
// dependencies. Importing the CLI would dispatch commands and start side effects.
const source = fs.readFileSync(process.env.SIGN_IT_STORAGE_SOURCE || new URL('../scripts/sign-it.mjs', import.meta.url), 'utf8');
const helper = source.match(/^function saveSignature\(SIG, SIG_PREV, bytes\) \{\n[\s\S]*?^\}/m)?.[0] || '';
const sites = [
  ['listener', source.indexOf('async function cmdListen(flags)'), ['\n        res.writeHead(200', '\n        sendJson(res, 200'], 'buf'],
  ['import', source.indexOf('async function cmdSetup(flags)'), ['\n    out({ saved: SIG,'], 'result.png'],
].map(([name, start, endMarker, bytes]) => {
  assert.ok(start >= 0, `${name} function found`);
  const begin = source.indexOf('const { SIG, SIG_PREV } = f();', start);
  const ends = endMarker.map(marker => source.indexOf(marker, begin)).filter(index => index > begin);
  const end = Math.min(...ends);
  assert.ok(begin > start && Number.isFinite(end) && end > begin, `${name} storage boundaries`);
  const statements = source.slice(begin, end);
  assert.ok(statements.includes(`saveSignature(SIG, SIG_PREV, ${bytes});`) || statements.includes(`fs.writeFileSync(SIG, ${bytes}, { mode: 0o600 });`), `${name} uses its own bytes`);
  return [name, new Function('fs', 'f', 'buf', 'result', `${helper}\n${statements}\nreturn SIG;`)];
});

for (const [name, invoke] of sites) {
  for (const exists of [false, true]) {
    const stages = ['paths', 'get existsSync', 'existsSync', ...(exists ? ['get copyFileSync', 'copyFileSync'] : []), 'get writeFileSync', 'writeFileSync', 'get chmodSync', 'chmodSync'];
    for (const failAt of [null, ...stages]) {
      test(`${name}, existing=${exists}, ${failAt || 'success'}`, () => {
        const events = [];
        const bytes = Buffer.from('synthetic replacement bytes');
        const sentinel = new Error('planted storage failure');
        const record = (stage, ...args) => {
          events.push([stage, ...args]);
          if (stage === failAt) throw sentinel;
        };
        const fake = {};
        for (const method of ['existsSync', 'copyFileSync', 'writeFileSync', 'chmodSync']) {
          Object.defineProperty(fake, method, { get() {
            record(`get ${method}`);
            return function (...args) {
              assert.equal(this, fake, 'filesystem receiver preserved');
              record(method, ...args);
              if (method === 'writeFileSync') assert.equal(args[1], bytes, 'same buffer, no conversion');
              return method === 'existsSync' ? exists : undefined;
            };
          } });
        }
        const paths = () => { record('paths'); return { SIG: 'current', SIG_PREV: 'previous' }; };
        if (failAt) assert.throws(() => invoke(fake, paths, bytes, { png: bytes }), error => error === sentinel);
        else assert.equal(invoke(fake, paths, bytes, { png: bytes }), 'current');
        const expected = [
          ['paths'], ['get existsSync'], ['existsSync', 'current'],
          ...(exists ? [['get copyFileSync'], ['copyFileSync', 'current', 'previous']] : []),
          ['get writeFileSync'], ['writeFileSync', 'current', bytes, { mode: 0o600 }],
          ['get chmodSync'], ['chmodSync', 'current', 0o600],
        ];
        assert.deepEqual(events, failAt ? expected.slice(0, stages.indexOf(failAt) + 1) : expected);
      });
    }
  }

  test(`${name}: synthetic replacement preserves previous bytes and tightens current mode`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-it-storage-test-'));
    try {
      const SIG = path.join(dir, 'current.bin');
      const SIG_PREV = path.join(dir, 'previous.bin');
      const paths = () => ({ SIG, SIG_PREV });
      const first = Buffer.from('synthetic first');
      const second = Buffer.from('synthetic second');
      const stale = Buffer.from('synthetic stale backup');
      fs.writeFileSync(SIG_PREV, stale);
      invoke(fs, paths, first, { png: first });
      assert.deepEqual(fs.readFileSync(SIG), first);
      assert.deepEqual(fs.readFileSync(SIG_PREV), stale, 'missing current leaves old backup alone');
      assert.equal(fs.statSync(SIG).mode & 0o777, 0o600);
      fs.chmodSync(SIG, 0o644);
      invoke(fs, paths, second, { png: second });
      assert.deepEqual(fs.readFileSync(SIG), second);
      assert.deepEqual(fs.readFileSync(SIG_PREV), first, 'backup happens before overwrite');
      assert.equal(fs.statSync(SIG).mode & 0o777, 0o600, 'chmod also protects an existing destination');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
