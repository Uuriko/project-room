// Bounded real-store histories, not a distributed-systems proof.
// Authoring contract: status observation cannot change eventual outcomes;
// acknowledgments are monotonic facts; unrelated/retried writes do not answer
// or duplicate a request; sender receipts remain private. Existing one-state
// tests miss ordering and restart interactions. No production test-only seam.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { listMentionReceipts } from '../server/mention-receipts.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mutant') continue;
  if (['--out', '--case'].includes(args[i]) && args[i + 1]) { i++; continue; }
  throw new Error(`Unknown or incomplete argument: ${args[i]}`);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = resolve(root, '.tmp'); mkdirSync(scratch, { recursive: true });
const campaign = mkdtempSync(resolve(scratch, 'coordination-history-'));
const mutant = args.includes('--mutant');
let receipts = listMentionReceipts;
const report = { schemaVersion: 1, mode: mutant ? 'always-read-mutant' : 'real-source',
  scope: 'finite local RoomStore histories; no HTTP, remote host, live provider or physical-device proof',
  controls: 0, histories: [], failures: [], comparisons: 0,
  sourceHashes: Object.fromEntries(['server/store.mjs', 'server/mention-receipts.mjs', 'server/mention-lifecycle.mjs']
    .map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])) };
function violation(property, trace, expected, actual) {
  report.failures.push({ property, trace: [...trace], expected, actual });
}
function observeInvariant(condition, property, trace, expected, actual) {
  if (!condition) violation(property, trace, expected, actual);
}
try {
  if (mutant) {
    const source = readFileSync(resolve(root, 'server/mention-receipts.mjs'), 'utf8');
    const needle = 'read: READ_STATES.has(row.state)';
    assert.equal(source.split(needle).length, 2, 'mutation must target exactly one expression');
    const target = resolve(campaign, 'mention-receipts-mutant.mjs');
    writeFileSync(target, source.replace(needle, 'read: true'));
    receipts = (await import(pathToFileURL(target).href)).listMentionReceipts;
  }
  function runHistory({ ack, delay, restart, retry, observe }) {
    const id = `ack=${ack},delay=${delay},restart=${restart},retry=${retry},observe=${observe}`;
    const directory = mkdtempSync(resolve(campaign, 'case-'));
    const database = resolve(directory, 'room.sqlite');
    let now = Date.parse('2026-10-20T00:00:00Z');
    let store = new RoomStore(database, { now: () => now });
    const trace = [];
    const command = (key, id, type, data) => store.command(key, 'commons', { id, type, data });
    try {
      store.initialize(initialRoom('commons'));
      const owner = store.issueAccessKey('commons', 'owner');
      for (const member of ['alice', 'bystander']) command(owner, `add-${member}`, 'member.added',
        { memberId: member, displayName: member, kind: 'agent', permissions: [] });
      const alice = store.issueAccessKey('commons', 'alice');
      const bystander = store.issueAccessKey('commons', 'bystander');
      store.setMentionTimeout(owner, 'commons', 60_000, null);
      const data = { messageId: 'request', body: '@alice review this' };
      const sent = command(owner, 'send-request', 'message.posted', data);
      trace.push('send @alice');
      const initial = receipts(store, owner, 'commons').receipts[0];
      observeInvariant(initial.read === false && initial.acked === false,
        'no-invented-read', trace, { read: false, acked: false }, { read: initial.read, acked: initial.acked });
      assert.deepEqual(receipts(store, bystander, 'commons').receipts, [], 'bystander cannot read sender receipts');
      report.controls++;
      command(alice, 'unrelated', 'message.posted', { messageId: 'unrelated', body: 'An unrelated status' });
      assert.equal(receipts(store, owner, 'commons').receipts[0].state, 'delivered', 'unrelated post does not answer request');
      report.controls++;
      if (retry) {
        command(owner, 'send-request', 'message.posted', data); trace.push('retry exact request');
        assert.equal(store.room('commons').state.messages.filter(m => m.id === 'request').length, 1);
        assert.equal(receipts(store, owner, 'commons').receipts.length, 1);
        report.controls++;
      }
      if (ack) {
        store.acknowledgeMention(alice, 'commons', sent.event.id, null); trace.push('ack');
        const acknowledged = receipts(store, owner, 'commons').receipts[0];
        assert.equal(acknowledged.read, true); assert.equal(acknowledged.acked, true);
      }
      now += delay; trace.push(`advance ${delay}ms`);
      if (restart) { store.close(); store = new RoomStore(database, { now: () => now }); trace.push('restart'); }
      if (observe) {
        const status = receipts(store, owner, 'commons').receipts[0]; trace.push('read receipt');
        if (ack) observeInvariant(status.read && status.acked, 'acknowledgment-survives-deadline', trace,
          { read: true, acked: true }, { read: status.read, acked: status.acked, state: status.state });
      }
      command(alice, 'reply', 'message.posted', { messageId: 'reply', replyToId: 'request', body: 'Reviewed' });
      trace.push('reply to request');
      const final = receipts(store, owner, 'commons').receipts[0];
      const outcome = { state: final.state, read: final.read, acked: final.acked };
      if (ack) observeInvariant(final.read && final.acked, 'acknowledgment-survives-deadline', trace,
        { read: true, acked: true }, outcome);
      const result = { id, trace, outcome }; report.histories.push(result); return result;
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  for (const ack of [false, true]) for (const delay of [59_999, 60_000, 60_001])
    for (const restart of [false, true]) for (const retry of [false, true]) {
      const selection = `ack=${ack},delay=${delay},restart=${restart},retry=${retry}`;
      if (option('--case') && !selection.includes(option('--case'))) continue;
      const input = { ack, delay, restart, retry };
      const withoutRead = runHistory({ ...input, observe: false });
      const withRead = runHistory({ ...input, observe: true });
      report.comparisons++;
      observeInvariant(JSON.stringify(withoutRead.outcome) === JSON.stringify(withRead.outcome),
        'observation-independent-outcome', withRead.trace, withoutRead.outcome, withRead.outcome);
    }
  assert.ok(report.histories.length, 'case selector must execute at least one history');
  report.minimalFailures = Object.values(report.failures.reduce((best, f) => {
    if (!best[f.property] || f.trace.length < best[f.property].trace.length) best[f.property] = f;
    return best;
  }, {}));
  report.verdict = report.failures.length ? 'FAIL' : 'PASS';
} catch (error) {
  report.verdict = 'ERROR'; report.error = { name: error.name, message: error.message };
} finally {
  rmSync(campaign, { recursive: true, force: true });
}
const out = resolve(option('--out') || 'test-results/coordination-history-audit.json');
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ verdict: report.verdict, mode: report.mode, histories: report.histories.length,
  comparisons: report.comparisons, controls: report.controls, failures: report.failures.length,
  properties: report.minimalFailures?.map(f => f.property), out, error: report.error }));
process.exitCode = report.verdict === 'PASS' ? 0 : report.verdict === 'FAIL' ? 1 : 2;
