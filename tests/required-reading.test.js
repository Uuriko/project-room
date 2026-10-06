// Per-lane required reading on enrollment (backlog W012).
//
// Failing-first contract:
//  1. the mapping is grounded: every doc path in every list exists in docs/;
//  2. the claim (enrollment) response presents the required reading list for
//     the claim's kind — and enrollment always succeeds with no ack (never
//     blocks, so no bypass is needed);
//  3. a read-acknowledgment (who confirmed what, when) can be recorded on the
//     claim via the update route, survives the durable registry round-trip,
//     and is refused to non-owners.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  REQUIRED_READING,
  requiredReadingFor,
  stampReadingAck,
  readingAcksOf,
} from "../server/required-reading.mjs";
import { claimWork, createWork } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docPath = rel => join(root, rel);
const T0 = Date.parse("2026-10-06T12:00:00.000Z");

// ---------------------------------------------------------------------------
// 1. The mapping is grounded in docs that actually exist.
// ---------------------------------------------------------------------------

test("every required-reading doc exists in docs/", () => {
  for (const [kind, entries] of Object.entries(REQUIRED_READING)) {
    assert.ok(Array.isArray(entries) && entries.length > 0, `kind ${kind} has entries`);
    for (const entry of entries) {
      assert.equal(typeof entry.path, "string", `kind ${kind} entry path`);
      assert.equal(typeof entry.title, "string", `kind ${kind} entry title`);
      assert.equal(typeof entry.why, "string", `kind ${kind} entry why`);
      assert.ok(existsSync(docPath(entry.path)), `missing doc for kind ${kind}: ${entry.path}`);
    }
  }
});

test("work list covers start-here, the lane protocol and the lander rule", () => {
  const paths = requiredReadingFor("work").map(entry => entry.path);
  assert.ok(paths.includes("docs/AGENT-START-HERE.md"));
  assert.ok(paths.includes("docs/ROOM-PROTOCOL.md"));
  assert.ok(paths.includes("docs/REVIEW-PARALLELISM.md"), "lander rule (APPROVE on the exact head)");
});

test("land list covers the land queue and the lander rule; deploy covers the deploy lane", () => {
  const land = requiredReadingFor("land").map(entry => entry.path);
  assert.ok(land.includes("docs/REVIEW-PARALLELISM.md"));
  assert.ok(land.includes("docs/ROOM-COORDINATION.md"));
  const deploy = requiredReadingFor("deploy").map(entry => entry.path);
  assert.ok(deploy.includes("docs/DEPLOY-LANE.md"));
  assert.ok(deploy.includes("docs/ROOM-DEPLOYMENT.md"));
});

test("requiredReadingFor is frozen and falls back for unknown kinds", () => {
  const list = requiredReadingFor("work");
  assert.ok(Object.isFrozen(list));
  assert.ok(Object.isFrozen(list[0]));
  assert.deepEqual(requiredReadingFor("nope").map(e => e.path), list.map(e => e.path));
  assert.deepEqual(requiredReadingFor(undefined).map(e => e.path), list.map(e => e.path));
});

// ---------------------------------------------------------------------------
// 2. Ack stamping: who confirmed what, when.
// ---------------------------------------------------------------------------

test("stampReadingAck records agent, docs and time; re-ack replaces, other agents add", () => {
  const item = claimWork(createWork({ id: "w1", title: "t" }), "quill", { now: T0 });
  const acked = stampReadingAck(item, "quill", { docs: ["docs/AGENT-START-HERE.md"], now: T0 + 1000 });
  assert.deepEqual(acked.readingAcks.quill.docs, ["docs/AGENT-START-HERE.md"]);
  assert.equal(acked.readingAcks.quill.at, new Date(T0 + 1000).toISOString());
  assert.ok(Object.isFrozen(acked.readingAcks.quill.docs));
  const stamp = acked.history[acked.history.length - 1];
  assert.equal(stamp.action, "reading_ack");
  assert.equal(stamp.agentId, "quill");

  const again = stampReadingAck(acked, "quill", { docs: ["docs/ROOM-PROTOCOL.md"], now: T0 + 2000 });
  assert.deepEqual(again.readingAcks.quill.docs, ["docs/ROOM-PROTOCOL.md"]);
  const other = stampReadingAck(again, "grok", { docs: ["docs/AGENT-START-HERE.md"], now: T0 + 3000 });
  assert.deepEqual(Object.keys(other.readingAcks).sort(), ["grok", "quill"]);
});

test("stampReadingAck rejects bad doc lists", () => {
  const item = claimWork(createWork({ id: "w1", title: "t" }), "quill", { now: T0 });
  for (const docs of [[], "docs/AGENT-START-HERE.md", [""], [42], null]) {
    assert.throws(() => stampReadingAck(item, "quill", { docs, now: T0 }), /doc/i);
  }
  assert.throws(() => stampReadingAck(item, "quill",
    { docs: Array.from({ length: 21 }, (_, i) => `docs/x${i}.md`), now: T0 }), /docs/i);
  assert.throws(() => stampReadingAck(item, "quill", { docs: [`docs/${"x".repeat(300)}.md`], now: T0 }), /doc/i);
});

test("readingAcksOf reads the map back, empty when nothing was acked", () => {
  const item = claimWork(createWork({ id: "w1", title: "t" }), "quill", { now: T0 });
  assert.deepEqual(readingAcksOf(item), {});
  const acked = stampReadingAck(item, "quill", { docs: ["docs/AGENT-START-HERE.md"], now: T0 });
  assert.deepEqual(Object.keys(readingAcksOf(acked)), ["quill"]);
});

// ---------------------------------------------------------------------------
// 3. The HTTP layer: presented at enrollment, ack via update, never blocking.
// ---------------------------------------------------------------------------

const helpers = {
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const call = (registry, member, route, id, body) => handleWorkClaims({
  req: { method: route === "read" ? "GET" : "POST", body }, res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${id ? `/${id}/${route}` : ""}`),
  store: { roomAuthority: () => ({ members: {
    quill: { id: "quill", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
    grok: { id: "grok", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  } }) }, roomId: "room1", auth: { member: { id: member, kind: "agent", permissions: [] } },
  workClaimRoute: route, workClaimId: id, helpers, registry,
});

test("claim response presents the required reading for the claim kind and never blocks", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "quill", "create", null, { id: "w1", title: "t", kind: "deploy", revision: "abc123" });
  const { status, value } = await call(registry, "quill", "claim", "w1", {});
  assert.equal(status, 200);
  assert.equal(value.state, "claimed");
  assert.ok(Array.isArray(value.requiredReading) && value.requiredReading.length > 0);
  assert.ok(value.requiredReading.some(entry => entry.path === "docs/DEPLOY-LANE.md"));
  // No ack was recorded and enrollment still succeeded — skipping is fine.
  assert.deepEqual(readingAcksOf(value), {});
});

test("claim response for a work kind lists the lane protocol reading", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "quill", "create", null, { id: "w2", title: "t" });
  const { value } = await call(registry, "quill", "claim", "w2", {});
  const paths = value.requiredReading.map(entry => entry.path);
  assert.ok(paths.includes("docs/AGENT-START-HERE.md"));
  assert.ok(paths.includes("docs/ROOM-PROTOCOL.md"));
});

test("update with readingAck records who confirmed what, when", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "quill", "create", null, { id: "w3", title: "t" });
  await call(registry, "quill", "claim", "w3", {});
  const { status, value } = await call(registry, "quill", "update", "w3",
    { readingAck: { docs: ["docs/AGENT-START-HERE.md", "docs/ROOM-PROTOCOL.md"] } });
  assert.equal(status, 200);
  assert.deepEqual(value.readingAcks.quill.docs, ["docs/AGENT-START-HERE.md", "docs/ROOM-PROTOCOL.md"]);
  assert.ok(typeof value.readingAcks.quill.at === "string");
  const stamp = value.history[value.history.length - 1];
  assert.equal(stamp.action, "reading_ack");

  const read = await call(registry, "quill", "read", "w3", undefined);
  assert.deepEqual(read.value.readingAcks.quill.docs, ["docs/AGENT-START-HERE.md", "docs/ROOM-PROTOCOL.md"]);
});

test("update readingAck is refused to non-owners and rejects bad doc lists", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "quill", "create", null, { id: "w4", title: "t" });
  await call(registry, "quill", "claim", "w4", {});
  await assert.rejects(
    call(registry, "grok", "update", "w4", { readingAck: { docs: ["docs/AGENT-START-HERE.md"] } }),
    error => error.status === 403);
  await assert.rejects(
    call(registry, "quill", "update", "w4", { readingAck: { docs: [] } }),
    error => error.status === 422 || error.status === 400);
  await assert.rejects(
    call(registry, "quill", "update", "w4", { readingAck: "docs/AGENT-START-HERE.md" }),
    error => error.status === 422 || error.status === 400);
});

// ---------------------------------------------------------------------------
// 4. Acks survive the durable registry round-trip (restart/deploy).
// ---------------------------------------------------------------------------

test("readingAcks survive a durable registry rebuild on the same database", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "rr-"));
  try {
    const db = new DatabaseSync(join(dir, "claims.db"));
    db.exec(workClaimSchema);
    const first = createDurableWorkClaimRegistry(db, {});
    await call(first, "quill", "create", null, { id: "w5", title: "t" });
    await call(first, "quill", "claim", "w5", {});
    await call(first, "quill", "update", "w5", { readingAck: { docs: ["docs/AGENT-START-HERE.md"] } });

    const second = createDurableWorkClaimRegistry(db, {});
    const item = second.get("room1", "w5");
    assert.deepEqual(item.readingAcks.quill.docs, ["docs/AGENT-START-HERE.md"]);
    assert.ok(typeof item.readingAcks.quill.at === "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
