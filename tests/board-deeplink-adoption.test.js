import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as links from '../src/board-deeplink.js';
import { publicAssetPaths } from '../server/public-assets.mjs';
import { publicAssets } from '../scripts/runtime-package.mjs';

test('board arrival preserves fragments and replaces conflicting values', () => {
  assert.equal(links.withBoardDeepLink('/room/?room=chosen#message'), '/room/?room=chosen&board=1#message');
  assert.equal(links.withBoardDeepLink('/?room=chosen&board=0&board=1'), '/?room=chosen&board=1');
});
test('ambiguous or malformed board intent does not open a modal', () => {
  for (const search of ['?board=1&board=0', '?board=0&board=1', '?board=1&board=1', '?board=%', '?board=', '?board=01'])
    assert.equal(links.boardDeepLinkWanted(search), false, search);
  assert.equal(links.stripBoardDeepLink('http://['), 'http://[');
});
test('stripping a URL retains its origin, room, unrelated parameters and fragment', () => {
  assert.equal(links.stripBoardDeepLink('https://room.example/room/?room=chosen&board=1#h'), 'https://room.example/room/?room=chosen#h');
  assert.equal(links.withBoardDeepLink('https://room.example/room/?room=chosen#h'), 'https://room.example/room/?room=chosen&board=1#h');
});
test('successful board arrival consumes exactly once after open succeeds', () => {
  let href = '/room/?room=chosen&board=1#h', opens = 0, replacements = 0;
  const open = () => { assert.equal(href.includes('board=1'), true); opens++; return true; };
  const replace = value => { assert.equal(opens, 1); replacements++; href = value; };
  assert.equal(links.consumeBoardDeepLink(href, open, replace), true);
  assert.equal(links.consumeBoardDeepLink(href, open, replace), false);
  assert.equal(opens, 1); assert.equal(replacements, 1); assert.equal(href, '/room/?room=chosen#h');
});
test('an unavailable or throwing board preserves intent and room startup', () => {
  for (const open of [() => false, () => { throw Error('synthetic modal failure'); }]) {
    let replaced = false;
    assert.equal(links.consumeBoardDeepLink('/?board=1', open, () => { replaced = true; }), false);
    assert.equal(replaced, false);
  }
});
test('new static imports are explicitly served and packaged', () => {
  assert.equal(publicAssetPaths.includes('src/board-deeplink.js'), true);
  assert.equal(publicAssets.includes('src/board-deeplink.js'), true);
});
test('wall action reports actual modal state rather than mere button presence', () => {
  const source = readFileSync(new URL('../src/signin-entry.js', import.meta.url), 'utf8');
  const action = source.match(/board: (\(\) => \{[\s\S]*?\n        \})/)[1];
  const run = (dialog, click) => Function('$', `return (${action})();`)(selector => selector === '#board-dialog' ? dialog : { click });
  assert.equal(run({ open: false }, () => {}), false);
  assert.equal(run({ open: true }, () => {}), true);
});
test('arrival hook reports actual modal state even if open returns without throwing', () => {
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const action = source.match(/openBoardFromEntrance = (\(\) => \{[^\n]+\})/)[1];
  const run = dialog => Function('openBoard', '$', `return (${action})();`)(() => {}, () => dialog);
  assert.equal(run({ open: false }), false);
  assert.equal(run({ open: true }), true);
});
