import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Read only the pure fitting code and its three caller fragments. Importing
// the CLI would dispatch commands and could touch signatures or listeners.
const source = fs.readFileSync(process.env.SIGN_IT_FONT_SOURCE || new URL('../scripts/sign-it.mjs', import.meta.url), 'utf8');
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source boundaries: ${start}`);
  return source.slice(from, to);
}
const helper = source.match(/function shrinkFontSize\(font, text, size, availableWidth\) \{\n[\s\S]*?\n\}/)?.[0] || '';
const date = between('      let size = Math.min(11, Math.max(7, slot.date.boxHeight * 0.55));', '      tf.setFontSize(size);');
const field = between('      let size = Math.min(11, Math.max(7, s.boxHeight * 0.55));', '      tf.setFontSize(size);');
const drawn = between('    let size = Math.min(10, Math.max(7, s.lineHeight * 0.75));', '    const box = { x: s.x');
// The same tests can run on the original source to establish the baseline.
const originalLoop = date.match(/while \(size > 6 && font\.widthOfTextAtSize\(text, size\) > avail\) size -= 0\.5;/)?.[0];
assert.equal((source.match(/while \(size > 6 && font\.widthOfTextAtSize/g) || []).length, helper ? 1 : 3);
assert.equal((source.match(/= shrinkFontSize\(/g) || []).length, helper ? 3 : 0);
assert.ok(helper || originalLoop, 'fitting implementation found');
const shrink = helper
  ? new Function(`${helper}\nreturn shrinkFontSize;`)()
  : new Function('font', 'text', 'size', 'avail', `${originalLoop}\nreturn size;`);
const fitDate = new Function('font', 'slot', 'text', 'avail', 'flags', 'cfg', 'fmtDate', `${helper}\n${date}\nreturn { text, size };`);
const fitField = new Function('font', 's', 'value', `${helper}\n${field}\nreturn size;`);
const fitDrawn = new Function('font', 's', 'value', 'label', 'die', `${helper}\n${drawn}\nreturn size;`);

function fontProbe(measure = (_, size) => size * 10, failAt = 0) {
  const calls = [];
  const failure = new Error('measurement failed');
  const font = {
    widthOfTextAtSize(text, size) {
      assert.equal(this, font, 'font method receiver');
      calls.push([text, size]);
      if (calls.length === failAt) throw failure;
      return measure(text, size);
    },
  };
  return { font, calls, failure };
}

for (const [name, start, available, expected, sizes] of [
  ['already fits', 11, 120, 11, [11]],
  ['exact width', 11, 110, 11, [11]],
  ['one decrement', 11, 105, 10.5, [11, 10.5]],
  ['several decrements', 9, 75, 7.5, [9, 8.5, 8, 7.5]],
  ['overflow at floor', 7, 1, 6, [7, 6.5]],
  ['fractional floor crossing', 7.25, 1, 5.75, [7.25, 6.75, 6.25]],
  ['at floor', 6, 1, 6, []],
  ['below floor', 5.75, 1, 5.75, []],
]) {
  test(name, () => {
    const { font, calls } = fontProbe();
    assert.equal(shrink(font, 'value', start, available), expected);
    assert.deepEqual(calls, sizes.map(size => ['value', size]));
  });
}
for (const failAt of [1, 2]) {
  test(`measurement error ${failAt} propagates unchanged`, () => {
    const { font, calls, failure } = fontProbe(undefined, failAt);
    assert.throws(() => shrink(font, 'value', 11, 1), error => error === failure);
    assert.deepEqual(calls, [11, 10.5].slice(0, failAt).map(size => ['value', size]));
  });
}

test('date keeps the ISO fallback before shrinking', () => {
  const { font, calls } = fontProbe((text, size) => size * (text === 'long date' ? 20 : 10));
  const fallbackCalls = [];
  const cfg = {};
  const result = fitDate(font, { date: { boxHeight: 20 } }, 'long date', 100, {}, cfg,
    (...args) => { fallbackCalls.push(args); return 'ISO date'; });
  assert.deepEqual(result, { text: 'ISO date', size: 10 });
  assert.deepEqual(fallbackCalls, [['auto', cfg, 'iso']]);
  assert.deepEqual(calls, [['long date', 11], ['ISO date', 11], ['ISO date', 10.5], ['ISO date', 10]]);
});

test('explicit date keeps its text and half-point stepping', () => {
  const { font, calls } = fontProbe();
  const result = fitDate(font, { date: { boxHeight: 20 } }, 'explicit', 105, { date: 'explicit' }, {},
    () => assert.fail('explicit date must not use fallback'));
  assert.deepEqual(result, { text: 'explicit', size: 10.5 });
  assert.deepEqual(calls, [['explicit', 11], ['explicit', 11], ['explicit', 10.5]]);
});

for (const [width, expected, sizes] of [[111, 10.5, [11, 10.5]], [110, 10, [11, 10.5, 10]]]) {
  test(`AcroForm fill keeps six-point padding at width ${width}`, () => {
    const { font, calls } = fontProbe();
    assert.equal(fitField(font, { boxHeight: 20, width }, 'value'), expected);
    assert.deepEqual(calls, sizes.map(size => ['value', size]));
  });
}

for (const [width, expected, sizes] of [[99, 9.5, [10, 9.5, 9.5]], [98, 9, [10, 9.5, 9, 9]]]) {
  test(`drawn fill keeps four-point padding and final check at width ${width}`, () => {
    const { font, calls } = fontProbe();
    assert.equal(fitDrawn(font, { lineHeight: 20, width }, 'value', 'Title',
      () => assert.fail('fitting value must not be refused')), expected);
    assert.deepEqual(calls, sizes.map(size => ['value', size]));
  });
}

test('drawn overflow retains exit code and refusal text', () => {
  const { font, calls } = fontProbe();
  const failure = new Error('refused');
  assert.throws(() => fitDrawn(font, { lineHeight: 10, width: 5 }, 'value', 'Title', (code, message) => {
    assert.equal(code, 3);
    assert.equal(message, '"value" does not fit the 5pt blank for "Title" even at 6pt; nothing was written');
    throw failure;
  }), error => error === failure);
  assert.deepEqual(calls, [7.5, 7, 6.5, 6].map(size => ['value', size]));
});

for (const [name, invoke] of [
  ['date', font => fitDate(font, { date: { boxHeight: 20 } }, 'value', 1, { date: 'explicit' }, {}, () => assert.fail())],
  ['field', font => fitField(font, { boxHeight: 20, width: 7 }, 'value')],
  ['drawn', font => fitDrawn(font, { lineHeight: 20, width: 5 }, 'value', 'Title', () => assert.fail())],
]) {
  test(`${name} caller preserves measurement errors`, () => {
    const { font, failure } = fontProbe(undefined, 2);
    assert.throws(() => invoke(font), error => error === failure);
  });
}
