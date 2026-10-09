// WAVE-400 fuzz worker: SSE / event-stream cursor fuzz (fuzz-11).
//
// Endpoints under test:
//   GET  /api/rooms/:roomId/events        (after/limit/tail/actor/since/until)
//   GET  /api/rooms/:roomId/stream        (SSE; after query param / last-event-id header)
//   POST /api/rooms/:roomId/cursor        (JSON body {sequence})
//   GET  /api/rooms/:roomId/return-brief  (horizon/after/cursor/limit)
//   GET  /api/rooms/:roomId/work-claims   (opaque base64url cursor)
//   GET  /api/rooms/:roomId/receipts      (opaque base64url cursor)
//
// Invariants:
//   1. Malformed cursor -> 4xx, never 500, never an uncaught throw, never a hang.
//   2. A cursor beyond the head -> 4xx/empty, never a hang.
//   3. Replay from an old cursor returns the correct contiguous range (no gaps,
//      no duplicates) — differential against direct store.eventsAfter reads.
//   4. No injection: every cursor reaches SQL only through Number()/JSON.parse
//      validation or bound parameters (verified by code read + hostile probes).
//
// TEST-ONLY: reads server modules, writes no production code, adds no deps.
// Seeded RNG (mulberry32); seed = Number(process.env.FUZZ_SEED ?? 20261008).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

/* ---------------- seeded RNG ---------------- */
const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-11-sse-cursor] FUZZ_SEED=${SEED}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = arr => arr[(rand() * arr.length) | 0];
const randInt = (lo, hi) => lo + ((rand() * (hi - lo + 1)) | 0);

/* ---------------- accounting ---------------- */
const stats = { requests: 0, sse: 0, json: 0 };
const violations = [];
const observations = [];
function note(kind, detail, extra = "") {
  violations.push({ kind, detail: String(detail).slice(0, 400), extra: String(extra).slice(0, 300) });
}
function observe(detail, extra = "") {
  observations.push({ detail: String(detail).slice(0, 400), extra: String(extra).slice(0, 300) });
}

/* ---------------- hostile cursor pools ---------------- */
const HOSTILE_STRINGS = [
  "-1", "-0", "-999999999999", "0", "00", "007", "0x10", "0b101", "0o17",
  "1.5", "-1.5", "1e3", "1E-3", ".5", "5.", "NaN", "Infinity", "-Infinity",
  "9007199254740991", "9007199254740992", "9007199254740993", "18446744073709551615",
  "9223372036854775807", "9223372036854775808", "1e30", "-1e30",
  "", " ", "   ", "\n", "\t", "\r\n", "\0", "null", "undefined", "true", "false",
  "abc", "1; DROP TABLE events;--", "1 OR 1=1", "' OR '1'='1", "${jndi:ldap://x}",
  "{{7*7}}", "<script>", "😀", "ünïcödé", " claim-​zero", "a\nb", " 1 ", "+1",
  "５", "١٢٣", "１２３", "x".repeat(200), "x".repeat(10000), "9".repeat(500),
  "1,2", "1;2", "[1]", "{a:1}", "0.1+0.2", "--1", "+-1", "1_000",
];
const HOSTILE_BODIES = [
  null, true, false, -1, 0, 1.5, NaN, Infinity, -Infinity,
  9007199254740991, 9007199254740992, 1e30, -1e30,
  "", " ", "abc", "5", "0x10", "1e3", "😀", "x".repeat(5000),
  [], [1], [null], {}, { sequence: 1 }, { SEQUENCE: 5 },
  { sequence: null }, { sequence: "5" }, { sequence: 1.5 },
  { sequence: -1 }, { sequence: 9007199254740992 },
  { sequence: Number.NaN }, { sequence: [5] }, { sequence: { n: 5 } },
];
const OPAQUE_CURSOR_HOSTILES = [
  "", " ", "!!!not-base64!!!", "a", "====", "e30", "e30=", "W10=", "bnVsbA",
  "eyJvZmZzZXQiOiJhYmMifQ", "eyJvZmZzZXQiOi0xfQ", "eyJvZmZzZXQiOjEuNX0",
  "eyJvZmZzZXQiOjkwMDcxOTkyNTQ3NDA5OTJ9", "e30K", "😀", "x".repeat(2000),
  "eyJ1IjoxMjMsImkiOiJhYmMifQ", // {"u":123,"i":"abc"} wrong field types
  "WyJhIl0", // ["a"] — array, rejected
  "MTIz", // "123" — bare number JSON
  "\"abc\"", // JSON string
  "eyJxIjoicmVhZHkiLCJpIjoxMjN9", // {"q":"ready","i":123} wrong id type
  "eyJ1IjoiMjAyNiIsImkiOiJhYmMiLCJzIjoieCJ9", // extra s field mismatching state
];

/* ---------------- fixture ---------------- */
const ROOM = "fuzzroom";
const MEMBER_COUNT = 10; // 10 keys x 600 req/min rate budget = 6000, above the 3000 target
let store, server, base, keys = [], head = 0, tmpRoot;

function boot(t) {
  mkdirSync(process.env.TMPDIR ?? "/tmp", { recursive: true });
  tmpRoot = mkdtempSync(join(process.env.TMPDIR, "fuzz11-"));
  store = new RoomStore(join(tmpRoot, "room.sqlite"));
  store.initialize(initialRoom(ROOM));
  keys.push(store.issueAccessKey(ROOM, "owner"));
  for (let i = 0; i < MEMBER_COUNT; i++) {
    const id = `fuzzmember${i}`;
    store.command(keys[0], ROOM, { id: `add-${id}`, type: "member.added",
      data: { memberId: id, displayName: id, kind: "agent", permissions: ["accept_work", "complete_work"] } });
    keys.push(store.issueAccessKey(ROOM, id));
  }
  // Seed event history: owner posts 40 plain messages, rotating across members
  // to stay under the per-member flood-guard burst (30).
  for (let i = 0; i < 40; i++) {
    const k = keys[1 + (i % MEMBER_COUNT)];
    store.command(k, ROOM, { id: randomUUID(), type: "message.posted",
      data: { messageId: randomUUID(), body: `fuzz message ${i}` } });
  }
  head = store.room(ROOM).sequence;
  assert.ok(head > 40, `expected a real event log, head=${head}`);

  server = createRoomServer({ store, streamInterval: 60000 });
  return (async () => {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
      try { server.closeStreams(); } catch {}
      try { server.closeAllConnections(); } catch {}
      await new Promise(resolve => server.close(resolve));
      store.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    });
  })();
}

let keyIdx = 0;
const nextKey = () => keys[(keyIdx++) % keys.length];
const TIMEOUT_MS = 8000;

async function req(method, path, { key, headers = {}, body, query = "" } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  stats.requests++;
  try {
    const res = await fetch(`${base}${path}${query}`, {
      method,
      headers: { Authorization: `Bearer ${key ?? nextKey()}`, ...headers },
      body,
      signal: ctl.signal,
    });
    let text = "";
    try { text = await res.text(); } catch (e) { text = `<body-read-failed: ${e?.message ?? e}>`; }
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, text, parsed, headers: res.headers };
  } catch (e) {
    if (e?.name === "AbortError") return { status: "TIMEOUT", text: "", parsed: null, timeout: true };
    return { status: "FETCH_ERROR", text: String(e?.message ?? e), parsed: null, fetchError: true };
  } finally {
    clearTimeout(timer);
  }
}

// Read one SSE data chunk, then abort. Returns {status, chunk}.
async function sseOnce(path, { key, query = "", headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("sse-timeout")), TIMEOUT_MS);
  stats.requests++; stats.sse++;
  try {
    const res = await fetch(`${base}${path}${query}`, {
      headers: { Authorization: `Bearer ${key ?? nextKey()}`, Accept: "text/event-stream", ...headers },
      signal: ctl.signal,
    });
    if (res.status !== 200) {
      let text = ""; try { text = await res.text(); } catch {}
      clearTimeout(timer);
      return { status: res.status, text };
    }
    const reader = res.body.getReader();
    const { value, done } = await reader.read();
    clearTimeout(timer);
    ctl.abort();
    try { await reader.cancel(); } catch {}
    return { status: 200, chunk: Buffer.from(value ?? []).toString("utf8"), done };
  } catch (e) {
    clearTimeout(timer);
    const msg = String(e?.message ?? e);
    if (/sse-timeout|aborted|abort/i.test(msg)) return { status: "TIMEOUT", chunk: "" };
    return { status: "FETCH_ERROR", chunk: msg };
  }
}

const is4xx = s => typeof s === "number" && s >= 400 && s < 500;
const is5xx = s => typeof s === "number" && s >= 500;
function checkNoCrash(label, r, ctx) {
  if (r.timeout) note("HANG", `${label} timed out after ${TIMEOUT_MS}ms`, ctx);
  else if (r.fetchError) note("FETCH_ERROR", `${label} transport error`, `${ctx} :: ${r.text}`);
  else if (is5xx(r.status)) note("HTTP_500", `${label} returned ${r.status}`, `${ctx} :: ${r.text.slice(0, 200)}`);
}
function expect4xx(label, r, ctx) {
  checkNoCrash(label, r, ctx);
  if (!r.timeout && !r.fetchError && !is4xx(r.status) && !is5xx(r.status))
    note("EXPECTED_4XX", `${label} returned ${r.status}, expected 4xx`, `${ctx} :: ${r.text.slice(0, 200)}`);
}

/* ---------------- tests ---------------- */

test("fuzz-11 sse/event cursor fuzz", async t => {
  await boot(t);
  const ownerKey = keys[0];

  // ---- Phase A: GET /events?after=<hostile> ----
  await t.test("A: /events hostile after", async () => {
    for (const a of HOSTILE_STRINGS) {
      const r = await req("GET", `/api/rooms/${ROOM}/events`, { query: `?after=${encodeURIComponent(a)}` });
      stats.json++;
      checkNoCrash("events after", r, `after=${JSON.stringify(a)}`);
    }
    // absent / repeated params
    for (const q of ["", "?after", "?after=&after=1", "?afterSequence=5", "?after=5&after=6"]) {
      const r = await req("GET", `/api/rooms/${ROOM}/events`, { query: q });
      stats.json++;
      checkNoCrash("events after-shape", r, `query=${q}`);
      if (q === "?afterSequence=5" && r.status !== 422)
        note("EXPECTED_422", `afterSequence should be 422, got ${r.status}`, q);
    }
    // hostile limit
    for (const l of ["-1", "0", "101", "1000", "abc", "1.5", "1e9", "", " ", "x".repeat(500)]) {
      const r = await req("GET", `/api/rooms/${ROOM}/events`, { query: `?after=0&limit=${encodeURIComponent(l)}` });
      stats.json++;
      // Empty/whitespace limit reasonably falls back to default (200); others must be 4xx.
      if (l === "" || l === " ") {
        checkNoCrash("events limit", r, `limit=${JSON.stringify(l)}`);
      } else {
        expect4xx("events limit", r, `limit=${JSON.stringify(l)}`);
      }
    }
    // hostile tail
    for (const tail of ["0", "-1", "201", "abc", "1.5", "1e9", "", " ", "x".repeat(500), "200", "1"]) {
      const r = await req("GET", `/api/rooms/${ROOM}/events`, { query: `?tail=${encodeURIComponent(tail)}` });
      stats.json++;
      checkNoCrash("events tail", r, `tail=${JSON.stringify(tail)}`);
      if ((tail === "200" || tail === "1") && r.status !== 200)
        note("EXPECTED_200", `tail=${tail} should be 200, got ${r.status}`, r.text.slice(0, 200));
      if (["-1", "0", "201", "abc", "1e9"].includes(tail) && !is4xx(r.status) && !is5xx(r.status))
        note("EXPECTED_4XX", `tail=${tail} should be 4xx, got ${r.status}`, r.text.slice(0, 200));
    }
    // hostile actor/since/until filters
    for (const actor of ["x", "", "1; DROP", "😀", "x".repeat(2000)]) {
      const r = await req("GET", `/api/rooms/${ROOM}/events`, { query: `?after=0&actor=${encodeURIComponent(actor)}` });
      stats.json++;
      checkNoCrash("events actor", r, `actor=${JSON.stringify(actor).slice(0, 60)}`);
    }
    for (const d of ["not-a-date", "9999", "", "2026-13-99", "x".repeat(500)]) {
      const r = await req("GET", `/api/rooms/${ROOM}/events`, { query: `?after=0&since=${encodeURIComponent(d)}` });
      stats.json++;
      checkNoCrash("events since", r, `since=${d.slice(0, 40)}`);
      if (d === "not-a-date" && !is4xx(r.status)) note("EXPECTED_4XX", `since=not-a-date got ${r.status}`, "");
    }
    // cursor beyond head -> documented 409 cursor_ahead (4xx, never hang)
    for (const a of ["9007199254740991", "999999999", String(head + 1), String(head + 1000)]) {
      const r = await req("GET", `/api/rooms/${ROOM}/events`, { query: `?after=${a}` });
      stats.json++;
      checkNoCrash("events beyond-head", r, `after=${a}`);
      if (r.status !== 409) observe(`beyond-head after=${a} returned ${r.status} (code expects 409 cursor_ahead)`, r.text.slice(0, 160));
    }
  });

  // ---- Phase B: SSE /stream hostile after ----
  await t.test("B: /stream hostile cursor", async () => {
    for (const a of HOSTILE_STRINGS) {
      const r = await sseOnce(`/api/rooms/${ROOM}/stream`, { query: `?after=${encodeURIComponent(a)}` });
      if (r.status === "TIMEOUT") note("HANG", `/stream SSE timed out`, `after=${JSON.stringify(a)}`);
      else if (r.status === "FETCH_ERROR") note("FETCH_ERROR", `/stream transport error`, `after=${JSON.stringify(a)} :: ${r.chunk}`);
      else if (is5xx(r.status)) note("HTTP_500", `/stream returned ${r.status}`, `after=${JSON.stringify(a)} :: ${r.text?.slice(0, 160) ?? ""}`);
      else if (r.status !== 200 && !is4xx(r.status)) note("UNEXPECTED_STATUS", `/stream returned ${r.status}`, `after=${JSON.stringify(a)}`);
    }
    // last-event-id header variants (header wins over query)
    for (const h of ["-5", "abc", "9007199254740992", "3", "0"]) {
      const r = await sseOnce(`/api/rooms/${ROOM}/stream`, { query: "?after=0", headers: { "last-event-id": h } });
      if (r.status === "TIMEOUT") note("HANG", `/stream last-event-id timed out`, `header=${h}`);
      else if (is5xx(r.status)) note("HTTP_500", `/stream last-event-id=${h} -> ${r.status}`, "");
      else if (["-5", "abc", "9007199254740992"].includes(h) && !is4xx(r.status))
        note("EXPECTED_4XX", `/stream last-event-id=${h} got ${r.status}`, "");
      if ((h === "3" || h === "0") && r.status === 200) {
        // first chunk should carry room-event ids starting right after the cursor
        const ids = [...r.chunk.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
        if (ids.length && ids[0] !== Number(h) + 1)
          note("SSE_RESUME_GAP", `last-event-id=${h}: first id ${ids[0]}, expected ${Number(h) + 1}`, r.chunk.slice(0, 300));
        for (let i = 1; i < ids.length; i++)
          if (ids[i] !== ids[i - 1] + 1) note("SSE_RESUME_GAP", `last-event-id=${h}: non-contiguous ids`, ids.join(","));
      }
    }
    // beyond-head cursor on SSE -> probe throws 409 before headers (4xx, no hang)
    const r = await sseOnce(`/api/rooms/${ROOM}/stream`, { query: `?after=${head + 500}` });
    if (r.status === "TIMEOUT") note("HANG", `/stream beyond-head SSE timed out`, "");
    else if (is5xx(r.status)) note("HTTP_500", `/stream beyond-head -> ${r.status}`, "");
    else if (r.status !== 200 && !is4xx(r.status)) note("UNEXPECTED_STATUS", `/stream beyond-head -> ${r.status}`, "");
    else observe(`/stream beyond-head returned ${r.status} (no hang)`, "");
  });

  // ---- Phase C: POST /cursor hostile sequence ----
  await t.test("C: POST /cursor hostile sequence", async () => {
    for (const v of HOSTILE_BODIES) {
      const r = await req("POST", `/api/rooms/${ROOM}/cursor`, {
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(v),
      });
      stats.json++;
      if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && Number.isSafeInteger(v.sequence) && v.sequence >= 0 && v.sequence <= head) {
        if (r.status !== 200) note("EXPECTED_200", `cursor valid seq ${v.sequence} got ${r.status}`, r.text.slice(0, 160));
        continue;
      }
      expect4xx("cursor body", r, `body=${JSON.stringify(v)?.slice(0, 120)}`);
    }
    // non-JSON / wrong content type
    for (const b of ["not json", "", "[1,2]", "5", "\"x\""]) {
      const r = await req("POST", `/api/rooms/${ROOM}/cursor`, {
        headers: { "Content-Type": "application/json" }, body: b,
      });
      stats.json++;
      expect4xx("cursor malformed-json", r, `body=${b.slice(0, 40)}`);
    }
    // raw string body that JSON-parses to hostile scalars via exact() path
    const r = await req("POST", `/api/rooms/${ROOM}/cursor`, {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sequence: 5, extra: 1 }),
    });
    stats.json++;
    expect4xx("cursor extra-field", r, r.text.slice(0, 160));
  });

  // ---- Phase D: /return-brief hostile horizon/after/cursor/limit ----
  await t.test("D: /return-brief hostile params", async () => {
    for (let i = 0; i < 240; i++) {
      const h = pick(HOSTILE_STRINGS), a = pick(HOSTILE_STRINGS),
        c = pick(HOSTILE_STRINGS), l = pick(HOSTILE_STRINGS);
      const r = await req("GET", `/api/rooms/${ROOM}/return-brief`, {
        query: `?horizon=${encodeURIComponent(h)}&after=${encodeURIComponent(a)}&cursor=${encodeURIComponent(c)}&limit=${encodeURIComponent(l)}`,
      });
      stats.json++;
      checkNoCrash("return-brief", r, `h=${h.slice(0, 20)} a=${a.slice(0, 20)} c=${c.slice(0, 20)} l=${l.slice(0, 20)}`);
      if (r.status === 200 && r.parsed) {
        // valid-shaped responses keep the frozen-horizon contract
        const hist = r.parsed.history;
        if (hist && typeof hist.evaluatedThrough !== "number")
          note("BRIEF_SHAPE", `return-brief 200 with non-numeric evaluatedThrough`, r.text.slice(0, 200));
      }
    }
    // sanity: plain call is 200 with the documented shape
    const ok = await req("GET", `/api/rooms/${ROOM}/return-brief`, {});
    stats.json++;
    if (ok.status !== 200) note("EXPECTED_200", `return-brief plain got ${ok.status}`, ok.text.slice(0, 160));
  });

  // ---- Phase E: /work-claims opaque cursor ----
  await t.test("E: /work-claims opaque cursor", async () => {
    for (const c of OPAQUE_CURSOR_HOSTILES) {
      const r = await req("GET", `/api/rooms/${ROOM}/work-claims`, { query: `?cursor=${encodeURIComponent(c)}` });
      stats.json++;
      expect4xx("work-claims cursor", r, `cursor=${c.slice(0, 60)}`);
    }
    for (const c of OPAQUE_CURSOR_HOSTILES) {
      const r = await req("GET", `/api/rooms/${ROOM}/work-claims`, { query: `?queue=ready&cursor=${encodeURIComponent(c)}` });
      stats.json++;
      expect4xx("work-claims ready cursor", r, `cursor=${c.slice(0, 60)}`);
    }
    // round-trip: a real nextCursor must be accepted
    const p1 = await req("GET", `/api/rooms/${ROOM}/work-claims`, { query: "?limit=1" });
    stats.json++;
    if (p1.status === 200 && p1.parsed?.nextCursor) {
      const p2 = await req("GET", `/api/rooms/${ROOM}/work-claims`, { query: `?limit=1&cursor=${encodeURIComponent(p1.parsed.nextCursor)}` });
      stats.json++;
      if (p2.status !== 200) note("CURSOR_ROUNDTRIP", `real nextCursor rejected: ${p2.status}`, p2.text.slice(0, 160));
    }
  });

  // ---- Phase F: /receipts opaque cursor ----
  await t.test("F: /receipts opaque cursor", async () => {
    for (const c of OPAQUE_CURSOR_HOSTILES) {
      const r = await req("GET", `/api/rooms/${ROOM}/receipts`, { query: `?cursor=${encodeURIComponent(c)}` });
      stats.json++;
      checkNoCrash("receipts cursor", r, `cursor=${c.slice(0, 60)}`);
      if (!is4xx(r.status) && !is5xx(r.status)) note("EXPECTED_4XX", `receipts cursor=${c.slice(0, 30)} got ${r.status}`, "");
    }
  });

  // ---- Phase G: differential replay correctness on /events ----
  await t.test("G: differential replay from old cursors", async () => {
    const key = ownerKey;
    // full walk from 0 with a small page: union must be exactly 1..head, no gaps/dups
    const seen = [];
    let after = 0, guard = 0;
    for (;;) {
      const r = await req("GET", `/api/rooms/${ROOM}/events`, { key, query: `?after=${after}&limit=7` });
      stats.json++;
      if (r.status !== 200) { note("REPLAY_WALK", `walk page after=${after} got ${r.status}`, r.text.slice(0, 160)); break; }
      const seqs = (r.parsed.events ?? []).map(e => e.sequence);
      seen.push(...seqs);
      for (let i = 1; i < seqs.length; i++)
        if (seqs[i] !== seqs[i - 1] + 1) note("REPLAY_GAP", `page after=${after} non-contiguous`, seqs.join(","));
      if (!r.parsed.hasMore) break;
      if (typeof r.parsed.next !== "number" || r.parsed.next <= after) {
        note("REPLAY_STALL", `next=${r.parsed.next} did not advance past after=${after}`, "");
        break;
      }
      after = r.parsed.next;
      if (++guard > 500) { note("REPLAY_STALL", "walk exceeded 500 pages", ""); break; }
    }
    const dupes = seen.filter((s, i) => seen.indexOf(s) !== i);
    if (dupes.length) note("REPLAY_DUP", `duplicate sequences in walk`, [...new Set(dupes)].slice(0, 10).join(","));
    const expected = Array.from({ length: head }, (_, i) => i + 1);
    const missing = expected.filter(s => !seen.includes(s));
    if (missing.length) note("REPLAY_GAP", `walk missed ${missing.length} sequences`, missing.slice(0, 10).join(","));

    // random valid cursors: HTTP page must equal direct store read (owner sees all)
    for (let i = 0; i < 120; i++) {
      const a = randInt(0, head);
      const lim = randInt(1, 100);
      const r = await req("GET", `/api/rooms/${ROOM}/events`, { key, query: `?after=${a}&limit=${lim}` });
      stats.json++;
      if (r.status !== 200) { note("DIFF_STATUS", `after=${a} limit=${lim} got ${r.status}`, ""); continue; }
      const direct = store.eventsAfter(key, ROOM, a, lim, null);
      const httpSeqs = (r.parsed.events ?? []).map(e => e.sequence).join(",");
      const directSeqs = direct.events.map(e => e.sequence).join(",");
      if (httpSeqs !== directSeqs)
        note("DIFF_MISMATCH", `after=${a} limit=${lim}: http != store`, `http=[${httpSeqs}] store=[${directSeqs}]`);
      if (r.parsed.next !== direct.next || r.parsed.hasMore !== direct.hasMore)
        note("DIFF_CURSOR", `after=${a}: next/hasMore differ`, `http next=${r.parsed.next} hasMore=${r.parsed.hasMore} vs store next=${direct.next} hasMore=${direct.hasMore}`);
    }
  });

  // ---- bulk hostile /events to reach the 3000-request floor ----
  await t.test("H: bulk hostile cursor volume", async () => {
    const kinds = ["events-after", "events-limit", "stream", "return-brief"];
    while (stats.requests < 3200) {
      const k = pick(kinds);
      if (k === "events-after") {
        const a = pick(HOSTILE_STRINGS);
        const r = await req("GET", `/api/rooms/${ROOM}/events`, { query: `?after=${encodeURIComponent(a)}&limit=${randInt(1, 100)}` });
        stats.json++;
        checkNoCrash("bulk events-after", r, `after=${a.slice(0, 40)}`);
      } else if (k === "events-limit") {
        const r = await req("GET", `/api/rooms/${ROOM}/events`, { query: `?after=${randInt(0, head)}&limit=${encodeURIComponent(pick(HOSTILE_STRINGS))}` });
        stats.json++;
        checkNoCrash("bulk events-limit", r, "");
      } else if (k === "stream") {
        const r = await sseOnce(`/api/rooms/${ROOM}/stream`, { query: `?after=${encodeURIComponent(pick(HOSTILE_STRINGS))}` });
        if (r.status === "TIMEOUT") note("HANG", "bulk /stream timed out", "");
        else if (r.status === "FETCH_ERROR") note("FETCH_ERROR", "bulk /stream transport error", r.chunk.slice(0, 120));
        else if (is5xx(r.status)) note("HTTP_500", `bulk /stream -> ${r.status}`, "");
      } else {
        const r = await req("GET", `/api/rooms/${ROOM}/return-brief`, {
          query: `?horizon=${encodeURIComponent(pick(HOSTILE_STRINGS))}&after=${encodeURIComponent(pick(HOSTILE_STRINGS))}&cursor=${encodeURIComponent(pick(HOSTILE_STRINGS))}&limit=${encodeURIComponent(pick(HOSTILE_STRINGS))}`,
        });
        stats.json++;
        checkNoCrash("bulk return-brief", r, "");
      }
    }
  });

  console.log(`[fuzz-11-sse-cursor] requests=${stats.requests} (sse=${stats.sse}, json=${stats.json}) violations=${violations.length} observations=${observations.length}`);
  for (const v of violations.slice(0, 40)) console.log(`[fuzz-11-sse-cursor] VIOLATION ${v.kind}: ${v.detail} :: ${v.extra}`);
  for (const o of observations.slice(0, 20)) console.log(`[fuzz-11-sse-cursor] OBSERVE: ${o.detail} :: ${o.extra}`);
  assert.ok(stats.requests >= 3000, `expected >=3000 requests, made ${stats.requests}`);
  assert.equal(violations.length, 0, `${violations.length} invariant violations (see log above)`);
});
