// Write-budget cliff probe: 75 rapid posts over one keep-alive connection.
// Prints status codes in order; expect ~60x 201 then 429s until the 60s window rolls.
const BASE = process.env.K6_BASE || 'https://project-room-stage.getdasha.workers.dev';
const ROOM = process.env.K6_ROOM || 'qa2-perf-sandbox-72e5';
const SECRET = process.env.K6_SECRET;
const N = Number(process.env.N || 75);
const H = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
const t = Date.now();
const codes = [];
for (let i = 0; i < N; i++) {
  const mid = `wb3-${t}-${i}`;
  const r = await fetch(`${BASE}/api/rooms/${ROOM}/commands`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: mid, type: 'message.posted', data: { messageId: mid, body: 'write-budget cliff probe' } }),
  });
  await r.text().catch(() => {});
  codes.push(r.status);
}
const first429 = codes.findIndex(c => c === 429);
console.log(`n=${N} first429@${first429} counts=`, JSON.stringify(codes.reduce((a, c) => (a[c] = (a[c] || 0) + 1, a), {})));
