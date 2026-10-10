// FIX-68 phase 1: claim channels — optional namespace tag on claims plus
// per-channel open counts for the board read. Additive only: existing claims
// keep working and decode with channel: null.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWork, claimWork, ClaimError,
  channelOf, openClaimChannelCounts, isTerminalClaimState,
} from "../server/work-claims.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);

test("channelOf accepts the tag shape and normalizes empty to null", () => {
  assert.equal(channelOf(undefined), null);
  assert.equal(channelOf(null), null);
  assert.equal(channelOf(""), null);
  assert.equal(channelOf("wave300"), "wave300");
  assert.equal(channelOf("lobby_a-1"), "lobby_a-1");
  throwsCode(() => channelOf("has space"), "invalid_claim_input");
  throwsCode(() => channelOf("way-too-long-channel-name-over-32-chars"), "invalid_claim_input");
  throwsCode(() => channelOf(42), "invalid_claim_input");
});

test("createWork stores a valid channel; invalid channel is refused", () => {
  const item = createWork({ id: "ch-1", channel: "wave300" }, { now: 1000 });
  assert.equal(item.channel, "wave300");
  throwsCode(() => createWork({ id: "ch-2", channel: "bad name" }, { now: 1000 }), "invalid_claim_input");
});

test("createWork without channel behaves exactly as before", () => {
  const item = createWork({ id: "ch-3" }, { now: 1000 });
  assert.equal(item.channel, null);
});

test("legacy rows (no channel field) normalize to channel null on read", () => {
  // claimWork runs the row through the normalizer first.
  const normalized = claimWork({ id: "legacy-1", state: "unclaimed" }, "quill", { now: 1000 });
  assert.equal(normalized.channel, null);
  const kept = claimWork({ id: "legacy-2", state: "unclaimed", channel: "lobby" }, "quill", { now: 1000 });
  assert.equal(kept.channel, "lobby");
});

test("channel survives claimWork transitions (immutable after create)", () => {
  const claimed = claimWork(createWork({ id: "ch-4", channel: "wave300" }, { now: 1000 }), "quill", { now: 1001 });
  assert.equal(claimed.channel, "wave300");
  assert.ok(isTerminalClaimState("done") && isTerminalClaimState("closed"));
});

test("openClaimChannelCounts counts only open claims, buckets channel-less under \"\"", () => {
  const a = createWork({ id: "cc-a", channel: "wave300" }, { now: 1 });
  const b = createWork({ id: "cc-b", channel: "wave300" }, { now: 1 });
  const c = createWork({ id: "cc-c" }, { now: 1 });
  const done = { ...a, state: "done" };
  const counts = openClaimChannelCounts([a, b, c, done]);
  assert.deepEqual(counts, { wave300: 2, "": 1 });
  assert.ok(Object.isFrozen(counts));
  assert.deepEqual(openClaimChannelCounts([]), {});
});

test("channel survives a SQLite round trip; old rows decode to null", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createDurableWorkClaimRegistry, workClaimSchema } =
    await import("../server/work-claim-sqlite.mjs");
  const dir = mkdtempSync(join(tmpdir(), "ch-"));
  try {
    const db = new DatabaseSync(join(dir, "claims.db"));
    db.exec(workClaimSchema);
    const reg = createDurableWorkClaimRegistry(db, { now: () => 1000 });
    reg.set("room1", createWork({ id: "rt-1", channel: "wave300" }, { now: 1000 }));
    reg.set("room1", createWork({ id: "rt-2" }, { now: 1000 }));
    const got = new Map(reg.list("room1").map(item => [item.id, item.channel]));
    assert.equal(got.get("rt-1"), "wave300");
    assert.equal(got.get("rt-2"), null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
