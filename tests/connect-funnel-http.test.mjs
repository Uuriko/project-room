import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createHttpConnectFunnel,
  httpConnectFunnelEnabled,
  httpConnectFunnelIfEnabled,
  isAgentBearer,
  classifyHttpFunnelEvent,
} from '../server/connect-funnel-http.mjs';

// Synthetic HTTP-API journeys for the agent-connect funnel (flag
// ROOM_CONNECT_FUNNEL_HTTP). Events mirror the shapes the room-route handler
// in server/http.mjs can hand the observer: the matched room route segment,
// the HTTP method and status, and (for POST /commands) the command type.

const A = 'Bearer pri_' + 'a'.repeat(43);
const B = 'Bearer ga1.' + 'b'.repeat(43);
const C = 'Bearer rak_' + 'c'.repeat(24);
const ev = (route, extra = {}) => ({ method: 'GET', route, status: 200, ...extra });
const post = (status = 201) => ({ method: 'POST', route: 'commands', status, commandType: 'message.posted' });

test('flag is off by default', () => {
  assert.equal(httpConnectFunnelEnabled({}), false);
  assert.equal(httpConnectFunnelEnabled({ ROOM_CONNECT_FUNNEL_HTTP: '0' }), false);
  assert.equal(httpConnectFunnelEnabled({ ROOM_CONNECT_FUNNEL_HTTP: '1' }), true);
  const db = new DatabaseSync(':memory:');
  assert.equal(httpConnectFunnelIfEnabled({ env: {}, db }), null);
  assert.ok(httpConnectFunnelIfEnabled({ env: { ROOM_CONNECT_FUNNEL_HTTP: '1' }, db }));
});

test('only agent bearers count', () => {
  assert.ok(isAgentBearer(A) && isAgentBearer(B) && isAgentBearer(C));
  assert.ok(isAgentBearer('Bearer oat_' + 'd'.repeat(20)));
  assert.ok(isAgentBearer('Bearer iat_' + 'e'.repeat(20)));
  assert.equal(isAgentBearer(undefined), false);
  assert.equal(isAgentBearer('Bearer session-token'), false);
  assert.equal(isAgentBearer('Basic abc'), false);
  assert.equal(isAgentBearer('pri_' + 'a'.repeat(43)), false); // no Bearer scheme
});

test('event classification', () => {
  assert.equal(classifyHttpFunnelEvent(ev('events')), 'read');
  assert.equal(classifyHttpFunnelEvent(ev('activation-pack')), 'read');
  assert.equal(classifyHttpFunnelEvent(ev(null)), 'read'); // room root GET
  assert.equal(classifyHttpFunnelEvent(ev('context')), 'read');
  assert.equal(classifyHttpFunnelEvent(post()), 'post');
  assert.equal(classifyHttpFunnelEvent(post(200)), 'post'); // duplicate post still 200
  assert.equal(classifyHttpFunnelEvent({ method: 'POST', route: 'commands', status: 201, commandType: 'task.claimed' }), 'connect');
  assert.equal(classifyHttpFunnelEvent(ev('events', { status: 403 })), null); // failed read
  assert.equal(classifyHttpFunnelEvent(post(422)), null); // failed post
  assert.equal(classifyHttpFunnelEvent(ev('events', { method: 'DELETE' })), 'connect');
});

test('synthetic journeys produce both shares and both medians; no tokens stored', () => {
  const db = new DatabaseSync(':memory:');
  let t = 1000;
  const f = createHttpConnectFunnel({ db, now: () => t });
  // A: connects with a non-read command, reads, posts, reads again.
  f.observeHttp({ authorization: A, method: 'POST', route: 'commands', status: 201, commandType: 'task.claimed' }); // t=1000: connected
  t = 3000; f.observeHttp({ authorization: A, ...ev('events') }); // first read (+2000)
  t = 6000; f.observeHttp({ authorization: A, ...post() });
  t = 9000; f.observeHttp({ authorization: A, ...ev('events') }); // round trip complete (+8000)
  // B: connects with a cursor post, reads later, never posts.
  t = 1000; f.observeHttp({ authorization: B, method: 'POST', route: 'cursor', status: 200 });
  t = 5000; f.observeHttp({ authorization: B, ...ev('events') }); // first read (+4000)
  // C: connects with a non-message command, posts first, then reads.
  t = 1000; f.observeHttp({ authorization: C, method: 'POST', route: 'commands', status: 201, commandType: 'task.claimed' });
  t = 2000; f.observeHttp({ authorization: C, ...post() });
  t = 4000; f.observeHttp({ authorization: C, ...ev('events') }); // first read AND round trip
  assert.deepEqual(f.summary(), {
    connections: 3,
    firstAuthenticatedRead: { reached: 3, completionRate: 1, medianMs: 3000 },
    firstPostRoundTrip: { reached: 2, completionRate: 0.667, medianMs: 5500 },
  });
  const dump = JSON.stringify(db.prepare('SELECT * FROM connect_funnel_http').all());
  assert.doesNotMatch(dump, /pri_|ga1\.|rak_|Bearer|aaa|bbb|ccc/);
  assert.deepEqual(Object.keys(db.prepare('SELECT * FROM connect_funnel_http LIMIT 1').get()).sort(),
    ['connected_at', 'first_post_at', 'first_read_at', 'key', 'round_trip_at']);
});

test('failures, anonymous and duplicate firsts do not move the measures', () => {
  const db = new DatabaseSync(':memory:');
  let t = 1000;
  const f = createHttpConnectFunnel({ db, now: () => t });
  f.observeHttp({ authorization: undefined, ...ev('events') }); // anonymous: ignored
  f.observeHttp({ authorization: 'Bearer session-token', ...ev('events') }); // non-agent bearer: ignored
  f.observeHttp({ authorization: A, ...ev('events', { status: 401 }) }); // failed auth read: ignored
  assert.deepEqual(f.summary(), {
    connections: 0,
    firstAuthenticatedRead: { reached: 0, completionRate: null, medianMs: null },
    firstPostRoundTrip: { reached: 0, completionRate: null, medianMs: null },
  });
  t = 2000; f.observeHttp({ authorization: A, ...ev('events') }); // connected + first read at 2000
  t = 3000; f.observeHttp({ authorization: A, ...ev('context') }); // later read: first read stays 2000
  t = 3500; f.observeHttp({ authorization: A, ...ev('events') }); // read before any post: no round trip
  assert.equal(f.summary().firstPostRoundTrip.reached, 0);
  t = 4000; f.observeHttp({ authorization: A, ...post() });
  t = 4500; f.observeHttp({ authorization: A, ...post() }); // second post: first post stays 4000
  t = 5000; f.observeHttp({ authorization: A, ...ev('events') }); // round trip at 5000
  assert.deepEqual(f.summary(), {
    connections: 1,
    firstAuthenticatedRead: { reached: 1, completionRate: 1, medianMs: 0 },
    firstPostRoundTrip: { reached: 1, completionRate: 1, medianMs: 3000 },
  });
});

test('observer never throws on garbage input', () => {
  const db = new DatabaseSync(':memory:');
  const f = createHttpConnectFunnel({ db });
  for (const bad of [undefined, null, {}, { authorization: 42 }, { authorization: A }, { authorization: A, method: 'GET', route: {}, status: 'x' }]) {
    assert.doesNotThrow(() => f.observeHttp(bad));
  }
  assert.equal(f.summary().connections, 0);
});
