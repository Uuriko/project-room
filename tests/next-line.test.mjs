// Computed `next:` line + needs-you custody rule (organism Step 5 /
// APPLICATION §2 (e)). Includes the §2 falsifier executed as a queue test:
// three seeded items — answered with no `next:` line, `next: none` over
// failing rows, self-loop `wait` — must ALL remain in needs-you, each with
// its failing rule named.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NEXT_LINE_VERBS, computeNextLine, validateNextLine, evaluateClearance,
  applyClearanceAttempts, enrichNeedsYouQueue,
} from "../server/next-line.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";
import { attentionReport } from "../server/owner-attention.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { readCurrentNeedsMePage } from "../server/current-needs-me.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

const FAILING_ROWS = [
  { id: "row-1", status: "FAILED", verb: "fix", owner: "ada" },
  { id: "row-2", status: "NOT-RUN", verb: "prove", owner: "ada" },
];
const GREEN_ROWS = [
  { id: "row-1", status: "PASSED", verb: "verify", owner: "ada" },
  { id: "row-2", status: "PASSED", verb: "review", owner: "ada" },
];

test("compute: first blocking row, denominator, named owner, JSON twin renders the human line", () => {
  const { json, line } = computeNextLine(FAILING_ROWS, { holderId: "owner-1" });
  assert.equal(json.verb, "fix");
  assert.equal(json.owner, "ada");
  assert.equal(json.itemId, "row-1");
  assert.equal(json.position, "1 of 2");
  assert.equal(json.blockingCount, 2);
  assert.equal(json.terminal, false);
  assert.ok(NEXT_LINE_VERBS.includes(json.verb));
  assert.equal(line, "next: fix — owner ada — 1 of 2 blocking items [row-1]");
  // The human line is rendered from the twin: re-rendering the twin's fields
  // reproduces it exactly.
  assert.ok(line.startsWith(`next: ${json.verb} — owner ${json.owner} — ${json.position}`));
});

test("compute: NOT-RUN blocks like FAILED; green rows yield the terminal form", () => {
  const notRun = computeNextLine([{ id: "r", status: "NOT-RUN", verb: "prove", owner: "ada" }]);
  assert.equal(notRun.json.terminal, false);
  assert.equal(notRun.json.blockingCount, 1);
  const green = computeNextLine(GREEN_ROWS, { holderId: "owner-1" });
  assert.equal(green.json.terminal, true);
  assert.equal(green.line, "next: none — 0 of 2 blocking items");
  assert.deepEqual(validateNextLine(green.json, { rows: GREEN_ROWS, currentHolderId: "owner-1" }), { valid: true, rule: null });
});

test("validate: missing line, bad verb, missing owner, wrong denominator are each named", () => {
  assert.equal(validateNextLine(null, { rows: FAILING_ROWS }).rule, "missing-next-line");
  assert.equal(validateNextLine({ verb: "poke", owner: "ada", position: "1 of 2", blockingCount: 2 }, { rows: FAILING_ROWS }).rule, "verb-outside-vocabulary");
  assert.equal(validateNextLine({ verb: "fix", owner: null, position: "1 of 2", blockingCount: 2 }, { rows: FAILING_ROWS }).rule, "missing-owner");
  assert.equal(validateNextLine({ verb: "fix", owner: "ada", position: "1 of 9", blockingCount: 9 }, { rows: FAILING_ROWS }).rule, "denominator-mismatch");
});

test("validate: terminal over blocking rows and self-loop / deadline-less waits are invalid", () => {
  const terminal = computeNextLine(GREEN_ROWS).json;
  assert.equal(validateNextLine(terminal, { rows: FAILING_ROWS }).rule, "terminal-over-blocking-rows");
  const selfLoop = { verb: "wait", owner: "holder-1", position: "1 of 2", blockingCount: 2, dueAt: "2026-11-20T00:00:00Z" };
  assert.equal(validateNextLine(selfLoop, { rows: FAILING_ROWS, currentHolderId: "holder-1" }).rule, "self-loop-wait");
  const noDeadline = { verb: "wait", owner: "ada", position: "1 of 2", blockingCount: 2, dueAt: null };
  assert.equal(validateNextLine(noDeadline, { rows: FAILING_ROWS, currentHolderId: "holder-1" }).rule, "missing-deadline");
  const transfer = { verb: "wait", owner: "ada", position: "1 of 2", blockingCount: 2, dueAt: "2026-11-20T00:00:00Z" };
  assert.deepEqual(validateNextLine(transfer, { rows: FAILING_ROWS, currentHolderId: "holder-1" }), { valid: true, rule: null });
});

test("FALSIFIER (APPLICATION §2): the three seeded items all remain in needs-you, rule named for each", () => {
  const holderId = "holder-1";
  const items = [
    { id: "seed-no-next", holderId, rows: FAILING_ROWS },
    { id: "seed-terminal-over-failing", holderId, rows: FAILING_ROWS },
    { id: "seed-self-loop-wait", holderId, rows: FAILING_ROWS },
  ];
  const attempts = {
    // 1. Answered, but the answer carries no `next:` line at all.
    "seed-no-next": { kind: "answer", next: null },
    // 2. Answered with `next: none` while its rows are still failing.
    "seed-terminal-over-failing": { kind: "answer", next: computeNextLine(GREEN_ROWS).json },
    // 3. Answered with a `wait` that hands custody back to the same holder.
    "seed-self-loop-wait": { kind: "answer", next: { verb: "wait", owner: holderId, position: "1 of 2", blockingCount: 2, dueAt: null } },
  };
  const { remaining, cleared } = applyClearanceAttempts(items, attempts);
  assert.equal(cleared.length, 0, "no seeded item may clear the queue");
  assert.deepEqual(remaining.map(item => item.id), ["seed-no-next", "seed-terminal-over-failing", "seed-self-loop-wait"]);
  assert.deepEqual(remaining.map(item => item.clearanceRule), ["missing-next-line", "terminal-over-blocking-rows", "self-loop-wait"]);
});

test("custody: comment never clears; restart, terminal state, and valid transfer do", () => {
  const item = { id: "x", holderId: "holder-1", rows: FAILING_ROWS };
  assert.deepEqual(evaluateClearance(item, { kind: "comment" }), { clears: false, rule: "comment-does-not-clear" });
  assert.deepEqual(evaluateClearance(item, { kind: "work-restarted" }), { clears: true, rule: "work-restarted" });
  assert.deepEqual(evaluateClearance({ ...item, terminal: true }, { kind: "comment" }), { clears: true, rule: "terminal-state" });
  const transfer = computeNextLine([{ id: "row-1", status: "FAILED", verb: "review", owner: "ada" }, FAILING_ROWS[1]], { holderId: "holder-1" }).json;
  assert.deepEqual(evaluateClearance(item, { kind: "next-line", next: transfer }), { clears: true, rule: "custody-transferred" });
  const { remaining, cleared } = applyClearanceAttempts([item], { x: { kind: "next-line", next: transfer } });
  assert.equal(remaining.length, 0);
  assert.equal(cleared.length, 1);
});

test("queue rendering: holder, due date, and 1 of N positions ride every item", () => {
  const queue = enrichNeedsYouQueue(
    [{ id: "a", kind: "verification" }, { id: "b", kind: "claim_lease", dueAt: "2026-11-15T00:00:00Z" }],
    { holderId: "owner-1", verbFor: item => item.kind === "verification" ? "verify" : "review", dueAtFor: item => item.dueAt ?? null },
  );
  assert.equal(queue.items[0].holder, "owner-1");
  assert.equal(queue.items[0].queuePosition, "1 of 2");
  assert.equal(queue.items[1].queuePosition, "2 of 2");
  assert.equal(queue.items[1].dueAt, "2026-11-15T00:00:00Z");
  assert.equal(queue.nextLineJson.position, "1 of 2");
  assert.equal(queue.nextLineJson.owner, "owner-1");
  assert.ok(queue.nextLine.startsWith("next: verify — owner owner-1 — 1 of 2"));
  const empty = enrichNeedsYouQueue([], { holderId: "owner-1" });
  assert.equal(empty.nextLine, "next: none — 0 of 0 blocking items");
});

// --- Live read-path wiring -------------------------------------------------

function attentionSetup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-next-line-"));
  const clock = { now: Date.parse("2026-09-21T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const accessRequests = new AccessRequests(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const send = (actor, type, data, id = randomUUID()) => store.command(keys[actor], "commons", { id, type, data });
  send("owner", T.MEMBER_ADDED, { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work", "write_external"], accountableHumanId: "owner" });
  keys.agent = store.issueAccessKey("commons", "agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, accessRequests, keys, send, clock, signEvidence: makeTestSigner(store) };
}

test("owner-attention read path renders the computed next: line with holder and denominator", t => {
  const f = attentionSetup(t);
  const report = () => attentionReport({ store: f.store, accessRequests: f.accessRequests }, f.keys.owner, "commons", null, f.clock.now);
  const empty = report();
  assert.equal(empty.nextLine, "next: none — 0 of 0 blocking items");
  assert.equal(empty.nextLineJson.terminal, true);
  f.send("owner", T.WORK_PROPOSED, { workItemId: "w1", title: "Work w1", definitionOfDone: "done", accountableMemberId: "agent", mode: "read", independentVerificationRequired: true, verifierMemberId: "owner", ownerDecisionRequired: false });
  const item = () => f.store.room("commons").state.workItems.w1;
  f.send("agent", T.WORK_ACCEPTED, { workItemId: "w1", expectedRevision: item().revision });
  f.send("agent", T.WORK_STARTED, { workItemId: "w1", expectedRevision: item().revision });
  f.send("agent", T.WORK_COMPLETED, { workItemId: "w1", expectedRevision: item().revision, summary: "did it", evidenceUrl: "https://example.com/evidence", evidenceVersion: "v1", nextAction: "none", signedEvidence: f.signEvidence() });
  const queued = report();
  assert.equal(queued.items.length, 1);
  assert.equal(queued.items[0].holder, "owner");
  assert.equal(queued.items[0].queuePosition, "1 of 1");
  assert.equal(queued.nextLineJson.verb, "verify");
  assert.equal(queued.nextLineJson.owner, "owner");
  assert.equal(queued.nextLineJson.position, "1 of 1");
  assert.ok(queued.nextLine.startsWith("next: verify — owner owner — 1 of 1"));
});

test("current needs-me read path renders holder, position, and the computed next: line", t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  let clock = Date.now();
  store.now = () => clock += 2100;
  const rooms = new AgentRooms(store), owner = store.identities.create("Owen"), bob = store.identities.create("Bob");
  rooms.create(owner.secret, { roomId: "attention", title: "Attention", purpose: "Next line", kind: "personal" });
  linkWithProof(store, owner.secret, "attention", bob, { displayName: "Bob", permissions: [] });
  store.command(bob.secret, "attention", { id: "ask-1", type: "message.posted", data: { messageId: "ask-1", body: "@Owen please look", requestKind: "reply", toMemberId: owner.identityId } });
  const page = readCurrentNeedsMePage(store, owner.secret, "attention", {});
  assert.ok(page.items.length >= 1, "the seeded ask reaches the holder's queue");
  for (const [index, item] of page.items.entries()) {
    assert.equal(item.holder, owner.identityId);
    assert.equal(item.queuePosition, `${index + 1} of ${page.items.length}`);
  }
  assert.equal(page.nextLineJson.terminal, false);
  assert.equal(page.nextLineJson.owner, owner.identityId);
  assert.equal(page.nextLineJson.position, `1 of ${page.items.length}`);
  assert.ok(page.nextLine.startsWith(`next: ${page.nextLineJson.verb} — owner ${owner.identityId} — 1 of ${page.items.length}`));
});
