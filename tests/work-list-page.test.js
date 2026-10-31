import test from 'node:test';
import assert from 'node:assert/strict';
import { pageWorkListing, validWorkPage } from '../server/work-list-page.mjs';
const listing = () => ({ roomId: 'test-room', member: { id: 'owner', permissions: ['read'] }, evaluatedThrough: 80,
  work: Array.from({ length: 63 }, (_, i) => ({ id: `work-${i}`, title: `Task ${i}` })),
  replyRequests: Array.from({ length: 81 }, (_, i) => ({ id: `reply-${i}`, revision: 0 })) });
const page = (data, args = {}, key = 'test-secret', surface = 'hosted') => pageWorkListing(data, args, key, surface);
test('all work and reply pointers survive unequal page lengths with no duplicates or omissions', () => {
  const data = listing(), work = [], replies = []; let args = {}, result;
  do {
    result = page(data, args); work.push(...result.work.map(x => x.id)); replies.push(...result.replyRequests.map(x => x.id));
    assert.ok(result.work.length <= 25); assert.ok(result.replyRequests.length <= 25);
    assert.equal(result.page.totalWork, 63); assert.equal(result.page.totalReplyRequests, 81);
    args = result.page.nextRead?.arguments;
  } while (result.page.hasMore);
  assert.deepEqual(work, data.work.map(x => x.id)); assert.deepEqual(replies, data.replyRequests.map(x => x.id));
  assert.equal(result.page.nextCursor, null); assert.equal(result.page.nextRead, null);
});
test('continuations reject tampering, different credentials, room, viewer, filters and changed state', () => {
  const data = listing(), args = page(data).page.nextRead.arguments;
  for (const cursor of ['bad', `${args.cursor}x`, args.cursor.replace('.', '..')])
    assert.throws(() => page(data, { ...args, cursor }), { code: 'invalid_work_cursor' });
  assert.throws(() => page(data, args, 'another-secret'), { code: 'invalid_work_cursor' });
  for (const change of [{ roomId: 'other' }, { member: { id: 'guest' } }, { evaluatedThrough: 81 },
    { work: data.work.slice(1) }, { replyRequests: [] }])
    assert.throws(() => page({ ...data, ...change }, args), { code: 'stale_work_cursor', status: 409 });
  for (const change of [{ query: 'Task' }, { focus: 'needs_me' }, { sort: 'curiosity' }])
    assert.throws(() => page(data, { ...args, ...change }), { code: 'stale_work_cursor' });
  assert.throws(() => page(data, args, 'test-secret', 'stdio'), { code: 'stale_work_cursor' });
});
test('invalid bounds fail explicitly, empty selections terminate, and bound pointers omit roomId', () => {
  for (const limit of [0, -1, 101, 1.5, null, '25', Infinity]) {
    assert.equal(validWorkPage({ limit }), false); assert.throws(() => page(listing(), { limit }), { code: 'invalid_work_page' });
  }
  for (const cursor of ['', null, 12, 'x'.repeat(1025)]) assert.equal(validWorkPage({ cursor }), false);
  assert.equal(page({ ...listing(), work: [], replyRequests: [] }).page.hasMore, false);
  const result = page(listing(), { limit: 1, query: 'Task', focus: 'all' }, 'test-secret', 'stdio');
  assert.equal(result.work.length, 1); assert.equal(result.page.nextRead.arguments.roomId, undefined);
  assert.equal(result.page.nextRead.arguments.query, 'Task');
});

test('help observation time may advance but changed eligibility invalidates continuation', () => {
  const data = listing(); data.work = data.work.map(item => ({ ...item, help: { evaluatedAt: '2026-10-31T00:00:00Z', canOffer: true, status: 'open' } }));
  const args = page(data, { focus: 'help_wanted' }).page.nextRead.arguments;
  const later = { ...data, work: data.work.map(item => ({ ...item, help: { ...item.help, evaluatedAt: '2026-10-31T00:00:01Z' } })) };
  assert.equal(page(later, args).work[0].id, 'work-25');
  later.work[0].help.canOffer = false;
  assert.throws(() => page(later, args), { code: 'stale_work_cursor' });
});
