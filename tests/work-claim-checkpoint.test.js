// FIX-21 (WAVE-300, rank 54, PHOENIX): ≤4KB claim checkpoint on every
// transition, with the resume-in-<5min contract.
//
// Three tiers:
//   1. Claim field (authoritative): the pure state machine stamps a ≤4KB
//      checkpoint onto the claim item at every transition (this file).
//   2. Room event: the work_claim.updated event carries the checkpoint
//      (pinned via workClaimEventData below).
//   3. Branch + last_good sha: a documented push-before-checkpoint
//      convention; lastGood is a recorded field, not git automation.
// Resume contract: a successor reads item.checkpoint (or the event copy)
// and resumes. The tests below are the contract's executable form — a
// successor needs state, owner, files, fileBlocks, a last-progress pointer
// into history, and the timestamps, all present and ≤4KB.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWork, claimWork, updateWork, releaseWork, closeWork, reassignWork, renewWork,
  claimHistoryLength, ClaimError } from "../server/work-claims.mjs";
import { CHECKPOINT_MAX_BYTES, CHECKPOINT_VERSION, buildCheckpoint, checkpointOf,
  writeCheckpointFile } from "../server/claim-checkpoint.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";
import { workClaimEventData } from "../server/work-claim-events.mjs";

const T0 = Date.parse("2026-10-09T20:00:00.000Z");
const bytesOf = value => Buffer.byteLength(JSON.stringify(value));
const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ClaimError && error.code === code);

const created = () => createWork({ id: "cp1", title: "checkpoint probe" }, { now: T0, agentId: "system" });
const claimed = (note) => claimWork(created(), "quill",
  { files: ["server/a.mjs"], ...(note === undefined ? {} : { note }), now: T0 + 1 });

test("FIX-21: claim transition writes a ≤4KB checkpoint with the resume fields", () => {
  const item = claimed("taking this");
  const cp = item.checkpoint;
  assert.ok(cp, "a checkpoint was stamped onto the claim field at the claim transition");
  assert.equal(cp.version, CHECKPOINT_VERSION);
  assert.equal(cp.claimId, "cp1");
  assert.equal(cp.state, "claimed");
  assert.equal(cp.owner, "quill");
  assert.deepEqual(cp.files, ["server/a.mjs"]);
  assert.deepEqual(cp.fileBlocks, {});
  // last-progress pointer: names the transition's own history stamp
  assert.equal(cp.lastProgress.action, "claimed");
  assert.equal(cp.lastProgress.agentId, "quill");
  assert.equal(cp.lastProgress.historyIndex, item.history.length - 1);
  // timestamps: checkpoint write, round start, lease window, item update
  assert.equal(cp.at, new Date(T0 + 1).toISOString());
  assert.equal(cp.claimedAt, item.claimedAt);
  assert.equal(cp.leaseExpiresAt, item.leaseExpiresAt);
  assert.equal(cp.updatedAt, item.updatedAt);
  assert.equal(cp.lastGood, null, "no branch push recorded yet");
  assert.ok(bytesOf(cp) <= CHECKPOINT_MAX_BYTES, `checkpoint is ${bytesOf(cp)}B, cap is ${CHECKPOINT_MAX_BYTES}B`);
  assert.ok(Object.isFrozen(cp), "checkpoint is frozen like the rest of the item");
});

test("FIX-21: every state transition refreshes the checkpoint", () => {
  const start = updateWork(claimed(), "quill", { state: "in_progress", now: T0 + 2 });
  assert.equal(start.checkpoint.state, "in_progress");
  assert.equal(start.checkpoint.lastProgress.action, "state:in_progress");
  assert.equal(start.checkpoint.at, new Date(T0 + 2).toISOString());
  const blocked = updateWork(start, "quill", { state: "blocked", now: T0 + 3 });
  assert.equal(blocked.checkpoint.state, "blocked");
  const done = updateWork(start, "quill", { state: "done", deliveryMode: "result", now: T0 + 4 });
  assert.equal(done.checkpoint.state, "done");
  assert.ok(bytesOf(done.checkpoint) <= CHECKPOINT_MAX_BYTES);
  const released = releaseWork(claimed(), "quill", {
    expectedClaimedAt: claimed().claimedAt,
    expectedHistoryLength: claimHistoryLength(claimed()), now: T0 + 5 });
  assert.equal(released.checkpoint.state, "unclaimed");
  assert.equal(released.checkpoint.owner, null);
  const closed = closeWork(claimed(), "quill", { reason: "no longer needed", now: T0 + 6 });
  assert.equal(closed.checkpoint.state, "closed");
});

test("FIX-21: reassign and renew refresh the checkpoint with the new round facts", () => {
  const item = claimed();
  const handed = reassignWork(item, "quill", "grokbot", { note: "your turn", now: T0 + 7 });
  assert.equal(handed.checkpoint.owner, "grokbot");
  assert.equal(handed.checkpoint.lastProgress.action, "reassigned:grokbot");
  const renewed = renewWork(item, "quill", { note: "still on it", now: T0 + 8 });
  assert.equal(renewed.checkpoint.leaseExpiresAt, renewed.leaseExpiresAt);
  assert.equal(renewed.checkpoint.lastProgress.action, "renewed");
});

test("FIX-21: note-only updates do not rewrite the checkpoint", () => {
  const item = claimed();
  const noted = updateWork(item, "quill", { note: "a progress note", now: T0 + 9 });
  assert.deepEqual(noted.checkpoint, item.checkpoint, "note-only writes keep the transition checkpoint");
  assert.equal(noted.checkpoint.at, item.checkpoint.at, "the checkpoint timestamp was not refreshed");
});

test("FIX-21: 4KB cap truncates the summary, never the structural fields", () => {
  const big = "n".repeat(4000); // the largest note the routes accept
  const item = claimed(big);
  const cp = item.checkpoint;
  const size = bytesOf(cp);
  assert.ok(size <= CHECKPOINT_MAX_BYTES, `checkpoint is ${size}B, must fit ${CHECKPOINT_MAX_BYTES}B`);
  assert.equal(cp.summaryTruncated, true, "the summary was the thing that gave");
  // structural resume fields are untouched by the truncation
  assert.equal(cp.state, "claimed");
  assert.equal(cp.owner, "quill");
  assert.equal(cp.claimedAt, item.claimedAt);
  assert.deepEqual(cp.files, item.files);
  assert.ok(cp.lastProgress);
});

test("FIX-21: pathological file lists still fit — the file list truncates last, marked", () => {
  const item = claimed();
  const paths = Array.from({ length: 64 }, (_, i) => `server/deeply/nested/module-${i}/` + "x".repeat(480));
  const stretched = claimWork(created(), "quill", { files: paths, now: T0 + 10 });
  const cp = buildCheckpoint({ ...stretched, files: paths, fileBlocks: {} }, { atMs: T0 + 10 });
  assert.ok(bytesOf(cp) <= CHECKPOINT_MAX_BYTES, `checkpoint is ${bytesOf(cp)}B, must fit ${CHECKPOINT_MAX_BYTES}B`);
  assert.equal(cp.filesTruncated, true);
  assert.equal(cp.fileCount, 64, "the reader still knows how many files the claim held");
  assert.equal(cp.state, "claimed", "identity fields survive even the last-resort truncation");
  assert.equal(cp.owner, "quill");
});

test("FIX-21: last_good records the worker's pushed branch sha (push-before-checkpoint)", () => {
  const sha = "9f8e7d6c5b4a3928170615243a2b1c0d9e8f7a6b";
  const started = updateWork(claimed(), "quill", {
    state: "in_progress", lastGood: { branch: "wave300/fix21-claim-checkpoint", sha }, now: T0 + 11 });
  assert.deepEqual(started.checkpoint.lastGood, { branch: "wave300/fix21-claim-checkpoint", sha });
  // a later transition without a new push keeps the recorded last_good
  const blocked = updateWork(started, "quill", { state: "blocked", now: T0 + 12 });
  assert.deepEqual(blocked.checkpoint.lastGood, { branch: "wave300/fix21-claim-checkpoint", sha });
  // malformed last_good is refused, never half-recorded
  throwsCode(() => updateWork(claimed(), "quill",
    { state: "in_progress", lastGood: { branch: "b", sha: "not-a-sha" }, now: T0 + 13 }), "invalid_claim_input");
});

test("FIX-21: checkpoint survives the workOf round-trip and the durable registry", t => {
  const item = claimed();
  // the persisted-row envelope drops unknown fields — checkpoint must be a known field
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fix21-checkpoint-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, "room.sqlite"));
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db);
  registry.set("room1", item);
  const reloaded = registry.get("room1", "cp1");
  assert.ok(reloaded.checkpoint, "the checkpoint survived the durable write/read");
  assert.deepEqual(reloaded.checkpoint, item.checkpoint);
  assert.ok(bytesOf(reloaded.checkpoint) <= CHECKPOINT_MAX_BYTES);
  db.close();
});

test("FIX-21: the room event carries the checkpoint (tier 2)", () => {
  const started = updateWork(claimed(), "quill", { state: "in_progress", now: T0 + 2 });
  const data = workClaimEventData(started, "state_changed");
  assert.deepEqual(data.checkpoint, started.checkpoint, "the event carries the authoritative checkpoint");
  const claimedData = workClaimEventData(claimed(), "claimed");
  assert.ok(claimedData.checkpoint, "the claim event carries the checkpoint too");
  // note-only / non-transition actions carry no checkpoint of their own
  const noted = updateWork(claimed(), "quill", { note: "x", now: T0 + 9 });
  const notedData = workClaimEventData(noted, "state_changed");
  assert.equal(notedData.checkpoint, noted.checkpoint, "the last transition checkpoint rides along, unchanged");
});

test("FIX-21: file-backed checkpoint writes are temp+fsync+rename (never partial)", t => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fix21-checkpoint-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "checkpoint.json");
  const cp = buildCheckpoint(claimed(), { atMs: T0 + 1 });
  writeCheckpointFile(path, cp);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), cp, "the full checkpoint landed");
  const leftovers = readdirSync(dir).filter(name => name !== "checkpoint.json");
  assert.deepEqual(leftovers, [], "no temp file left behind");
});

test("FIX-21: checkpointOf normalizes stored values and refuses garbage", () => {
  assert.equal(checkpointOf(null), null);
  assert.equal(checkpointOf(undefined), null);
  const cp = buildCheckpoint(claimed(), { atMs: T0 + 1 });
  const roundTripped = checkpointOf(JSON.parse(JSON.stringify(cp)));
  assert.deepEqual(roundTripped, cp);
  assert.throws(() => checkpointOf("garbage"), /checkpoint/);
  assert.throws(() => checkpointOf({ version: 999, state: "claimed" }), /checkpoint/);
});
