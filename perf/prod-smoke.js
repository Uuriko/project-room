// QA2-PERF production smoke: 1 minute MAX, 5 VUs, unauthenticated reads only.
// NEVER add writes or higher load here. Staging carries the real tests.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.K6_BASE || 'https://www.getdasha.com/room';

export const options = { vus: 5, duration: '60s' };

export default function () {
  const r1 = http.get(`${BASE}/api/version`);
  check(r1, { 'version 200': r => r.status === 200 });
  const r2 = http.post(`${BASE}/mcp`,
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    { headers: { 'Content-Type': 'application/json' } });
  check(r2, { 'mcp 200': r => r.status === 200 });
  sleep(2);
}
