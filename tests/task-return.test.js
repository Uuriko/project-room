import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedTaskFromLocation} from '../src/room-deep-link.js';
import {roomEntryHref} from '../src/join.js';
import {validateMagicReturnTo, buildMagicLinkUrl} from '../server/magic-links.mjs';

test('email and approval return preserve selected room/task without widening redirect targets', () => {
  const target = '/?room=commons#pr-record/work/task-1';
  assert.equal(validateMagicReturnTo(target), target);
  const email = new URL(buildMagicLinkUrl({baseUrl:'https://example.test/room',to:'a@example.test',code:'test',returnTo:target}));
  assert.equal(email.origin, 'https://example.test');
  assert.equal(email.pathname, '/room/');
  assert.equal(email.hash, '#pr-record/work/task-1');
  const pending = new URL('https://example.test/room/join?room=commons&access-request=pending#pr-record/work/task-1');
  assert.equal(roomEntryHref('commons',pending), 'https://example.test/room/?room=commons#pr-record/work/task-1');
  assert.equal(roomEntryHref('different',pending), 'https://example.test/room/#room/different');
  for (const bad of ['/#pr-record/work/task-1','/?room=a&room=b#pr-record/work/t','/?room=a#pr-record/work/%2F%2Fevil.test','//evil.test/?room=a#pr-record/work/t','/?room=a#pr-record/work/%00','/?room=a#pr-record/work/../x']) assert.equal(validateMagicReturnTo(bad),null,bad);
  assert.equal(selectedTaskFromLocation({search:'?room=commons',hash:'#pr-record/work/%E0%A4%A'}),null);
});
