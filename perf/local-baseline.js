// Local copy of perf/baseline.js (REL-20). Usage: node perf/local-server.mjs &
//   ./bin/k6 run perf/local-baseline.js   (DUR=5m for the full staging length) Same VU mix, 60 s instead of 5 m,
// against a disposable local server. Posts rotate over 4 fixture members and
// record the flood-guard 429 rate separately from latency.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
const BASE = __ENV.K6_BASE || 'http://127.0.0.1:18787', ROOM = 'commons';
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(BASE)) throw new Error('local-baseline is local-only');
const KEYS = JSON.parse(open(__ENV.K6_KEYS_FILE || '/tmp/pr-perf-keys.json'));
const ROT = ['owner', 'producer', 'reviewer', 'guest'];
const A = k => ({ Authorization: `Bearer ${KEYS[k]}`, 'Content-Type': 'application/json' });
const errors = new Rate('errors'), limited = new Rate('post_429');
const t = { orient: new Trend('t_orient', true), post: new Trend('t_post', true), events: new Trend('t_events', true),
  board: new Trend('t_board', true), claim: new Trend('t_claim_cycle', true), claimStep: new Trend('t_claim_step', true) };
const D = __ENV.DUR || '60s';
export const options = { scenarios: {
  orient: { executor: 'constant-vus', vus: 15, duration: D, exec: 'orient' },
  post:   { executor: 'constant-vus', vus: 15, duration: D, exec: 'postMsg' },
  reads:  { executor: 'constant-vus', vus: 10, duration: D, exec: 'reads' },
  claims: { executor: 'constant-vus', vus: 10, duration: D, exec: 'claimsCrud' },
}, summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max', 'count'] };
export function orient() { const r = http.get(`${BASE}/api/rooms/${ROOM}/orient`, { headers: A('owner') }); t.orient.add(r.timings.duration); errors.add(!check(r, { 'orient 200': x => x.status === 200 })); sleep(1); }
export function postMsg() {
  const mid = `k6-${__VU}-${__ITER}-${Date.now()}`; const who = ROT[(__VU + __ITER) % ROT.length];
  const r = http.post(`${BASE}/api/rooms/${ROOM}/commands`, JSON.stringify({ id: mid, type: 'message.posted', data: { messageId: mid, body: `perf ${mid}` } }), { headers: A(who) });
  limited.add(r.status === 429);
  if (r.status === 201 || r.status === 200) t.post.add(r.timings.duration);
  errors.add(!(r.status === 201 || r.status === 200 || r.status === 429)); sleep(1);
}
export function reads() {
  const e = http.get(`${BASE}/api/rooms/${ROOM}/events?after=0&limit=100`, { headers: A('owner') }); t.events.add(e.timings.duration);
  const b = http.get(`${BASE}/api/rooms/${ROOM}/work-claims`, { headers: A('owner') }); t.board.add(b.timings.duration);
  errors.add(!(e.status === 200 && b.status === 200)); sleep(1);
}
export function claimsCrud() {
  const cid = `k6c-${__VU}-${__ITER}-${Date.now()}`, base = `${BASE}/api/rooms/${ROOM}/work-claims`, H = { headers: A('owner') };
  const t0 = Date.now(); let ok = true;
  for (const [u, b, s] of [[base, { id: cid, title: 'k6 claim' }, 201], [`${base}/${cid}/claim`, { note: 'k6', leaseHours: 1 }, 200], [`${base}/${cid}/update`, { state: 'in_progress' }, 200], [`${base}/${cid}/release`, {}, 200]]) {
    const r = http.post(u, JSON.stringify(b), H); t.claimStep.add(r.timings.duration); ok = ok && r.status === s;
  }
  t.claim.add(Date.now() - t0); errors.add(!ok); sleep(1);
}
