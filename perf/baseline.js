// QA2-PERF baseline: k6 load against STAGING only.
// Usage: K6_SECRET=<staging identity secret> ./bin/k6 run perf/baseline.js
// Never point this at production.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = __ENV.K6_BASE || 'https://project-room-stage.getdasha.workers.dev';
const ROOM = __ENV.K6_ROOM || 'qa2-perf-sandbox-72e5';
const SECRET = __ENV.K6_SECRET;
if (!SECRET) throw new Error('K6_SECRET required (staging identity secret)');

const H = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };

const errRate = new Rate('errors');
const tOrient = new Trend('t_orient');
const tPost = new Trend('t_post');
const tMcp = new Trend('t_mcp');
const tClaim = new Trend('t_claim');

export const options = {
  scenarios: {
    orient:   { executor: 'constant-vus', vus: 15, duration: '5m', exec: 'orient' },
    post:     { executor: 'constant-vus', vus: 15, duration: '5m', exec: 'postMsg' },
    mcp:      { executor: 'constant-vus', vus: 10, duration: '5m', exec: 'mcpList' },
    claims:   { executor: 'constant-vus', vus: 10, duration: '5m', exec: 'claimsCrud' },
  },
  thresholds: {
    // Baseline run: only gate on error rate. Latency budgets are documented
    // from this run; CI smoke gates on them afterwards.
    errors: ['rate<0.05'],
  },
};

function rec(trend, res, ok) {
  trend.add(res.timings.duration);
  errRate.add(!ok);
}

export function orient() {
  const res = http.get(`${BASE}/api/rooms/${ROOM}/orient`, { headers: { Authorization: H.Authorization } });
  const ok = check(res, { 'orient 200': r => r.status === 200 });
  rec(tOrient, res, ok);
  sleep(1);
}

export function postMsg() {
  const mid = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(`${BASE}/api/rooms/${ROOM}/commands`, JSON.stringify({
    id: mid, type: 'message.posted', data: { messageId: mid, body: `qa2 perf baseline ${mid}` },
  }), { headers: H });
  const ok = check(res, { 'post 201 + sequence': r => (r.status === 201 || r.status === 200) && r.json('sequence') > 0 });
  rec(tPost, res, ok);
  sleep(1);
}

export function mcpList() {
  const res = http.post(`${BASE}/mcp`, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), { headers: H });
  const ok = check(res, { 'mcp 200 + tools': r => r.status === 200 && (r.json('result.tools') || []).length > 0 });
  rec(tMcp, res, ok);
  sleep(1);
}

export function claimsCrud() {
  const cid = `k6c-${__VU}-${__ITER}-${Date.now()}`;
  const base = `${BASE}/api/rooms/${ROOM}/work-claims`;
  let okAll = true;
  let t0 = Date.now();
  const c1 = http.post(base, JSON.stringify({ id: cid, title: 'k6 baseline claim' }), { headers: H });
  okAll = check(c1, { 'claim create 201': r => r.status === 201 }) && okAll;
  const c2 = http.post(`${base}/${cid}/claim`, JSON.stringify({ note: 'k6', leaseHours: 1 }), { headers: H });
  okAll = check(c2, { 'claim take 200': r => r.status === 200 }) && okAll;
  const c3 = http.post(`${base}/${cid}/update`, JSON.stringify({ state: 'in_progress' }), { headers: H });
  okAll = check(c3, { 'claim progress 200': r => r.status === 200 }) && okAll;
  const c4 = http.post(`${base}/${cid}/release`, JSON.stringify({}), { headers: H });
  okAll = check(c4, { 'claim release 200': r => r.status === 200 }) && okAll;
  tClaim.add(Date.now() - t0);
  errRate.add(!okAll);
  sleep(1);
}
