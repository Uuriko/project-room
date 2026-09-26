import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWork } from '../client/work-preparation.mjs';
import { attentionPreview } from '../src/work-selectors.js';

test('preparation follows frozen pages, refreshes work and reports changes without writing', async () => {
  let reads = 0;
  const calls = [];
  const client = {
    async workContext(id, options) { calls.push([id, options.includeSource]); return { work: { id, revision: reads++ }, evaluatedThrough: 12 }; },
    async workDiscussion(id, options) { calls.push([options.cursor ?? 'first', options.since]); return { discussion: {
      items: [{ message: { id: options.cursor ? 'reply' : 'source' } }], horizon: 10,
      hasMore: !options.cursor, nextCursor: options.cursor ? null : 'next', checkpoint: options.cursor ? 10 : null
    } }; }
  };
  const result = await prepareWork(client, 'work', { includeSource: true, discussionSince: 5 });
  assert.equal(result.work.revision, 1);
  assert.equal(result.preparation.changedDuringRead, true);
  assert.equal(result.preparation.eventsAfterDiscussion, true);
  assert.equal(result.preparation.discussion.items.length, 2);
  assert.equal(result.preparation.discussion.checkpoint, 10);
  assert.equal(result.preparation.nextRead, null);
  assert.deepEqual(calls, [['work', true], ['first', 5], ['next', undefined], ['work', true]]);
});

test('large discussions retain an exact continuation instead of silently truncating', async () => {
  let pages = 0;
  const client = {
    async workContext() { return { work: { revision: 0 }, evaluatedThrough: 400 }; },
    async workDiscussion() { return { discussion: { items: Array.from({ length: 25 }, () => ({})), horizon: 400,
      hasMore: true, nextCursor: `page${++pages}`, checkpoint: null } }; }
  };
  const result = await prepareWork(client, 'work');
  assert.equal(result.preparation.discussion.items.length, 100);
  assert.equal(result.preparation.discussion.checkpoint, null);
  assert.deepEqual(result.preparation.nextRead.arguments, { workItemId: 'work', cursor: 'page4', limit: 25 });
});

test('cancellation and stalled cursors stop preparation', async () => {
  for (const discussionSince of [null, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(prepareWork({}, 'work', { discussionSince }), /nonnegative discussion checkpoint/);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareWork({}, 'work', { signal: controller.signal }), { name: 'AbortError' });
  const client = { async workContext() { return { work: { revision: 0 } }; },
    async workDiscussion() { return { discussion: { items: [], hasMore: true, nextCursor: 'same' } }; } };
  await assert.rejects(prepareWork(client, 'work'), /did not advance/);
});

test('attention shows every urgent item and retains all routine items behind expansion', () => {
  const routine = Array.from({ length: 7 }, (_, id) => ({ id: `r${id}`, priority: 2 }));
  const urgent = Array.from({ length: 6 }, (_, id) => ({ id: `u${id}`, priority: 0 }));
  const preview = attentionPreview([...routine, ...urgent]);
  assert.deepEqual(preview.visible, urgent);
  assert.equal(preview.hiddenCount, 7);
  assert.deepEqual(preview.all, [...urgent, ...routine]);
  assert.equal(attentionPreview([...routine, urgent[0]]).visible.length, 5);
});
