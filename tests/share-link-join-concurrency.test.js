// Abuse tests for the share-link self-service join flow
// (200-hard-tasks #92, burncrew-invite-abuse-92).
//
// 1. REGRESSION (fail-first): the #770 membership-reuse path records no
//    idempotency, so a lost-cookie retry of a membership-reuse join with the
//    same redemptionId creates a SECOND guest. The #770 otherSession check
//    cannot see it because no share_link_joins row was ever written.
// 2. CONCURRENCY PROOFS: 50 parallel joins must create exactly one guest:
//    - same slot + same redemptionId (double submit / retried request)
//    - 50 distinct slots + same redemptionId (the #770 lost-cookie race)
//    - 50 distinct joins vs maxJoins=5 (invite spam cannot exceed the cap)
//    - 50 joinAgent calls for one identity
// 3. HTTP THUNDERING HERD: 50 concurrent POST /api/share-links/join against
//    a live server — exactly one guest, clean 4xx for the rest, zero 5xx.
//
// Child processes each open their own SQLite connection against the same
// database file, so the store-level races are real (WAL + BEGIN IMMEDIATE
// serialization), not same-thread interleavings. Transient SQLITE_BUSY from
// the thundering herd itself is retried inside the harness (the production
// server is single-process; its event loop serializes joins) — the
// assertions target the join LOGIC: never two guests for one redemption.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORE_MJS = join(REPO, "server", "store.mjs");
const ROOM = "commons";
const RACERS = 50;

// Retry a RoomStore open: 50 processes constructing at once contend on the
// constructor's eager integrity write transaction (a harness artifact, not the
// join logic under test). Back off and retry instead of failing the proof.
async function openStore(dbPath, attempts = 40) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return new RoomStore(dbPath); }
    catch (error) { last = error; await new Promise(r => setTimeout(r, 50 + Math.random() * 150)); }
  }
  throw last;
}

// Child template: retries the join itself on transient SQLITE_BUSY so the
// test proves the join logic (exactly one guest), not lock timing.
const childBody = (call) => `import { RoomStore } from ${JSON.stringify("file://" + STORE_MJS)};
const log = o => console.log("RESULT " + JSON.stringify(o));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let store;
for (let i = 0; i < 60; i++) {
  try { store = new RoomStore(process.argv[2]); break; }
  catch (error) { if (i === 59) { log({ phase: "open", message: String(error?.message).slice(0,120) }); process.exit(0); } await sleep(50 + Math.random() * 150); }
}
for (let i = 0; i < 15; i++) {
  try {
    const result = ${call};
    log({ ok: true, duplicate: result.duplicate === true });
    break;
  } catch (error) {
    const busy = /database is locked|SQLITE_BUSY/i.test(String(error?.message));
    if (busy && i < 14) { await sleep(25 + Math.random() * 100); continue; }
    log({ ok: false, status: error?.status ?? null, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 160) });
    break;
  }
}
try { store.close(); } catch {}
`;

const JOIN_CHILD = childBody(`store.shareLinks.join(process.argv[3], process.argv[4], {
  displayName: process.argv[5], redemptionId: process.argv[6],
  expectedSessionRevision: Number(process.argv[7]), expectedSessionBinding: process.argv[8] })`);

const JOIN_AGENT_CHILD = childBody(`store.shareLinks.joinAgent(process.argv[3], process.argv[4], process.argv[5])`);

// Per AGENTS.md: never /tmp (tmpfs is near-full -> SQLITE_FULL); test scratch
// lives in the worktree .tmp directory.
function scratch(t, name) {
  const dir = mkdtempSync(join(REPO, ".tmp", name + "-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function setup(t, { maxJoins }) {
  const dir = scratch(t, "sharejoin-race");
  const dbPath = join(dir, "room.sqlite");
  const store = new RoomStore(dbPath);
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const linkToken = randomBytes(32).toString("base64url");
  const created = store.shareLinks.create(ownerKey, ROOM, {
    requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000,
    maxJoins, expectedMemberRevision: 0,
  }, null);
  assert.ok(created?.link?.id, "share link created");
  const linkId = created.link.id;
  writeFileSync(join(dir, "join-child.mjs"), JOIN_CHILD);
  writeFileSync(join(dir, "join-agent-child.mjs"), JOIN_AGENT_CHILD);
  store.close();
  return { dir, dbPath, linkId, linkToken };
}

function runRacers(dir, childFile, argSets) {
  return Promise.all(argSets.map(args => new Promise(resolve => {
    execFile(process.execPath, [join(dir, childFile), ...args], { timeout: 180000 }, (error, stdout) => {
      const line = String(stdout).split("\n").find(l => l.startsWith("RESULT "));
      let parsed = null;
      try { parsed = JSON.parse(line.slice("RESULT ".length)); } catch { /* leave null */ }
      resolve({ parsed, execError: error ? String(error.message).slice(0, 120) : null });
    });
  })));
}

const outcomesOf = results => {
  const missing = results.filter(r => !r.parsed);
  assert.equal(missing.length, 0, `every child must report, got: ${JSON.stringify(missing.slice(0, 2))}`);
  return results.map(r => r.parsed);
};

function countJoins(dbPath, linkId) {
  const store = new RoomStore(dbPath);
  try { return store.db.prepare("SELECT COUNT(*) AS n FROM share_link_joins WHERE link_id=?").get(linkId).n; }
  finally { store.close(); }
}

function membersNamed(dbPath, displayName) {
  const store = new RoomStore(dbPath);
  try {
    return Object.values(store.room(ROOM).state.members).filter(m => m.displayName === displayName);
  } finally { store.close(); }
}

async function makeSlots(dbPath, n) {
  const store = await openStore(dbPath);
  try {
    return Array.from({ length: n }, () => {
      const slot = store.createAccountSessionSlot();
      const view = store.accountSessionSlot(slot.token);
      return { token: slot.token, rev: view.sessionRevision, binding: view.sessionBinding, csrf: view.csrf };
    });
  } finally { store.close(); }
}

test("#770 regression: lost-cookie retry of a membership-reuse join must not create a second guest", async t => {
  const { dbPath, linkToken } = setup(t, { maxJoins: 25 });
  const store = await openStore(dbPath);
  try {
    const slotOf = token => {
      const v = store.accountSessionSlot(token);
      return { expectedSessionRevision: v.sessionRevision, expectedSessionBinding: v.sessionBinding };
    };
    // 1. Alice joins as a guest -> account A, member "Alice".
    const s1 = store.createAccountSessionSlot();
    const j1 = store.shareLinks.join(s1.token, linkToken, { displayName: "Alice", redemptionId: randomUUID(), ...slotOf(s1.token) });
    assert.equal(j1.duplicate, false);
    // 2. Alice (now a member) opens the link again with a fresh redemptionId
    //    -> membership-reuse path, duplicate:true.
    const reuseRedemption = randomUUID();
    const j2 = store.shareLinks.join(s1.token, linkToken, { displayName: "Alice", redemptionId: reuseRedemption, ...slotOf(s1.token) });
    assert.equal(j2.duplicate, true, "existing member reuses membership");
    // 3. Cookie lost -> fresh unauthenticated slot, SAME redemptionId, a
    //    different (available) name. Must be rejected as a replay, not joined.
    const s2 = store.createAccountSessionSlot();
    assert.throws(() => store.shareLinks.join(s2.token, linkToken,
      { displayName: "Zed Visitor", redemptionId: reuseRedemption, ...slotOf(s2.token) }),
      { status: 409, code: "join_session_lost" },
      "lost-cookie retry of a membership-reuse join is a 409, not a second guest");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 2, "no second account created");
  } finally { store.close(); }
});

test("50 concurrent identical share-link joins create exactly one guest (same slot, same redemptionId)", async t => {
  const { dir, dbPath, linkId, linkToken } = setup(t, { maxJoins: 25 });
  const [slot] = await makeSlots(dbPath, 1);
  const redemptionId = randomUUID();
  const displayName = "Race Guest";
  const args = [dbPath, slot.token, linkToken, displayName, redemptionId, String(slot.rev), slot.binding];
  const outcomes = outcomesOf(await runRacers(dir, "join-child.mjs", Array.from({ length: RACERS }, () => args)));
  const winners = outcomes.filter(o => o.ok && !o.duplicate);
  const failures = outcomes.filter(o => !o.ok);
  assert.equal(winners.length, 1, `exactly one join must win, got ${winners.length}`);
  for (const f of failures) {
    assert.ok(f.status !== null && f.status !== undefined, `loser must carry a RoomError status, got ${JSON.stringify(f)}`);
    assert.equal(f.status, 409, `loser must be a 409, got ${JSON.stringify(f)}`);
  }
  assert.equal(countJoins(dbPath, linkId), 1, "exactly one share_link_joins row");
  assert.equal(membersNamed(dbPath, displayName).length, 1, "exactly one guest member");
  // The 409 losers converge: a retry with a refreshed session revision sees
  // the committed join and returns the idempotent duplicate result.
  const store = await openStore(dbPath);
  try {
    const fresh = store.accountSessionSlot(slot.token);
    const retry = store.shareLinks.join(slot.token, linkToken, {
      displayName, redemptionId,
      expectedSessionRevision: fresh.sessionRevision, expectedSessionBinding: fresh.sessionBinding,
    });
    assert.equal(retry.duplicate, true, "refreshed retry returns duplicate:true");
    assert.equal(countJoins(dbPath, linkId), 1, "retry creates no second join row");
  } finally { store.close(); }
});

test("50 concurrent lost-cookie retries (distinct slots, same redemptionId) create exactly one guest (#770 race)", async t => {
  const { dir, dbPath, linkId, linkToken } = setup(t, { maxJoins: 25 });
  const slots = await makeSlots(dbPath, RACERS);
  const redemptionId = randomUUID();
  const displayName = "Cookie Loss Guest";
  const argSets = slots.map(s => [dbPath, s.token, linkToken, displayName, redemptionId, String(s.rev), s.binding]);
  const outcomes = outcomesOf(await runRacers(dir, "join-child.mjs", argSets));
  const winners = outcomes.filter(o => o.ok && !o.duplicate);
  const failures = outcomes.filter(o => !o.ok);
  assert.equal(winners.length, 1, `exactly one join must win, got ${winners.length}`);
  assert.equal(failures.length, RACERS - 1, "every other slot must be rejected");
  for (const f of failures) {
    assert.deepEqual([f.status, f.code], [409, "join_session_lost"],
      `#770: loser must be 409 join_session_lost, got ${JSON.stringify(f)}`);
  }
  assert.equal(countJoins(dbPath, linkId), 1, "exactly one share_link_joins row");
  assert.equal(membersNamed(dbPath, displayName).length, 1, "exactly one guest member");
});

test("invite spam cannot exceed max_joins under 50 concurrent distinct joins", async t => {
  const { dir, dbPath, linkId, linkToken } = setup(t, { maxJoins: 5 });
  const slots = await makeSlots(dbPath, RACERS);
  const argSets = slots.map((s, i) => [dbPath, s.token, linkToken, `Spam Guest ${i}`, randomUUID(), String(s.rev), s.binding]);
  const outcomes = outcomesOf(await runRacers(dir, "join-child.mjs", argSets));
  const winners = outcomes.filter(o => o.ok && !o.duplicate);
  const failures = outcomes.filter(o => !o.ok);
  assert.equal(winners.length, 5, `exactly maxJoins=5 joins must win, got ${winners.length}`);
  assert.equal(failures.length, RACERS - 5, "every join past the cap must be rejected");
  for (const f of failures) {
    assert.deepEqual([f.status, f.code], [410, "link_unavailable"],
      `over-cap join must be 410 link_unavailable, got ${JSON.stringify(f)}`);
  }
  assert.equal(countJoins(dbPath, linkId), 5, "exactly five share_link_joins rows");
});

test("50 concurrent joinAgent calls for one identity create exactly one member", async t => {
  const { dir, dbPath, linkToken } = setup(t, { maxJoins: 25 });
  const store = await openStore(dbPath);
  let secret;
  try { secret = store.identities.create("Race Agent").secret; } finally { store.close(); }
  assert.ok(/^pri_/.test(secret), "agent identity secret minted");
  const argSets = Array.from({ length: RACERS }, () => [dbPath, secret, linkToken, "Race Agent"]);
  const outcomes = outcomesOf(await runRacers(dir, "join-agent-child.mjs", argSets));
  const winners = outcomes.filter(o => o.ok && !o.duplicate);
  const dupes = outcomes.filter(o => o.ok && o.duplicate);
  const failures = outcomes.filter(o => !o.ok);
  assert.equal(winners.length, 1, `exactly one joinAgent must win, got ${winners.length}`);
  assert.equal(failures.length, 0, `no joinAgent may throw, got ${JSON.stringify(failures.slice(0, 2))}`);
  assert.equal(dupes.length, RACERS - 1, "every other call returns duplicate:true");
  const check = await openStore(dbPath);
  try {
    const links = check.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE room_id=?").get(ROOM).n;
    assert.equal(links, 1, "exactly one identity_links row");
    assert.equal(membersNamed(dbPath, "Race Agent").length, 1, "exactly one member for the identity");
  } finally { check.close(); }
});

test("HTTP thundering herd: 50 concurrent share-link joins -> one guest, clean 4xx, zero 5xx", async t => {
  const dir = scratch(t, "sharejoin-http");
  const dbPath = join(dir, "room.sqlite");
  const store = new RoomStore(dbPath);
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const linkToken = randomBytes(32).toString("base64url");
  store.shareLinks.create(ownerKey, ROOM, {
    requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000,
    maxJoins: 25, expectedMemberRevision: 0,
  }, null);
  const slots = Array.from({ length: RACERS }, () => {
    const slot = store.createAccountSessionSlot();
    const view = store.accountSessionSlot(slot.token);
    return { token: slot.token, rev: view.sessionRevision, binding: view.sessionBinding, csrf: view.csrf };
  });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const redemptionId = randomUUID();
  const attempt = s => fetch(`${origin}/api/share-links/join`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: `account_session=${s.token}`,
      "x-csrf-token": s.csrf,
      "x-session-binding": s.binding,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ linkToken, displayName: "Herd Guest", redemptionId, expectedSessionRevision: s.rev }),
  }).then(async res => ({ status: res.status, body: await res.json().catch(() => ({})) }))
    .catch(error => ({ status: 0, transportError: String(error).slice(0, 120) }));
  const results = await Promise.all(slots.map(attempt));
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  t.diagnostic(`status distribution: ${JSON.stringify(byStatus)}`);
  assert.equal(results.filter(r => r.status === 201).length, 1, "exactly one 201 winner");
  assert.equal(results.filter(r => r.status >= 500 || r.status === 0).length, 0,
    `zero 5xx/transport errors, got ${JSON.stringify(results.filter(r => r.status >= 500 || r.status === 0).slice(0, 3))}`);
  for (const r of results.filter(r => r.status !== 201)) {
    assert.ok([200, 409, 429].includes(r.status), `loser must be a clean 200/409/429, got ${r.status}`);
  }
  // The losers are either #770 rejections (409, admitted past the rate
  // limiter) or the invite-spam rate limiter itself (429, 20/min per IP).
  assert.equal(byStatus[409] + (byStatus[429] ?? 0), RACERS - 1, "every loser is 409 or 429");
  const members = Object.values(store.room(ROOM).state.members).filter(m => m.displayName === "Herd Guest");
  assert.equal(members.length, 1, "exactly one guest member");
});
