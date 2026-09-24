// Jev shadow journal: persistence, listing, and schema tests
// (docs/JEV-GATES.md). Journaled decisions are append-only measurement —
// writing them must never block the join or the done transition.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoomStore, ServiceError } from "../server/store.mjs";

const fixtureDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "jev-journal-"));
const openStore = dir => new RoomStore(path.join(dir, "room.sqlite"), { fresh: true });

test("journal persists admission and receipt decisions with their signals", () => {
  const dir = fixtureDir();
  const store = openStore(dir);
  const j = store.jevShadow;
  const a = j.record({
    gate: "admission", roomId: "room-1", identityId: "ai_1", path: "join:invite",
    score: 0.5, decision: "review", escalate: false,
    signals: [{ key: "freshIdentity", weight: 0.3, value: 1, detail: "minted seconds ago" }],
    at: 1_700_000_000_000,
  });
  assert.match(a.id, /^jad-\d+$/);
  const r = j.record({
    gate: "receipt", roomId: "room-1", identityId: "ai_2", subject: "work-9", path: "work-claim:done",
    score: 0.72, decision: "accept", escalate: true,
    signals: [{ key: "evidence", weight: 0.4, value: 1, detail: "PR link" }],
    at: 1_700_000_000_001,
  });
  assert.match(r.id, /^jrd-\d+$/);

  const fetched = j.get(a.id);
  assert.equal(fetched.gate, "admission");
  assert.equal(fetched.decision, "review");
  assert.equal(fetched.escalate, false);
  assert.equal(fetched.roomId, "room-1");
  assert.deepEqual(fetched.signals, [{ key: "freshIdentity", weight: 0.3, value: 1, detail: "minted seconds ago" }]);
  assert.equal(fetched.recordedAt, 1_700_000_000_000);

  const recent = j.list({ roomId: "room-1", limit: 10 });
  assert.equal(recent.length, 2);
  assert.equal(recent[0].id, r.id); // newest first
  assert.equal(j.counts({ roomId: "room-1" }).escalate, 1);
  store.close();
});

test("list filters by gate and escalation flag", () => {
  const dir = fixtureDir();
  const store = openStore(dir);
  const j = store.jevShadow;
  j.record({ gate: "admission", roomId: "room-2", path: "join:invite", score: 0.1, decision: "admit" });
  j.record({ gate: "admission", roomId: "room-2", path: "join:invite", score: 0.9, decision: "reject", escalate: true });
  j.record({ gate: "receipt", roomId: "room-2", path: "work-claim:done", score: 0.7, decision: "accept", escalate: false });
  assert.equal(j.list({ roomId: "room-2", gate: "admission" }).length, 2);
  assert.equal(j.list({ roomId: "room-2", gate: "receipt" }).length, 1);
  assert.equal(j.list({ roomId: "room-2", escalate: true }).length, 1);
  assert.equal(j.list({ roomId: "room-2", gate: "admission", escalate: true })[0].decision, "reject");
  assert.equal(j.list({ roomId: "room-1" }).length, 0);
  store.close();
});

test("recentJoinCount powers the velocity signal from the journal", () => {
  const dir = fixtureDir();
  const store = openStore(dir);
  const j = store.jevShadow;
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  j.record({ gate: "admission", roomId: "room-3", identityId: "ai_v", ipHash: "h1", path: "join:invite", score: 0.2, decision: "admit", at: now - 5 * 60 * 1000 });
  j.record({ gate: "admission", roomId: "room-3", identityId: "ai_v", ipHash: "h2", path: "join:invite", score: 0.2, decision: "admit", at: now - 2 * 60 * 1000 });
  j.record({ gate: "admission", roomId: "room-3", identityId: "ai_v", ipHash: "h3", path: "join:invite", score: 0.2, decision: "admit", at: now - 60 * 60 * 1000 }); // outside the 10-minute window
  assert.equal(j.recentJoinCount({ identityId: "ai_v", windowMs }), 2);
  assert.equal(j.recentJoinCount({ ipHash: "h2", windowMs }), 1);
  assert.equal(j.recentJoinCount({ ipHash: "h9", windowMs }), 0);
  store.close();
});

test("journal rejects malformed records with coded errors", () => {
  const dir = fixtureDir();
  const store = openStore(dir);
  const j = store.jevShadow;
  assert.throws(() => j.record({ gate: "nope", score: 0.5, decision: "admit", path: "join:invite" }),
    err => err instanceof ServiceError && err.code === "invalid_jev_shadow");
  assert.throws(() => j.record({ gate: "admission", score: 2, decision: "admit", path: "join:invite" }), ServiceError);
  assert.throws(() => j.record({ gate: "admission", score: 0.5, decision: "maybe", path: "join:invite" }), ServiceError);
  store.close();
});

test("schema verify passes on a fresh store", () => {
  const dir = fixtureDir();
  const store = openStore(dir);
  assert.ok(store.jevShadow.verifySchema());
  store.close();
});
