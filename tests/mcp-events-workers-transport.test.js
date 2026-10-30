import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkersMcpEventTransport } from '../cloudflare/mcp-event-transport.mjs';
import { postMcpEvent, verifyMcpEventCallback } from '../server/mcp-events-wire.mjs';
import { JOBS } from '../server/jobs.mjs';
import { RoomStore } from '../server/store.mjs';
import { mcpEventSubscriptionsSchema } from '../server/mcp-event-subscriptions.mjs';
const origin = 'https://receiver.example.com';
const request = { body: '{}', headers: { 'content-type': 'application/json' }, timeoutMs: 1000 };
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');

test('only explicitly approved exact HTTPS origins can be contacted', async () => {
  let calls = 0;
  const transport = createWorkersMcpEventTransport([origin], async (_url, options) => {
    calls++; assert.equal(options.redirect, 'manual'); return new Response('{}');
  });
  for (const url of ['https://receiver.example.com.evil.test/private', 'https://evil.test/?secret=x', 'http://receiver.example.com/x', origin + ':8443/x', 'https://u:p@receiver.example.com/x', origin + '/x#fragment']) {
    await assert.rejects(transport(url, [], request), error => error.code === -32015 && error.data.reason === 'callback_origin_not_allowed' && !JSON.stringify(error.data).includes('secret'));
  }
  assert.equal(calls, 0);
  assert.equal((await transport(origin + '/callback', [], request)).status, 200);
  assert.equal(calls, 1);
  for (const config of [['https://*.example.com'], ['http://receiver.example.com'], [origin + '/callback'], [origin + ':8443'], ['https://u:p@receiver.example.com']]) assert.throws(() => createWorkersMcpEventTransport(config));
});

test('empty approved list fails before DNS or POST and reveals only origin', async () => {
  let calls = 0;
  assert.equal(createWorkersMcpEventTransport([]).configurationPending, true);
  assert.equal(createWorkersMcpEventTransport([origin]).configurationPending, false);
  await assert.rejects(verifyMcpEventCallback({ subscriptionId: 'sub_test', secret,
    url: 'https://unapproved.example.com/private?token=sensitive',
    transport: createWorkersMcpEventTransport([], async () => { calls++; }),
    dnsResolvers: { lookup: async () => { calls++; return ['8.8.8.8']; } },
  }), error => {
    assert.equal(error.code, -32015);
    assert.deepEqual(error.data, { reason: 'callback_origin_not_allowed', origin: 'https://unapproved.example.com' });
    return true;
  });
  assert.equal(calls, 0);
});

test('public DNS defense still rejects private answers for an approved origin', async () => {
  let calls = 0;
  await assert.rejects(postMcpEvent({ url: origin + '/callback', request,
    dnsResolvers: { lookup: async () => ['127.0.0.1'] },
    transport: createWorkersMcpEventTransport([origin], async () => { calls++; }),
  }));
  assert.equal(calls, 0);
});

test('callback challenge is verified and redirects never followed', async () => {
  let calls = 0;
  const transport = createWorkersMcpEventTransport([origin], async (_url, options) => {
    calls++; assert.equal(options.redirect, 'manual');
    assert.ok(options.headers['webhook-signature']);
    return Response.json({ challenge: JSON.parse(options.body).challenge });
  });
  const options = { subscriptionId: 'sub_test', secret, url: origin + '/callback', dnsResolvers: { lookup: async () => ['8.8.8.8'] } };
  assert.deepEqual(await verifyMcpEventCallback({ ...options, transport }), { verified: true });
  assert.equal(calls, 1);
  await assert.rejects(verifyMcpEventCallback({ ...options, transport: createWorkersMcpEventTransport([origin], async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })) }), error => error.data.reason === 'challenge_failed');
});

test('terminal responses preserve their status without consuming oversized bodies', async () => {
  for (const status of [410, 413]) {
    const response = await createWorkersMcpEventTransport([origin], async () => new Response('x'.repeat(4097), { status }))(origin, [], request);
    assert.equal(response.status, status);
    assert.equal(await response.text(), '');
  }
});

test('response limit and timeout include the body and abort requests', async () => {
  await assert.rejects(createWorkersMcpEventTransport([origin], async () => new Response('x'.repeat(4097)))(origin, [], request), /exceeds limit/);
  let signal;
  const stalled = createWorkersMcpEventTransport([origin], async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start() {} }));
  });
  await assert.rejects(stalled(origin, [], { ...request, timeoutMs: 10 }), /timed out/);
  assert.equal(signal.aborted, true);
});

test('durable worker scheduler derives pending and expired lease due times', async () => {
  const store = new RoomStore(':memory:');
  try {
    store.db.exec(mcpEventSubscriptionsSchema);
    store.nativeMcpEventsEnabled = true;
    const job = JOBS.find(job => job.name === 'native-mcp-events');
    assert.equal(job.enabled({}, store), false);
    store.db.prepare("INSERT INTO mcp_event_outbox(subscription_id,event_id,document,state,next_at,lease_until) VALUES('s','e','{}','leased',1,9000)").run();
    assert.equal(job.nextDueAt(store), 9000);
    store.db.prepare("INSERT INTO mcp_event_outbox(subscription_id,event_id,document,state,next_at) VALUES('s','e2','{}','pending',3000)").run();
    assert.equal(job.nextDueAt(store), 3000);
    assert.equal(job.enabled({}, store), true);
    store.nativeMcpEventsEnabled = false;
    assert.equal(job.enabled({}, store), false);
    store.nativeMcpEventsEnabled = true;
    let drains = 0; await job.run(store, { room: { drainMcpEvents: async () => { drains++; return []; } } });
    assert.equal(drains, 1);
    store.db.exec("UPDATE mcp_event_outbox SET state='delivered'");
    assert.equal(job.enabled({}, store), false);
  } finally { store.close(); }
});
