// QA2-PERF spike: 3x VU spike against STAGING, read-heavy.
// Spreads load across K6_SECRETS (comma-separated staging identity secrets)
// so the per-credential rate limiter is not the thing under test.
// Usage: K6_SECRETS=s1,s2,... ./bin/k6 run perf/spike.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = __ENV.K6_BASE || 'https://project-room-stage.getdasha.workers.dev';
const ROOM = __ENV.K6_ROOM || 'qa2-perf-sandbox-72e5';
const SECRETS = (__ENV.K6_SECRETS || '').split(',').filter(Boolean);
const ROOMS = (__ENV.K6_ROOMS || '').split(',').filter(Boolean);
if (SECRETS.length === 0) throw new Error('K6_SECRETS required (comma-separated staging identity secrets)');
if (ROOMS.length !== SECRETS.length) throw new Error('K6_ROOMS must parallel K6_SECRETS (one room per identity)');
const slotFor = () => (__VU - 1) % SECRETS.length;
const secretFor = () => SECRETS[slotFor()];
const roomFor = () => ROOMS[slotFor()];

const errRate = new Rate('errors');
const tOrient = new Trend('t_orient');
const tEvents = new Trend('t_events');
const tMcp = new Trend('t_mcp');

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 150 },  // ramp to 3x
        { duration: '90s', target: 150 },  // hold the spike
        { duration: '30s', target: 0 },    // ramp down
      ],
      exec: 'readMix',
      gracefulRampDown: '10s',
    },
  },
  thresholds: { errors: ['rate<0.05'] },
};

export function readMix() {
  const H = { Authorization: `Bearer ${secretFor()}` };
  const ROOM = roomFor();
  const pick = (__VU + __ITER) % 3;
  let res, ok;
  if (pick === 0) {
    res = http.get(`${BASE}/api/rooms/${ROOM}/orient`, { headers: H });
    ok = check(res, { 'orient 200': r => r.status === 200 });
    tOrient.add(res.timings.duration);
  } else if (pick === 1) {
    res = http.get(`${BASE}/api/rooms/${ROOM}/events?after=0&limit=50`, { headers: H });
    ok = check(res, { 'events 200': r => r.status === 200 });
    tEvents.add(res.timings.duration);
  } else {
    res = http.post(`${BASE}/mcp`, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      { headers: { ...H, 'Content-Type': 'application/json' } });
    ok = check(res, { 'mcp 200': r => r.status === 200 });
    tMcp.add(res.timings.duration);
  }
  errRate.add(!ok);
  sleep(0.5);
}
