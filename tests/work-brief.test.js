import test from 'node:test';
import { workContextMarkdown } from '../client/room-agent.mjs';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { selectedWorkContext } from '../server/work-context.mjs';
import { createWorkBrief, compareWorkBriefs } from '../client/work-brief.mjs';

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const read = () => {
    const room = f.store.room('commons');
    return selectedWorkContext({ state: room.state, workItemId: 'test-handoff', viewerId: 'producer',
      sequence: room.sequence, now: Date.now() });
  };
  return { ...f, read, send: (type, data) => f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type, data }) };
}

test('brief excludes conversation/result bodies and retains current objective, authority and provenance', async t => {
  const f = fixture(t), context = f.read();
  context.context.source = { status: 'included', message: { body: 'PRIVATE SOURCE BODY' } };
  context.work.receipt = { eventId: 'receipt', summary: 'Result summary', evidenceVersion: 'revision',
    nativeText: { body: 'LARGE RESULT BODY' } };
  const before = structuredClone(context), brief = await createWorkBrief(context);
  assert.deepEqual(context, before, 'projection never mutates selected context');
  assert.equal(brief.sections.objective.definitionOfDone, context.work.definitionOfDone);
  assert.equal(brief.sections.evidence.receipt.eventId, 'receipt');
  assert.equal(brief.nextReads.find(read => read.tool === 'room_read_result').arguments.completionEventId, 'receipt');
  assert.equal(brief.sections.evidence.retrieved, false);
  assert.equal(brief.observed.workRevision, context.work.revision);
  assert.equal(brief.scope.viewerId, 'producer');
  assert.match(brief.version, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(brief).includes('PRIVATE SOURCE BODY'));
  assert.ok(!JSON.stringify(brief).includes('LARGE RESULT BODY'));
  assert.ok(brief.omitted.includes('discussion_text'));
});

test('unrelated room traffic and read time preserve version; objective changes invalidate it', async t => {
  const f = fixture(t), first = await createWorkBrief(f.read());
  f.send('message.posted', { messageId: 'unrelated', body: 'Unrelated conversation' });
  const context = f.read(); context.evaluatedAt = '2027-01-01T00:00:00.000Z';
  const later = await createWorkBrief(context);
  assert.equal(later.version, first.version);
  assert.ok(later.observed.evaluatedThrough > first.observed.evaluatedThrough);
  assert.equal(compareWorkBriefs(first, later).status, 'same');
  context.work.definitionOfDone = 'Changed acceptance criteria';
  const changed = await createWorkBrief(context);
  assert.deepEqual(compareWorkBriefs(first, changed).changedSections, ['objective']);
});

test('fresh charter, permissions, handoff and result observations invalidate their own sections', async t => {
  const f = fixture(t), context = f.read(), first = await createWorkBrief(context);
  const mutations = {
    instructions: c => { c.context.charter = { revision: 2, charter: { purpose: 'New purpose' } }; },
    authority: c => { c.viewer.permissions = []; c.viewer.revision++; },
    progress: c => { c.work.handoff = { open: true, eventId: 'h', nextAction: 'Inspect unknown outcome' }; },
    evidence: c => { c.work.decision = { eventId: 'd', decision: 'reject', reason: 'Not sufficient' }; }
  };
  for (const [section, mutate] of Object.entries(mutations)) {
    const changed = structuredClone(context); mutate(changed);
    const diff = compareWorkBriefs(first, await createWorkBrief(changed));
    assert.deepEqual(diff.changedSections, [section]);
    assert.equal(diff.requiresFreshRead, true);
    assert.equal(diff.authorityGranted, false);
  }
});

test('brief identity scope cannot be reused across viewers or session revisions', async t => {
  const f = fixture(t), context = f.read(), first = await createWorkBrief(context);
  for (const patch of [{ viewerSessionRevision: 2 }, { roomId: 'other' }, { viewerAccountId: 'other' }]) {
    const next = await createWorkBrief({ ...context, ...patch });
    assert.equal(compareWorkBriefs(first, next).status, 'scope_changed');
  }
  assert.equal(compareWorkBriefs(null, first).requiresFreshRead, true);
});

test('key order does not affect content version and oversized briefs fail without truncating requirements', async t => {
  const f = fixture(t), context = f.read(), first = await createWorkBrief(context);
  const reordered = JSON.parse(JSON.stringify(context), (_, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value);
  assert.equal((await createWorkBrief(reordered)).version, first.version);
  context.work.definitionOfDone = 'x'.repeat(32768);
  await assert.rejects(createWorkBrief(context), { code: 'work_brief_too_large' });
});


test('compact text distinguishes unread discussion and bounded observed drafts from verified progress', t => {
  const context = fixture(t).read();
  const unread = workContextMarkdown(context);
  assert.match(unread, /Discussion not read/);
  assert.match(unread, /"includeDiscussion":true/);
  const item = n => ({ sequence: n, message: { id: `draft-${n}`, authorId: n === 5 ? 'peer' : 'producer',
    workItemId: context.work.id, body: 'PRIVATE DRAFT BODY', proposal: { basisRevision: 0 } } });
  context.preparation = { changedDuringRead: true, eventsAfterDiscussion: true,
    discussion: { items: [item(1), item(2), item(3), item(4), item(5)], since: 0, horizon: 5, hasMore: true, checkpoint: null },
    nextRead: { tool: 'room_read_work_discussion', arguments: { workItemId: context.work.id, cursor: 'continue' } } };
  const observed = workContextMarkdown(context);
  assert.match(observed, /"draftMessageId":"draft-5"/);
  assert.match(observed, /"authorId":"peer"/);
  assert.match(observed, /"basisRevision":0/);
  assert.doesNotMatch(observed, /draft-1|draft-2|PRIVATE DRAFT BODY/);
  assert.match(observed, /"cursor":"continue"/);
  assert.match(observed, /Work changed during this read/);
  assert.match(observed, /newer room events/);
  assert.match(observed, /not verified progress/);
  context.preparation.discussion = { items: [], since: 5, horizon: 8, hasMore: false, checkpoint: 8 };
  context.preparation.nextRead = null;
  assert.match(workContextMarkdown(context), /No draft references in this observed window/);
});
