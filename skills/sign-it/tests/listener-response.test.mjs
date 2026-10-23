import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Inspect only the response statements. Never import the CLI: importing it
// dispatches commands, and listener/signature side effects are out of scope.
const source = fs.readFileSync(process.env.SIGN_IT_RESPONSE_SOURCE || new URL('../scripts/sign-it.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function cmdListen(flags) {');
const end = source.indexOf('\nasync function cmdSetup(flags)', start);
assert.ok(start >= 0 && end > start, 'listener source boundaries');
const listener = source.slice(start, end);
const helperMatch = source.match(/function sendJson\(res, status, payload\) \{\n[\s\S]*?\n\}/);
const helper = helperMatch ? helperMatch[0] : '';
const statements = [...listener.matchAll(/res\.writeHead\(\d+, \{ 'Content-Type': 'application\/json' \}\);\s*res\.end\(JSON\.stringify\(\{[^}]*\}\)\);|sendJson\(res, \d+, \{[^}]*\}\);/g)].map(match => match[0]);
const cases = [
  [410, { error: 'expired' }],
  [409, { error: 'busy' }],
  [410, { error: 'expired' }],
  [413, { error: 'too large' }],
  [413, { error: 'too large' }],
  [400, { error: 'not a PNG' }],
  [400, { error: 'undecodable PNG' }],
  [400, { error: 'too small' }],
  [400, { error: 'blank' }],
  [200, { saved: true }],
  [404, { error: 'not found' }],
];
assert.equal(statements.length, cases.length, 'all eleven JSON-response sites covered');
assert.equal((listener.match(/application\/json/g) || []).length + (listener.match(/sendJson\(res,/g) || []).length, 11, 'no response site silently omitted');
const stages = ['get writeHead', 'writeHead', 'get end', 'stringify', 'end'];
for (const [index, [status, payload]] of cases.entries()) {
  for (const failAt of [null, ...stages]) {
    test(`response ${index + 1}: ${failAt || 'success'}`, () => {
      const events = [];
      const sentinel = new Error('planted response failure');
      const record = (stage, detail) => {
        events.push([stage, ...(detail === undefined ? [] : [detail])]);
        if (stage === failAt) throw sentinel;
      };
      const response = {
        get writeHead() {
          record('get writeHead');
          return function (actualStatus, headers) {
            assert.equal(this, response);
            record('writeHead', [actualStatus, headers]);
          };
        },
        get end() {
          record('get end');
          return function (body) {
            assert.equal(this, response);
            record('end', body);
          };
        },
      };
      const json = {
        stringify(value) {
          record('stringify', value);
          return JSON.stringify(value);
        },
      };
      // Only the already selected response statement and optional pure helper
      // are evaluated. None of cmdListen, HTTP, filesystem or CLI runs.
      const invoke = new Function('res', 'JSON', helper + '\n' + statements[index]);
      if (failAt) assert.throws(() => invoke(response, json), error => error === sentinel);
      else assert.equal(invoke(response, json), undefined);
      const expected = [
        ['get writeHead'],
        ['writeHead', [status, { 'Content-Type': 'application/json' }]],
        ['get end'],
        ['stringify', payload],
        ['end', JSON.stringify(payload)],
      ];
      assert.deepEqual(events, failAt ? expected.slice(0, stages.indexOf(failAt) + 1) : expected);
    });
  }
}
