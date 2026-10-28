import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWork, readWorkSelection } from '../client/work-preparation.mjs';
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


test('selected task batches bound concurrency, preserve order and abort without partial output', async () => {
  const pending = new Map(), calls = [];
  const client = { workContext(id, { signal }) {
    calls.push(id);
    return new Promise((resolve, reject) => {
      pending.set(id, () => resolve({ roomId: 'commons', work: { id } }));
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } };
  const result = readWorkSelection(client, { workItemIds: ['a', 'b', 'c', 'd'], brief: false });
  assert.deepEqual(calls, ['a', 'b']);
  pending.get('b')(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['a', 'b', 'c']);
  pending.get('c')(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['a', 'b', 'c', 'd']);
  pending.get('d')(); pending.get('a')();
  assert.deepEqual((await result).items.map(item => item.work.id), ['a', 'b', 'c', 'd']);
  const stop = new AbortController();
  const cancelled = readWorkSelection(client, { workItemIds: ['a', 'b', 'c'], brief: false }, { signal: stop.signal });
  stop.abort(new Error('access ended'));
  await assert.rejects(cancelled, /access ended/);
  assert.deepEqual(calls.slice(4), ['a', 'b']);
});

test('batch refusal cancels peers and never begins later tasks', async () => {
  let peerAborted = false; const calls = [];
  const client = { async workContext(id, { signal }) {
    calls.push(id);
    if (id === 'denied') throw new Error('permission denied');
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { peerAborted = true; reject(signal.reason); }, { once: true }));
  } };
  await assert.rejects(readWorkSelection(client, { workItemIds: ['denied', 'waiting', 'later'], brief: false }), /permission denied/);
  assert.equal(peerAborted, true);
  assert.deepEqual(calls, ['denied', 'waiting']);
});
