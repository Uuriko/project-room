import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomClient } from '../src/client.js';

const binding = 'human-binding';
const identity = { account: { id: 'account', authEpoch: 0 }, member: { id: 'human' }, roomId: 'commons', sessionBinding: binding };
const snapshot = { sequence: 1, roomId: 'commons', state: { messages: [] }, cursor: 0,
  viewerId: 'human', viewerAccountId: 'account', viewerAuthEpoch: 0, viewerSessionBinding: binding };
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  t.mock.method(Math, 'random', () => 0);
  const streams = [], reads = [];
  let pending = null, active = 0, maximum = 0;
  class Events extends EventTarget {
    readyState = 1;
    constructor() { super(); streams.push(this); }
    close() { this.readyState = 2; }
  }
  const client = new RoomClient({ events: Events, fetcher: async path => {
    if (path === '/api/session') return Response.json(identity);
    reads.push(path); active++; maximum = Math.max(maximum, active);
    try { if (pending) await pending; return Response.json(snapshot); } finally { active--; }
  } });
  client.livenessInterval = 3600000;
  await client.restore(); streams.at(-1).dispatchEvent(new Event('open')); await settle();
  t.after(() => client.disconnect());
  reads.length = 0;
  return { client, streams, reads, maximum: () => maximum,
    hold() { let resolve; pending = new Promise(r => { resolve = r; }); return () => { pending = null; resolve(); }; },
    event(type = 'message.posted') { streams.at(-1).dispatchEvent(new MessageEvent('room-event', { data: JSON.stringify({ sequence: 2, event: { type, roomId: 'commons' } }) })); } };
}

for (const status of [429, 503]) test(`automatic ${status} recovery respects Retry-After across events and reconnect`, async t => {
  const f = await fixture(t);
  f.client.handleFailure(Object.assign(new Error('Wait'), { status, retryAfterMs: 60000 }));
  f.event(); f.event('message.edited');
  f.client.connect(); f.streams.at(-1).dispatchEvent(new Event('open')); f.event();
  t.mock.timers.tick(59999); await settle(); assert.equal(f.reads.length, 0);
  t.mock.timers.tick(1); await settle(); assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0], '/api/rooms/commons', 'deferred edit keeps a full refresh obligation');
  assert.equal(f.client.refreshRetryNotBefore, 0); assert.equal(f.client.refreshRetryDelay, 1000);
  f.client.handleFailure(new Error('Network')); t.mock.timers.tick(1000); await settle();
  assert.equal(f.reads.length, 2, 'successful recovery resets the exponential retry');
});

test('explicit refresh remains usable and automatic reads never overlap it', async t => {
  const f = await fixture(t);
  f.client.handleFailure(Object.assign(new Error('Wait'), { status: 429, retryAfterMs: 5000 }));
  const release = f.hold(); const manual = f.client.refresh(null, { revalidate: true });
  await settle(); assert.equal(f.reads.length, 1);
  t.mock.timers.tick(5000); f.event(); await settle();
  assert.equal(f.reads.length, 1); assert.equal(f.maximum(), 1);
  release(); await manual; await settle(); assert.equal(f.maximum(), 1);
});

test('huge Retry-After is bounded and disconnect cancels the recovery', async t => {
  const f = await fixture(t);
  f.client.handleFailure(Object.assign(new Error('Wait'), { status: 503, retryAfterMs: Number.MAX_SAFE_INTEGER }));
  assert.equal(f.client.refreshRetryNotBefore - Date.now(), 300000);
  f.client.disconnect(); t.mock.timers.tick(300001); await settle();
  assert.equal(f.reads.length, 0); assert.equal(f.client.refreshRetryNotBefore, 0);
});

test('delayed background timer wakes once and revocation still ends access immediately', async t => {
  const f = await fixture(t);
  f.client.handleFailure(Object.assign(new Error('Wait'), { status: 503, retryAfterMs: 5000 }));
  // Simulate a browser resuming after timer throttling while hidden.
  t.mock.timers.setTime(Date.now() + 30000); t.mock.timers.tick(0); await settle();
  assert.equal(f.reads.length, 1);
  f.client.handleFailure(Object.assign(new Error('Wait'), { status: 429, retryAfterMs: 60000 }));
  f.client.handleFailure(Object.assign(new Error('Revoked'), { status: 403 }));
  assert.equal(f.client.session, null); t.mock.timers.tick(60000); await settle(); assert.equal(f.reads.length, 1);
});

test('an event racing an overdue recovery timer cannot clear deferred older-edit coverage with a delta', async t => {
  const f = await fixture(t);
  f.client.handleFailure(Object.assign(new Error('Wait'), { status: 503, retryAfterMs: 5000 }));
  f.event('message.edited');
  f.client.tryDelta = () => true;
  t.mock.timers.setTime(Date.now() + 5000);
  f.event(); await settle();
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0], '/api/rooms/commons');
  t.mock.timers.tick(0); await settle(); assert.equal(f.reads.length, 1);
});
