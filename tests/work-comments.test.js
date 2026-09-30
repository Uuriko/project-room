// H-14 regression (audit 2026-09-30): the comment manager must seed its id
// counter from a caller-owned pre-populated store.
// Contract: createComments({ store }) with existing comments must mint ids
// that cannot collide with a stored comment id. Credible regression: pre-fix
// commentCounter starts at 0, so the next add() mints c-1 again, producing
// duplicate comment ids. Existing coverage: no test file existed for this
// module. No new production seams: public createComments/add/list API only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createComments } from '../server/work-comments.mjs';

test('H-14: add on a pre-populated store does not reuse an existing comment id', () => {
  const store = new Map();
  store.set('w1', [{
    commentId: 'c-1', workItemId: 'w1', authorId: 'a', text: 'x', mentions: [], createdAt: null,
  }]);
  const comments = createComments({ store });
  const c = comments.add('w1', { authorId: 'b', text: 'y' });
  assert.equal(c.commentId, 'c-2', 'must not reuse the existing c-1');
  assert.deepEqual(
    comments.list('w1').map((x) => x.commentId),
    ['c-1', 'c-2'],
    'no duplicate ids; original comment intact',
  );
});

test('add mints sequential ids on a fresh store', () => {
  const comments = createComments();
  const a = comments.add('w1', { authorId: 'a', text: 'x' });
  const b = comments.add('w1', { authorId: 'b', text: 'y' });
  assert.equal(a.commentId, 'c-1');
  assert.equal(b.commentId, 'c-2');
});
