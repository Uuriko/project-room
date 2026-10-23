// Real Room HTTP/SDK reads against a disposable fixture. No provider or human claims.
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAcceptanceFixture } from '../../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../../server/http.mjs';
import { RoomAgentClient } from '../../client/room-agent.mjs';
import { EVENT_TYPES as T } from '../../src/events.js';

const output = resolve(process.argv[2] ?? 'test-results/collaboration-context');
await mkdir(output, { recursive: true });
const f = createAcceptanceFixture();
let now = Date.now(); f.store.now = () => now;
const send = (type, data) => { now += 2100; return f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data }); };
const server = createRoomServer({ store: f.store, streamInterval: 40 });
const report = { scope: 'Production HTTP and validated SDK on disposable synthetic room', capturedAt: new Date().toISOString(),
  samples: [], failures: [], limitations: ['Response bytes are serialized SDK JSON, not compressed wire bytes or tokens.', 'Single local fixture; timings are diagnostic observations, not statistically established speedups.', 'No live model calls. These measurements do not establish task quality.', 'This does not compare alternative storage implementations.'] };
try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const client = new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', memberId: 'producer', token: f.keys.producer });
  send(T.MESSAGE_POSTED, { messageId: 'experiment-source', body: 'Prepare the launch announcement. Initial date: November 12.' });
  send(T.WORK_PROPOSED, { workItemId: 'experiment-work', title: 'Launch announcement', definitionOfDone: 'Return the corrected date and owner from the linked discussion.',
    sourceMessageId: 'experiment-source', accountableMemberId: 'producer', mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false });
  send(T.MESSAGE_POSTED, { messageId: 'experiment-correction', replyToId: 'experiment-source', body: 'CORRECTION_MARKER: launch November 21; owner Mina. Do not publish.' });
  let seeded = 0;
  for (const size of [0, 100, 500]) {
    while (seeded < size) {
      send(T.MESSAGE_POSTED, { messageId: `irrelevant-${seeded}`, body: `Unrelated discussion ${seeded}: ${'background content '.repeat(40)}` }); seeded++;
    }
    const calls = [
      ['snapshot', () => client.snapshot()],
      ['selected', () => client.workContext('experiment-work', { includeSource: true })],
      ['discussion', () => client.workDiscussion('experiment-work', { consistent: true, limit: 50 })]
    ];
    const results = {};
    // Alternate order to reduce systematic first-read bias; no performance verdict.
    for (const [kind, call] of size === 100 ? calls.toReversed() : calls) {
      const started = performance.now(), value = await call();
      const serialized = JSON.stringify(value); results[kind] = value;
      report.samples.push({ irrelevantMessages: size, kind, bytes: Buffer.byteLength(serialized), elapsedMs: Math.round((performance.now() - started) * 100) / 100,
        containsCorrection: serialized.includes('CORRECTION_MARKER') });
    }
    assert.equal(JSON.stringify(results.snapshot).includes('CORRECTION_MARKER'), true);
    assert.equal(JSON.stringify(results.selected).includes('CORRECTION_MARKER'), false, 'Selected context intentionally omits discussion');
    assert.equal(JSON.stringify(results.discussion).includes('CORRECTION_MARKER'), true);
    assert.equal(JSON.stringify(results.discussion).includes('Unrelated discussion'), false);
    assert.equal(results.discussion.discussion.hasMore, false);
    // A fresh SDK instance resumes from the actual server-issued checkpoint.
    const checkpoint = results.discussion.discussion.resumeToken;
    send(T.MESSAGE_POSTED, { messageId: `late-${size}`, replyToId: 'experiment-source', body: `LATE_MARKER_${size}: keep publication pending.` });
    const replacement = new RoomAgentClient({ origin: client.origin ?? `http://127.0.0.1:${server.address().port}`, roomId: 'commons', memberId: 'producer', token: f.keys.producer });
    const resumed = await replacement.workDiscussion('experiment-work', { resumeToken: checkpoint, limit: 50 });
    assert.deepEqual(resumed.discussion.items.map(row => row.message.id), [`late-${size}`]);
    report.samples.push({ irrelevantMessages: size, kind: 'resume-delta', bytes: Buffer.byteLength(JSON.stringify(resumed)), messages: resumed.discussion.items.length, correct: true });
  }
} catch (error) { report.failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1; }
finally {
  server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(r => server.close(r));
  f.store.close(); await rm(f.directory, { recursive: true, force: true });
  await writeFile(`${output}/production-context.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
