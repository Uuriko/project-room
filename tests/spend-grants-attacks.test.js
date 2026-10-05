// QA slice D-2 attack tests: bypass testing on the spend-grants primitive
// (PR #1472) and the claim-bond shadow mode (PRs #1466/#1469).
//
// Contracts owned here (nothing else covers them):
// - cross-connection serialization: parallel authorizeSpend calls against one
//   cap never reserve more than the cap (the BEGIN IMMEDIATE check+reserve is
//   the mechanism; single-connection tests cannot interleave, so only worker
//   threads with separate connections exercise it)
// - concurrent nonce replay: the same nonce raced from two connections
//   authorizes exactly once (UNIQUE constraint backstop, not just the
//   sequential read check)
// - boundary exactness: price 0/negative refused, price == cap allowed,
//   price == cap+1 refused with cap_exceeded
// - charge-then-forward failure path at the tools/call boundary: a tool that
//   throws after the reservation voids it and restores headroom
// - route schema honesty: the POST body schema accepts every value the
//   issuance code accepts (numeric expiresAt)
//
// Authoring gate: each test names the regression it would catch; all go
// through exported production functions or the real tools/call boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { schemaErrors } from "../server/routes/dispatch.mjs";
import { SPEND_GRANT_ROUTES } from "../server/routes/spend-grants.mjs";
import { ensureGrantsSchema } from "../server/grants.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";
import {
  ensureSpendGrantsSchema,
  issueSpendGrant,
  authorizeSpend,
  spendGrantSummary,
  SpendGrantError,
} from "../server/spend-grants.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function attackDb(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-attack-"));
  const dbFile = join(directory, "attack.sqlite");
  const open = () => {
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;");
    return db;
  };
  t.after(() => { rmSync(directory, { recursive: true, force: true }); });
  return { directory, dbFile, open };
}

function issueAttackGrant(db, { capCents, perTxCapCents }) {
  ensureAutonomyTiersSchema(db);
  ensureGrantsSchema(db);
  ensureSpendGrantsSchema(db);
  return issueSpendGrant(db, "attack-room", "peer1", {
    grantedBy: "owner1", capCents, perTxCapCents, nowMs: Date.now(),
  });
}

// Worker source: hammers authorizeSpend from its own connection. Written to
// the fixture dir (never committed) so worker_threads can load it as ESM.
const WORKER_SOURCE = spendGrantsUrl => `
import { DatabaseSync } from "node:sqlite";
import { authorizeSpend } from ${JSON.stringify(spendGrantsUrl)};
import { parentPort, workerData } from "node:worker_threads";
const w = workerData;
const db = new DatabaseSync(w.dbFile);
db.exec("PRAGMA busy_timeout=10000;");
const out = { ok: 0, refused402: 0, dup409: 0, other: [] };
for (let i = 0; i < w.calls; i++) {
  const nonce = w.sharedNonce ? w.noncePrefix : w.noncePrefix + "-" + w.workerIndex + "-" + i;
  try {
    authorizeSpend(db, {
      roomId: w.roomId, agentId: w.agentId, toolName: w.toolName,
      priceCents: w.priceCents, nonce, nowMs: Date.now(),
    });
    out.ok++;
  } catch (error) {
    if (error && error.code === "duplicate_nonce") out.dup409++;
    else if (error && error.status === 402) out.refused402++;
    else out.other.push(String((error && error.code) || (error && error.message) || error));
  }
}
db.close();
parentPort.postMessage(out);
`;

function runWorkers(t, directory, baseData, workerCount) {
  const workerFile = join(directory, `attack-worker-${randomUUID()}.mjs`);
  writeFileSync(workerFile, WORKER_SOURCE(pathToFileURL(join(repoRoot, "server", "spend-grants.mjs")).href));
  const workers = Array.from({ length: workerCount }, (_, i) =>
    new Worker(workerFile, { workerData: { ...baseData, workerIndex: i } }));
  t.after(() => { for (const w of workers) w.terminate(); });
  return Promise.all(workers.map(w => new Promise((resolve, reject) => {
    w.once("message", resolve);
    w.once("error", reject);
    w.once("exit", code => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  })));
}

// --- Cross-connection serialization ---

test("parallel authorizeSpend across connections never reserves more than the cap",
  { timeout: 120000 }, async t => {
    const { directory, dbFile, open } = attackDb(t);
    {
      const db = open();
      issueAttackGrant(db, { capCents: "100", perTxCapCents: "100" });
      db.close();
    }
    const workerCount = 8, callsPerWorker = 10;
    const results = await runWorkers(t, directory, {
      dbFile, roomId: "attack-room", agentId: "peer1",
      toolName: "room_put_file", priceCents: 5, calls: callsPerWorker,
      noncePrefix: `hammer-${randomUUID()}`,
    }, workerCount);
    const total = results.reduce((acc, r) => ({
      ok: acc.ok + r.ok, refused402: acc.refused402 + r.refused402,
      dup409: acc.dup409 + r.dup409, other: [...acc.other, ...r.other],
    }), { ok: 0, refused402: 0, dup409: 0, other: [] });
    assert.deepEqual(total.other, [], `unexpected worker errors: ${JSON.stringify(total.other).slice(0, 500)}`);
    // Regression: if check+reserve ever escapes its single transaction, the
    // reserved total exceeds the cap.
    assert.equal(total.ok, 20, `exactly 20 reservations of 5 fit a 100 cap, got ${total.ok}`);
    assert.equal(total.refused402, workerCount * callsPerWorker - 20);
    const db = open();
    const reserved = db.prepare(
      `SELECT COALESCE(SUM(CAST(price_cents AS INTEGER)), 0) AS total FROM spend_authorizations
       WHERE room_id = 'attack-room' AND agent_id = 'peer1' AND status IN ('reserved','settled')`).get().total;
    db.close();
    assert.ok(reserved <= 100, `reserved ${reserved} exceeds cap 100`);
    assert.equal(reserved, 100);
  });

test("the same nonce raced from two connections authorizes exactly once",
  { timeout: 120000 }, async t => {
    const { directory, dbFile, open } = attackDb(t);
    {
      const db = open();
      issueAttackGrant(db, { capCents: "1000", perTxCapCents: "1000" });
      db.close();
    }
    const results = await runWorkers(t, directory, {
      dbFile, roomId: "attack-room", agentId: "peer1",
      toolName: "room_put_file", priceCents: 5, calls: 1,
      sharedNonce: true, noncePrefix: `race-${randomUUID()}`,
    }, 4);
    const total = results.reduce((acc, r) => ({
      ok: acc.ok + r.ok, dup409: acc.dup409 + r.dup409, other: [...acc.other, ...r.other],
    }), { ok: 0, dup409: 0, other: [] });
    assert.deepEqual(total.other, [], `unexpected worker errors: ${JSON.stringify(total.other).slice(0, 500)}`);
    // Regression: without the UNIQUE backstop, a raced replay double-charges.
    assert.equal(total.ok, 1, `exactly one racer may win, got ${total.ok}`);
    assert.equal(total.dup409, 3, "every loser gets 409 duplicate_nonce");
    const db = open();
    const rows = db.prepare(
      `SELECT COUNT(*) AS n FROM spend_authorizations
       WHERE room_id = 'attack-room' AND agent_id = 'peer1'`).get().n;
    db.close();
    assert.equal(rows, 1, "exactly one authorization row exists");
  });

// --- Boundary exactness ---

test("price boundaries: 0 and negative refused, exactly cap allowed, cap+1 refused", t => {
  const { open } = attackDb(t);
  const db = open();
  t.after(() => db.close());
  issueAttackGrant(db, { capCents: "10", perTxCapCents: "10" });
  const roomId = "attack-room", agentId = "peer1", nowMs = Date.now();
  const authz = (priceCents, nonce) =>
    authorizeSpend(db, { roomId, agentId, toolName: "room_put_file", priceCents, nonce, nowMs });
  const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected throw"); };
  assert.equal(capture(() => authz(0, "b0")).code, "invalid_spend_grant");
  assert.equal(capture(() => authz(-1, "bneg")).code, "invalid_spend_grant");
  // Exactly the cap: allowed.
  authz(10, "bexact").settle();
  assert.equal(spendGrantSummary(db, roomId, agentId, { nowMs }).remainingCents, "0");
  // One over the cap: honest 402.
  const over = capture(() => authz(1, "bover"));
  assert.ok(over instanceof SpendGrantError);
  assert.equal(over.status, 402);
  assert.equal(over.code, "payment_required");
  assert.equal(over.detail.reason, "cap_exceeded");
  assert.equal(over.detail.remainingCents, "0");
});

// --- Route schema honesty ---

test("POST /spend-grants body schema accepts a numeric expiresAt", () => {
  const issue = SPEND_GRANT_ROUTES.find(r => r.id === "issue-spend-grant");
  assert.ok(issue, "issue route registered");
  // Regression: the schema declared expiresAt as a string while the issuance
  // code only accepts a numeric unix-ms timestamp, so expiry-bearing grants
  // were unissuable over HTTP (number -> 422 invalid_body at the schema
  // gate; string -> 422 invalid_spend_grant in the code).
  const problems = schemaErrors(issue.schema.body, {
    agentId: "peer1", capCents: "100", perTxCapCents: "10", expiresAt: Date.now() + 60000,
  });
  assert.deepEqual(problems, [], `schema rejects numeric expiresAt: ${JSON.stringify(problems)}`);
});

// --- Charge-then-forward failure at the tools/call boundary ---

function roomWithPeer(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-attack-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureSpendGrantsSchema(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Spend room", purpose: "Paid tools", displayName: "Owner" });
  const roomId = created.roomId;
  const ownerMemberId = created.ownerMemberId ?? owner.identityId;
  const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  assert.ok(peerMemberId);
  setTier(store.db, roomId, peerMemberId, "t2_standard", { updatedBy: ownerMemberId, nowMs: Date.now() });
  const mcp = createHostedRoomMcp(store);
  const rpc = (method, params) => ({ jsonrpc: "2.0", id: "c", method, params });
  const call = (method, params, secret) => mcp(rpc(method, params), { authorization: `Bearer ${secret}` });
  return { store, roomId, ownerMemberId, peerMemberId, peerSecret: peer.secret, call };
}

test("tools/call: a tool that throws after charging voids the reservation and restores headroom", async t => {
  const f = roomWithPeer(t);
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: Date.now(),
  });
  // Blocked media types pass MCP arg validation but throw inside stage(),
  // after the charge was reserved — the deterministic tool-failure shape.
  const response = await f.call("tools/call", {
    name: "room_put_file",
    arguments: {
      roomId: f.roomId, id: `f-${randomUUID()}`, filename: "run.sh",
      mediaType: "application/x-sh", data: Buffer.from("echo hi").toString("base64"),
    },
  }, f.peerSecret);
  assert.equal(response.result?.isError, true, `expected a tool failure, got ${JSON.stringify(response).slice(0, 300)}`);
  assert.equal(response.result.structuredContent?.code, "blocked_media_type");
  const rows = f.store.db.prepare(
    `SELECT status FROM spend_authorizations WHERE room_id = ? AND agent_id = ?`).all(f.roomId, f.peerMemberId);
  assert.equal(rows.length, 1, "the reservation was recorded");
  assert.equal(rows[0].status, "voided", "the failed call voided its reservation, never charged");
  assert.equal(
    spendGrantSummary(f.store.db, f.roomId, f.peerMemberId).remainingCents, "100",
    "headroom fully restored after the void");
});
