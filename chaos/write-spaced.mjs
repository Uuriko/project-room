// Spaced write probe: N posts at INTERVAL_MS spacing, all inside one 60s window.
const BASE = process.env.K6_BASE || 'https://project-room-stage.getdasha.workers.dev';
const ROOM = process.env.K6_ROOM || 'qa2-perf-sandbox-72e5';
const SECRET = process.env.K6_SECRET;
const N = Number(process.env.N || 40);
const GAP = Number(process.env.GAP_MS || 1400);
const H = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
const t = Date.now();
const codes = [];
for (let i = 0; i < N; i++) {
  const mid = `sp-${t}-${i}`;
  const r = await fetch(`${BASE}/api/rooms/${ROOM}/commands`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: mid, type: 'message.posted', data: { messageId: mid, body: 'spaced probe' } }),
  });
  await r.text().catch(() => {});
  codes.push(r.status);
  if (i < N - 1) await new Promise(r2 => setTimeout(r2, GAP));
}
console.log(`n=${N} gap=${GAP}ms counts=`, JSON.stringify(codes.reduce((a, c) => (a[c] = (a[c] || 0) + 1, a), {})));
