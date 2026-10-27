// Synthetic payload/freshness qualification. This does not measure model quality or human effort.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { selectedWorkContext } from '../server/work-context.mjs';
import { createWorkBrief, compareWorkBriefs } from '../client/work-brief.mjs';

const f = createAcceptanceFixture();
let clock = Date.now();
f.store.now = () => clock;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const selected = () => {
  const room = f.store.room('commons');
  return selectedWorkContext({ state: room.state, workItemId: 'test-handoff', viewerId: 'producer',
    sequence: room.sequence, now: clock });
};
try {
  const first = await createWorkBrief(selected());
  for (let i = 0; i < 60; i++) {
    clock += 2000;
    f.store.command(f.keys.owner, 'commons', { id: `brief-fixture-${i}`,
    type: 'message.posted', data: { messageId: `brief-message-${i}`, body: `Historical message ${i}: ${'context '.repeat(100)}`,
      ...(i % 3 === 0 ? { workItemId: 'test-handoff' } : {}) } });
  }
  const context = selected(), brief = await createWorkBrief(context);
  assert.equal(compareWorkBriefs(first, brief).status, 'same');
  const minimal = { objective: context.work.title, acceptance: context.work.definitionOfDone };
  const broad = { context, discussion: f.store.room('commons').state.messages };
  const changes = [];
  for (const [name, mutate] of [
    ['requirements', c => { c.work.definitionOfDone += ' Include recovery evidence.'; }],
    ['access', c => { c.viewer.active = false; c.viewer.revision++; }],
    ['handoff', c => { c.work.handoff = { open: true, nextAction: 'Reconcile before retry', eventId: 'handoff' }; }],
    ['result', c => { c.work.receipt = { eventId: 'new-result', evidenceVersion: 'new-version', summary: 'New result' }; }]
  ]) {
    const value = structuredClone(context); mutate(value);
    const comparison = compareWorkBriefs(brief, await createWorkBrief(value));
    assert.equal(comparison.status, 'changed');
    changes.push({ scenario: name, ...comparison });
  }
  const report = { version: 1, runtime: process.version, synthetic: true,
    scope: 'Payload and freshness contracts only; broad fixture contains only synthetic public messages.',
    payloadBytes: { minimal: bytes(minimal), selectedBrief: bytes(brief), broadContext: bytes(broad) },
    historyGrowthPreservesBrief: true, changes,
    limitations: ['No model execution comparison', 'No human productivity measurement',
      'Brief omits discussion and external evidence; unchanged version does not validate omitted content'] };
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
