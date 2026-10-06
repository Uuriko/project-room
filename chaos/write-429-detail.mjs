// Capture first-429 detail: body + rate-limit headers on a rapid burst.
const BASE = process.env.K6_BASE || 'https://project-room-stage.getdasha.workers.dev';
const ROOM = process.env.K6_ROOM || 'qa2-perf-sandbox-72e5';
const SECRET = process.env.K6_SECRET;
const N = Number(process.env.N || 70);
const H = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
const t = Date.now();
for (let i = 0; i < N; i++) {
  const mid = `d429-${t}-${i}`;
  const r = await fetch(`${BASE}/api/rooms/${ROOM}/commands`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: mid, type: 'message.posted', data: { messageId: mid, body: 'detail probe' } }),
  });
  const body = await r.text().catch(() => '');
  if (r.status === 429) {
    console.log(`first 429 at request #${i} (0-indexed), elapsed ${Date.now() - t}ms`);
    console.log('headers:', JSON.stringify({
      'retry-after': r.headers.get('retry-after'),
      'x-ratelimit-limit': r.headers.get('x-ratelimit-limit'),
      'x-ratelimit-remaining': r.headers.get('x-ratelimit-remaining'),
      'x-ratelimit-reset': r.headers.get('x-ratelimit-reset'),
    }));
    console.log('body:', body.slice(0, 300));
    process.exit(0);
  }
}
console.log('no 429 in', N, 'requests');
