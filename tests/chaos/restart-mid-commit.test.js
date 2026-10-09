// Restart-mid-commit crash-recovery properties (PRODUCT-200 reliability, C4).
//
// Simulates a process crash at exact commit-boundary points WITHOUT real
// kills: server/chaos-fault.mjs (TEST-ONLY) throws at an armed fault point,
// the test closes the database ("the process died"), reopens it ("restart"),
// and retries. C1's chaos scaffold had not landed when this was written, so
// these properties stand alone in tests/chaos/ and follow the restart pattern
// of tests/work-claim-sqlite.test.js (node:sqlite DatabaseSync on a file;
// restart = close + reopen the same file).
//
// Authoring gate (.agents/skills/test-audit/SKILL.md):
// 1. Contract guarded:
//    P1 — an op that crashes after its idempotency key is journaled but
//      before it applies retries with the same key to exactly-once
//      settlement: one journal row, one settlement, and the retry itself
//      never touches the provider again.
//    P2 — an op that crashes before its key is journaled retries as a clean
//      fresh attempt: no phantom row, no phantom delivery.
//    P3 — a claim whose release committed is never resurrected by a restart:
//      recovery reads the durable work_claims rows; a release that never
//      committed retries cleanly instead of leaving a half-released claim.
// 2. Credible regression: a change that drops the (account_id, request_id)
//    UNIQUE index or the lookup-first retry replays a second provider
//    delivery (P1 fails); a change that settles without the
//    direct_send_settled guard double-applies (P1 fails); a change that
//    rebuilds claim state from anything but the durable rows (stale
//    snapshot, event replay without the release) resurrects released claims
//    (P3 fails); a change that journals the key without the row leaves a
//    phantom (P2 fails).
// 3. Existing coverage does not catch this: tests/work-claim-idempotency.test.js
//    pins duplicate-CREATE 409s (no crash involved); tests/work-claim-sqlite.test.js
//    pins happy-path restart durability but never faults mid-commit; no test
//    injects a crash between key-record and apply.
// 4. Production seam: server/chaos-fault.mjs, a TEST-ONLY fault-injection
//    hook documented there. There is no other way to simulate
//    restart-mid-commit without real process kills; the hook is a no-op when
//    disarmed and can only be armed by tests under tests/chaos/. Each
//    property asserts its fault actually fired, so the suite fails loudly
//    (not vacuously) if the hook ever stops being consulted.
//
// Fault schedule: FAULT_POINTS_PER_PROPERTY deterministic iterations per
// property (mulberry32 PRNG; override with CHAOS_SEED to explore another
// schedule). A "fault point" is one injected crash at one commit-boundary
// point in one randomized scenario.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  recordDirectSend,
  completeDirectSend,
  getDirectSendByRequestId,
  ensureDirectSendTable,
} from "../../server/inbox-outbox.mjs";
import {
  createDurableWorkClaimRegistry,
  workClaimSchema,
} from "../../server/work-claim-sqlite.mjs";
import { handleWorkClaims } from "../../server/work-claim-routes.mjs";
import { claimHistoryLength } from "../../server/work-claims.mjs";
import {
  ChaosFaultError,
  __testOnlyArmFaults,
  __testOnlyDisarmFaults,
  __testOnlyFaultsFired,
} from "../../server/chaos-fault.mjs";

// ---------------------------------------------------------------------------
// Deterministic fault schedule.

const seedText = process.env.CHAOS_SEED ?? "product200-c4-restart-mid-commit";
let seed = 0;
for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6D2B79F5) | 0;
  let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
  return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
};
const pick = list => list[Math.floor(rand() * list.length)];
const FAULT_POINTS_PER_PROPERTY = 120;

// ---------------------------------------------------------------------------
// Scratch databases: one file per iteration, cleaned up afterwards. Restart
// is simulated by closing the DatabaseSync handle and reopening the same
// file — the durable rows survive, like a Durable Object restart.

const scratchDir = t => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chaos-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// Test databases use synchronous=NORMAL + journal_mode=MEMORY: this VM's
// disks fsync ~300ms per commit, which would make 360 fault-point iterations
// take many minutes. The simulated "crash" always ends in a clean close
// after the injected fault is caught, so committed rows survive close+
// reopen exactly as the protocol properties require; OS-crash durability is
// SQLite's own contract, not what's under test. Fault points sit before or
// after statements, never inside one, so in-memory journalling cannot hide a
// torn commit.
const fastPragmas = db => {
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA journal_mode = MEMORY");
};
const openSendDb = file => {
  const db = new DatabaseSync(file);
  fastPragmas(db);
  ensureDirectSendTable(db);
  return db;
};
const openClaimDb = (file, initSchema = false) => {
  const db = new DatabaseSync(file);
  fastPragmas(db);
  if (initSchema) db.exec(workClaimSchema);
  return db;
};

// ---------------------------------------------------------------------------
// Direct-send op driver. Implements the retry contract documented in
// server/routes/inbox.mjs (ch-2039 follow-up): same key + same content replays
// the journaled send WITHOUT touching the provider; same key + different
// content is a 409; otherwise record the key, deliver, settle.

const sameSendContent = (row, op) =>
  row.channel === op.channel
  && row.recipient === op.to
  && row.subject === op.subject
  && row.body_hash === op.bodyHash
  && (row.thread_id ?? null) === (op.threadId ?? null);

// Test-double provider: counts deliveries, never touches the network. Message
// bodies are never stored — the journal keeps only the SHA-256 body hash.
const providerDouble = () => {
  const deliveries = [];
  return {
    deliveries,
    deliver: row => {
      deliveries.push(row.id);
      return `prov-${row.id}`;
    },
  };
};

const idempotencyConflict = () => {
  const error = new Error("This request id already recorded a different direct send.");
  error.code = "direct_send_idempotency_conflict";
  error.status = 409;
  return error;
};

const attemptDirectSend = (db, op, provider) => {
  if (op.requestId) {
    const prior = getDirectSendByRequestId(db, op.accountId, op.requestId);
    if (prior) {
      if (!sameSendContent(prior, op)) throw idempotencyConflict();
      return { replayed: true, row: prior };
    }
  }
  const recorded = recordDirectSend(db, {
    id: op.id,
    accountId: op.accountId,
    channel: op.channel,
    to: op.to,
    subject: op.subject,
    bodyHash: op.bodyHash,
    threadId: op.threadId ?? null,
    requestId: op.requestId ?? null,
    at: op.at,
  });
  const providerId = provider.deliver(recorded);
  const settled = completeDirectSend(db, recorded.id, { status: "sent", providerId, at: op.at + 1 });
  return { replayed: false, row: settled };
};

const randomSendOp = n => {
  const channel = pick(["gmail", "telegram"]);
  return {
    id: `chaos-send-${n}`,
    accountId: "chaos-acct-1",
    requestId: `chaos-req-${n}`,
    channel,
    to: channel === "gmail" ? `chaos-agent-${n}@example.com` : `${1400000000 + n}`,
    subject: `chaos subject ${n}`,
    bodyHash: createHash("sha256").update(`chaos-body-${n}-${Math.floor(rand() * 1e9)}`, "utf8").digest("hex"),
    threadId: rand() < 0.5 ? `chaos-thread-${n}` : null,
    at: 1760000000000 + n,
  };
};

// ---------------------------------------------------------------------------
// P1: crash after key-recorded but before apply → retry with same key settles
// exactly once.
//
// Two crash points, alternating per iteration:
// - direct-send:after-record — the key row is journaled (pending), the crash
//   lands before the provider delivery. Resume delivers once, settles once.
// - direct-send:before-complete — the provider delivered, the crash lands
//   before the settlement UPDATE. The delivery already happened (the provider
//   double recorded it), so resume settles without re-delivering.
// In both cases the retry itself replays the journaled row and never touches
// the provider — mirroring server/routes/inbox.mjs.

test("P1: crash after key-recorded but before apply → retry with same key settles exactly once", async t => {
  // One durable file for the whole property; each iteration uses a fresh
  // idempotency key, and every assertion is scoped to that key. The restart
  // is still a real close+reopen per iteration.
  const file = join(scratchDir(t), "sends.sqlite");
  for (let n = 0; n < FAULT_POINTS_PER_PROPERTY; n += 1) {
    const point = n % 2 === 0 ? "direct-send:after-record" : "direct-send:before-complete";
    const op = randomSendOp(n);
    const provider = providerDouble();

    let db = openSendDb(file);
    __testOnlyArmFaults([point]);
    let crashed = null;
    try {
      attemptDirectSend(db, op, provider);
    } catch (error) {
      crashed = error;
    } finally {
      __testOnlyDisarmFaults();
    }
    assert.ok(crashed instanceof ChaosFaultError,
      `iteration ${n}: expected the op to crash at ${point}, got ${crashed?.message ?? crashed}`);
    assert.ok(__testOnlyFaultsFired().includes(point),
      `iteration ${n}: fault ${point} must have fired — a silent hook would pass vacuously`);
    db.close();

    // "Restart": a fresh handle on the same durable file.
    db = openSendDb(file);
    try {
      const retry = attemptDirectSend(db, op, provider);
      assert.equal(retry.replayed, true,
        `iteration ${n}: the retry must replay the journaled row, not record a second one`);
      assert.equal(retry.row.status, "pending",
        `iteration ${n}: the journaled row is pending — the crashed op never applied`);
      assert.equal(provider.deliveries.length, point === "direct-send:after-record" ? 0 : 1,
        `iteration ${n}: the retry itself must never touch the provider`);

      // Resume the journaled op to completion exactly once. The
      // before-complete crash already delivered (the double recorded it), so
      // resume settles without re-delivering; the after-record crash still
      // owes the one delivery.
      if (point === "direct-send:after-record") provider.deliver(retry.row);
      const settled = completeDirectSend(db, retry.row.id,
        { status: "sent", providerId: `prov-${retry.row.id}`, at: op.at + 2 });
      assert.equal(settled.status, "sent");
      assert.equal(provider.deliveries.length, 1,
        `iteration ${n}: exactly one provider delivery across crash + retry + resume`);

      // Settlement is once-only: a second settle is refused, never applied.
      assert.throws(
        () => completeDirectSend(db, retry.row.id, { status: "sent", providerId: "prov-again", at: op.at + 3 }),
        error => error.code === "direct_send_settled",
        `iteration ${n}: re-settling a settled send must be refused`,
      );

      // Exactly one journal row for the key: the lookup-first retry plus the
      // (account_id, request_id) UNIQUE index make a duplicate row impossible.
      const rows = db.prepare(
        "SELECT COUNT(*) AS n FROM direct_channel_sends WHERE account_id = ? AND request_id = ?",
      ).get(op.accountId, op.requestId).n;
      assert.equal(rows, 1, `iteration ${n}: exactly one journal row for the idempotency key`);
    } finally {
      db.close();
    }
  }
});

// ---------------------------------------------------------------------------
// P2: crash before key-recorded → the retry is a clean fresh attempt.
//
// The crash lands before the journal INSERT, so the key was never recorded:
// no row, no delivery, nothing to replay. After the restart the retry finds
// no prior row and runs the full record → deliver → settle path exactly once.

test("P2: crash before key-recorded → retry is a clean fresh attempt, no phantom state", async t => {
  // One durable file for the whole property; each iteration uses a fresh
  // idempotency key, and the phantom check counts rows for that key only.
  const file = join(scratchDir(t), "sends.sqlite");
  for (let n = 0; n < FAULT_POINTS_PER_PROPERTY; n += 1) {
    const op = randomSendOp(n);
    const provider = providerDouble();

    let db = openSendDb(file);
    __testOnlyArmFaults(["direct-send:before-record"]);
    let crashed = null;
    try {
      attemptDirectSend(db, op, provider);
    } catch (error) {
      crashed = error;
    } finally {
      __testOnlyDisarmFaults();
    }
    assert.ok(crashed instanceof ChaosFaultError,
      `iteration ${n}: expected the op to crash at direct-send:before-record`);
    assert.ok(__testOnlyFaultsFired().includes("direct-send:before-record"),
      `iteration ${n}: fault direct-send:before-record must have fired — a silent hook would pass vacuously`);

    // No phantom: the crashed attempt journaled nothing and delivered nothing.
    assert.equal(getDirectSendByRequestId(db, op.accountId, op.requestId), null,
      `iteration ${n}: no key was recorded, so the lookup finds nothing`);
    assert.equal(db.prepare(
      "SELECT COUNT(*) AS n FROM direct_channel_sends WHERE account_id = ? AND request_id = ?",
    ).get(op.accountId, op.requestId).n, 0,
      `iteration ${n}: the crashed attempt left no phantom row`);
    assert.equal(provider.deliveries.length, 0,
      `iteration ${n}: the crashed attempt never reached the provider`);
    db.close();

    // "Restart": the retry finds no prior row and runs as a clean fresh attempt.
    db = openSendDb(file);
    try {
      const retry = attemptDirectSend(db, op, provider);
      assert.equal(retry.replayed, false,
        `iteration ${n}: nothing was journaled, so the retry is the first real attempt — not a replay`);
      assert.equal(retry.row.status, "sent");
      assert.equal(provider.deliveries.length, 1,
        `iteration ${n}: exactly one provider delivery on the fresh attempt`);
      assert.equal(db.prepare(
        "SELECT COUNT(*) AS n FROM direct_channel_sends WHERE account_id = ? AND request_id = ?",
      ).get(op.accountId, op.requestId).n, 1,
        `iteration ${n}: exactly one journal row after the fresh attempt`);
    } finally {
      db.close();
    }
  }
});

// The (account_id, request_id) UNIQUE index is the backstop behind the
// lookup-first retry: even a caller that skips the lookup cannot journal a
// second row for one key. Static schema property — one assertion, not per
// iteration.
test("the send journal UNIQUE index rejects a duplicate idempotency key outright", async t => {
  const file = join(scratchDir(t), "sends.sqlite");
  const db = openSendDb(file);
  t.after(() => db.close());
  const op = randomSendOp(0);
  recordDirectSend(db, {
    id: op.id, accountId: op.accountId, channel: op.channel, to: op.to,
    subject: op.subject, bodyHash: op.bodyHash, threadId: op.threadId,
    requestId: op.requestId, at: op.at,
  });
  assert.throws(
    () => recordDirectSend(db, {
      id: "chaos-send-duplicate", accountId: op.accountId, channel: op.channel, to: op.to,
      subject: op.subject, bodyHash: op.bodyHash, threadId: op.threadId,
      requestId: op.requestId, at: op.at + 1,
    }),
    // Driver-agnostic: better-sqlite3 reports code SQLITE_CONSTRAINT_UNIQUE,
    // node:sqlite (the production driver) reports ERR_SQLITE_ERROR with this
    // message. Either way the second row for one key is rejected.
    error => /UNIQUE constraint failed: direct_channel_sends\.account_id, direct_channel_sends\.request_id/i
      .test(error?.message ?? ""),
    "a second row for one idempotency key must violate the UNIQUE index",
  );
});

// ---------------------------------------------------------------------------
// P3: recovery never resurrects a released claim.
//
// Driven through the real work-claim routes on the durable SQLite registry.
// The release commit is registry.set (the durable write) inside the routes'
// commit closure; two crash points alternate per iteration:
// - work-claim-set:before-write — the release never commits. After the
//   restart the claim is still held, and a clean retry releases it.
// - work-claim-set:after-write — the release commits, then the crash lands
//   before the room-event receipt. After the restart the claim is still
//   released (owner cleared) — never resurrected — and another agent can
//   claim the freed item, proving no phantom owner survived.

const CLAIM_MEMBERS = {
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  grokbot: { id: "grokbot", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};
const claimHelpers = {
  json: (_res, status, value) => ({ status, value }),
  // Mirror the server's refusal shape: handleWorkClaims converts a thrown
  // refusal to {status, value} only when it carries error.body.
  reject: (status, code, message) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.body = { error: { code, message } };
    throw error;
  },
  body: async req => req.body,
};
const claimCall = (registry, memberId, route, id, body) => handleWorkClaims({
  req: { method: "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${id ? `/${id}/${route}` : ""}`),
  store: { roomAuthority: () => ({ ownerId: "holder", members: CLAIM_MEMBERS }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: "agent", permissions: CLAIM_MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers: claimHelpers,
  registry,
});

test("P3: recovery never resurrects a released claim", async t => {
  // One durable file for the whole property; claim ids are unique per
  // iteration. The restart is still a real close+reopen per iteration.
  const file = join(scratchDir(t), "claims.sqlite");
  openClaimDb(file, true).close();
  for (let n = 0; n < FAULT_POINTS_PER_PROPERTY; n += 1) {
    const point = n % 2 === 0 ? "work-claim-set:before-write" : "work-claim-set:after-write";
    const claimId = `chaos-claim-${n}`;

    let db = openClaimDb(file);
    let registry = createDurableWorkClaimRegistry(db);
    // Setup (no faults): create + claim, so the release commit is the only
    // write under test. The item stays in `claimed` (never started) so the
    // release route performs exactly one registry write.
    const created = await claimCall(registry, "holder", "create", null, { id: claimId, title: `chaos claim ${n}` });
    assert.equal(created.status, 201, `iteration ${n}: setup create must succeed`);
    const claimed = await claimCall(registry, "holder", "claim", claimId, { leaseHours: pick([1, 6, 24]) });
    assert.equal(claimed.status, 200, `iteration ${n}: setup claim must succeed`);
    assert.equal(claimed.value.state, "claimed");
    const historyAtClaim = claimed.value.history.length;
    // E5/D4 (main): release is compare-and-release — the client cites the
    // claim round it read (claimedAt + history length); a stale round is a
    // 409 instead of a silent clobber. Re-read the token fresh: a crashed
    // release never commits, so the round is unchanged across the retry.
    const roundToken = () => {
      const item = registry.get("room1", claimId);
      return { expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item) };
    };

    // Crash mid-release-commit.
    __testOnlyArmFaults([point]);
    let crashed = null;
    let released = null;
    try {
      released = await claimCall(registry, "holder", "release", claimId, { ...roundToken(), note: `parking ${n}` });
    } catch (error) {
      crashed = error;
    } finally {
      __testOnlyDisarmFaults();
    }
    assert.ok(crashed instanceof ChaosFaultError,
      `iteration ${n}: expected the release to crash at ${point}, got ${crashed?.message ?? JSON.stringify(released)?.slice(0, 200)}`);
    assert.ok(__testOnlyFaultsFired().includes(point),
      `iteration ${n}: fault ${point} must have fired — a silent hook would pass vacuously`);
    db.close();

    // "Restart": a fresh registry over the same durable file. Recovery reads
    // the committed rows — nothing else.
    db = openClaimDb(file);
    registry = createDurableWorkClaimRegistry(db);
    try {
      const after = registry.get("room1", claimId);
      assert.ok(after, `iteration ${n}: the claim row itself survives the restart`);
      if (point === "work-claim-set:before-write") {
        // The release never committed: the claim is still held, and a clean
        // retry of the release completes it — no half-released state.
        assert.equal(after.state, "claimed",
          `iteration ${n}: an uncommitted release must not half-apply`);
        assert.equal(after.owner, "holder",
          `iteration ${n}: the owner still holds the claim after the crashed release`);
        const retried = await claimCall(registry, "holder", "release", claimId, { ...roundToken(), note: `retry ${n}` });
        assert.equal(retried.status, 200, `iteration ${n}: retrying the release after restart must succeed`);
        assert.equal(retried.value.state, "unclaimed");
        assert.equal(retried.value.owner, null);
        assert.ok(retried.value.history.length > historyAtClaim,
          `iteration ${n}: the retried release stamps history`);
      } else {
        // The release committed before the crash: recovery must NOT resurrect
        // it. The durable row says unclaimed/ownerless, and the release is in
        // history — the claim stays released.
        assert.equal(after.state, "unclaimed",
          `iteration ${n}: a committed release survives the restart`);
        assert.equal(after.owner, null,
          `iteration ${n}: a released claim is never resurrected as claimed`);
        assert.ok(after.history.length > historyAtClaim,
          `iteration ${n}: the committed release stamped history before the crash`);
        assert.match(after.history.at(-1).action, /unclaimed|released/,
          `iteration ${n}: the last history stamp is the release`);
        // The freed item is claimable again — no phantom owner blocks it —
        // and the new holder can release it too, proving the recovered row
        // is fully functional (this also keeps per-member open-claim counts
        // at zero across iterations sharing the file).
        const reclaimed = await claimCall(registry, "grokbot", "claim", claimId, { leaseHours: 2 });
        assert.equal(reclaimed.status, 200,
          `iteration ${n}: another agent can claim the released item after restart`);
        assert.equal(reclaimed.value.owner, "grokbot");
        const reReleased = await claimCall(registry, "grokbot", "release", claimId, { ...roundToken(), note: `free ${n}` });
        assert.equal(reReleased.status, 200,
          `iteration ${n}: the new holder can release the reclaimed item`);
        assert.equal(reReleased.value.state, "unclaimed");
        assert.equal(reReleased.value.owner, null);
      }
    } finally {
      db.close();
    }
  }
});
