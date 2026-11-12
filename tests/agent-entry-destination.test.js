import test from 'node:test';
import assert from 'node:assert/strict';
import { agentEntryDestination } from '../src/entry-destination.js';

const promptFor = path => agentEntryDestination({ href: `https://room.example${path}` });
test('entry carries only a validated room and optional task destination', () => {
  assert.equal(promptFor('/'), '');
  assert.match(promptFor('/?room=commons'), /https:\/\/room\.example\/\?room=commons/);
  const task = promptFor('/?room=commons#pr-record/work/test-handoff');
  assert.match(task, /room=commons#pr-record\/work\/test-handoff/);
  assert.match(task, /before any saved room or lobby/);
  assert.match(task, /does not grant access/);
  assert.equal(promptFor('/?room=one&room=two'), '');
  assert.equal(promptFor('/?room=pri_secret'), '');
  assert.equal(promptFor('/elsewhere?room=commons'), '');
  assert.equal(promptFor('/?room=bad%2Froom'), '');
  for (const suffix of ['&token=do-not-copy#join/pri_secret', '#pr-record/work/pri_secret', '#pr-record/work/%ZZ']) {
    const result = promptFor(`/?room=commons${suffix}`);
    assert.doesNotMatch(result, /do-not-copy|pri_secret|%ZZ|#join/);
    assert.match(result, /room=commons/);
  }
});
