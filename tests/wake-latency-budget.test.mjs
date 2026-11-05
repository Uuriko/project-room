import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {createAgentWebhookSubscriptions} from '../server/agent-webhook-subscriptions.mjs';
import {acknowledgeOnDelivery} from '../server/wake-ack.mjs';
import {latencyReport, percentile, WAKE_BUDGET_MS, ACK_BUDGET_MS} from '../server/wake-latency.mjs';

test('percentile and budget math', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
  assert.equal(latencyReport([{postedAt: 0, deliveredAt: WAKE_BUDGET_MS, ackedAt: 1}]).withinBudget, false);
  assert.equal(latencyReport([{postedAt: 0, deliveredAt: 1, ackedAt: ACK_BUDGET_MS - 1}]).withinBudget, true);
});

// End to end in-process: post a formal request -> signed webhook POST to a
// local receiver -> delivery recorded -> server auto-ack. Fails CI if p95
// exceeds wake < 2 s or ack < 10 s.
test('post -> wake -> ack stays inside Linear-parity budgets (p95)', async t => {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const es = initialRoom();
  for (const id of ['asker', 'helper']) es.push(event({roomId: 'commons', actorId: 'owner', type: 'member.added', data: {memberId: id, displayName: id, kind: 'agent', permissions: ['accept_work', 'complete_work']}}));
  s.initialize(es);
  const keys = Object.fromEntries(['asker', 'helper'].map(id => [id, s.issueAccessKey('commons', id)]));
  let received = null;
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { received?.(); res.end('ok'); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  const subs = createAgentWebhookSubscriptions();
  const sub = subs.subscribe({agentId: 'helper', url: 'https://agent.example/hook', events: ['*'], secret: 'x'.repeat(32)});
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const postedAt = performance.now();
    s.command(keys.asker, 'commons', {id: `ask-${i}`, type: 'message.posted', data: {messageId: `ask-${i}`, toMemberId: 'helper', requestKind: 'reply', body: `ping ${i}`}});
    const delivery = subs.buildDelivery(sub.subscriptionId, {eventType: 'message.posted', data: {messageId: `ask-${i}`}});
    const got = new Promise(r => { received = r; });
    const res = await fetch(url, {method: 'POST', body: JSON.stringify(delivery.data), headers: {'x-room-signature': delivery.signature}});
    await got;
    const {state} = subs.recordAttempt(delivery.deliveryId, {ok: res.ok});
    const deliveredAt = performance.now();
    const request = s.replyRequests.list(keys.helper, 'commons', {direction: 'both', status: 'all'}).requests.find(r => r.id === `ask-${i}`);
    const ack = acknowledgeOnDelivery({roomId: 'commons', request, delivered: state === 'delivered', submit: c => s.command(keys.helper, 'commons', c)});
    assert.equal(ack.acked, true, ack.reason);
    samples.push({postedAt, deliveredAt, ackedAt: performance.now()});
  }
  const report = latencyReport(samples);
  console.log('wake-latency', JSON.stringify(report));
  assert.ok(report.withinBudget, `p95 over budget: ${JSON.stringify(report)}`);
});
