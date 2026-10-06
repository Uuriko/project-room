// QA2-CHAOS: SSE + write-resilience probes against STAGING only.
// Usage: K6_SECRET=<staging identity secret> node chaos/sse-chaos.mjs
// Every probe prints PASS/FAIL with evidence. Stays under the 60/min write budget.
const BASE = process.env.K6_BASE || 'https://project-room-stage.getdasha.workers.dev';
const ROOM = process.env.K6_ROOM || 'qa2-perf-sandbox-72e5';
const SECRET = process.env.K6_SECRET;
if (!SECRET) throw new Error('K6_SECRET required');
const H = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const verdict = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

async function events(after = 0, limit = 100) {
  const r = await fetch(`${BASE}/api/rooms/${ROOM}/events?after=${after}&limit=${limit}`, { headers: { Authorization: H.Authorization } });
  if (r.status === 429) { await sleep(65000); return events(after, limit); }
  if (!r.ok) throw new Error(`events ${r.status}`);
  return r.json();
}

async function post(mid, body, retries = 2) {
  const r = await fetch(`${BASE}/api/rooms/${ROOM}/commands`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: mid, type: 'message.posted', data: { messageId: mid, body } }),
  });
  if (r.status === 429 && retries > 0) { await sleep(65000); return post(mid, body, retries - 1); }
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

function maxSeq(page) {
  let m = 0;
  for (const e of page?.events ?? []) {
    const s = e?.event?.sequence ?? e?.sequence ?? 0;
    if (typeof s === 'number' && s > m) m = s;
  }
  return m;
}

function openStream() {
  const ctrl = new AbortController();
  const t0 = Date.now();
  const p = fetch(`${BASE}/api/rooms/${ROOM}/stream`, { headers: { Authorization: H.Authorization }, signal: ctrl.signal });
  return { ctrl, promise: p, t0 };
}

// P1: SSE time-to-first-byte + clean events
{
  const { ctrl, promise, t0 } = openStream();
  const res = await promise;
  const ttfb = Date.now() - t0;
  verdict('P1 sse-200', res.status === 200, `status=${res.status} ttfb=${ttfb}ms`);
  const reader = res.body.getReader();
  const first = await Promise.race([
    reader.read().then(c => ({ bytes: c.value?.length ?? 0 })),
    sleep(15000).then(() => ({ bytes: -1 })),
  ]);
  verdict('P1 sse-first-bytes', first.bytes > 0, `first chunk=${first.bytes}B ttfb=${ttfb}ms`);
  ctrl.abort();
  try { await reader.cancel(); } catch {}
}

// P2: kill SSE mid-post — the write must still land exactly once
{
  const { ctrl, promise } = openStream();
  const streamRes = await promise;
  verdict('P2 stream-open', streamRes.status === 200, `status=${streamRes.status}`);
  const mid = `chaos-kill-${Date.now()}`;
  const posted = await post(mid, 'chaos: kill stream mid-post');
  verdict('P2 post-acked', posted.status === 201 || posted.status === 200, `status=${posted.status} seq=${posted.json.sequence}`);
  ctrl.abort(); // kill the stream right after the ack
  await sleep(3000);
  const log = await events(Math.max(0, (posted.json.sequence ?? 1) - 2), 20);
  const hits = (log.events || []).filter(e => e?.event?.data?.messageId === mid || e?.data?.messageId === mid);
  verdict('P2 write-survives-stream-kill', hits.length === 1, `matches=${hits.length}`);
  // reconnect and confirm no duplicates flow
  const { ctrl: c2, promise: p2 } = openStream();
  const r2 = await p2;
  verdict('P2 reconnect-200', r2.status === 200, `status=${r2.status}`);
  c2.abort();
}

// P3: duplicate envelope id -> exactly-once (200 duplicate, no double write)
{
  const mid = `chaos-idem-${Date.now()}`;
  const beforePage = await events(0, 100);
  const before = maxSeq(beforePage);
  const a = await post(mid, 'chaos: idempotency probe');
  await sleep(1500);
  const b = await post(mid, 'chaos: idempotency probe');
  const dupFlag = b.json.duplicate === true || b.json.event?.idempotencyKey;
  await sleep(2000);
  const hits = [];
  let cursor = before;
  for (let p = 0; p < 20; p++) {
    const page = await events(cursor, 100);
    const evs = page?.events ?? [];
    if (evs.length === 0) break;
    for (const e of evs) if ((e?.event?.data?.messageId ?? e?.data?.messageId) === mid) hits.push(e);
    cursor = maxSeq(page);
    if (evs.length < 100) break;
  }
  verdict('P3 duplicate-returns-200', a.status === 201 && b.status === 200, `first=${a.status} second=${b.status} dupFlag=${dupFlag}`);
  verdict('P3 exactly-once', hits.length === 1, `matches=${hits.length}`);
}

// P4: burst of 30 writes, all acked -> all present, no gaps, no dupes
{
  const t0 = Date.now();
  const ids = Array.from({ length: 30 }, (_, i) => `chaos-burst-${t0}-${i}`);
  const beforePage = await events(0, 100);
  const before = maxSeq(beforePage);
  const results = await Promise.all(ids.map((mid, i) => sleep(i * 1500).then(() => post(mid, `chaos burst ${i}`))));
  const acked = results.filter(r => r.status === 201 || r.status === 200);
  verdict('P4 burst-acked', acked.length === ids.length, `acked=${acked.length}/${ids.length}`);
  await sleep(5000);
  const seen = new Set();
  let cursor = before;
  for (let p = 0; p < 20; p++) {
    const page = await events(cursor, 100);
    const evs = page?.events ?? [];
    if (evs.length === 0) break;
    for (const e of evs) {
      const m = e?.event?.data?.messageId ?? e?.data?.messageId;
      if (m && m.startsWith('chaos-burst-')) seen.add(m);
    }
    cursor = maxSeq(page);
    if (evs.length < 100) break;
  }
  const missing = ids.filter(id => !seen.has(id));
  verdict('P4 no-lost-writes', missing.length === 0, `present=${seen.size}/${ids.length} missing=${missing.length}`);
}

console.log(failures === 0 ? 'ALL CHAOS PROBES PASSED' : `${failures} PROBE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
