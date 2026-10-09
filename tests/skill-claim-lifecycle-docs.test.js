// Doc pins for the claim-lifecycle quickstart in skills/project-room/SKILL.md
// (core loop) and skills/project-room/references/tasks-handoff.md.
// Each test names the doc statement it guards: a behavior change here must
// come with a doc edit, and a doc edit must keep these green.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EVENT_TYPES as T, WORK_STATES, applyEvent, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import {
  SESSION_STATUSES, SESSION_EVENT_TYPES, applySessionFields,
  sessionClaimConflict, sessionCard
} from "../src/work-item-session.js";
import { textVersion } from "../server/text-results.mjs";
import { buildWorkCommand } from "../client/work-actions.mjs";

const ROOM_ID = "room-project-room-v0";
const AT = "2026-10-08T10:00:00.000Z";

// --- Session ladder: the state table in references/tasks-handoff.md ---

function sessionItem(state, { status = "queued", worker = null } = {}) {
  return {
    id: "w-doc", title: "Doc pin", state, status, worker_member_id: worker,
    heartbeat_at: new Date().toISOString(), revision: 0
  };
}

test("doc: Claim (work-sessions set_status: processing) moves the item to accepted", () => {
  const item = sessionItem(WORK_STATES.PROPOSED);
  applySessionFields(item, {
    type: SESSION_EVENT_TYPES.STARTED, actorId: "maya", at: AT, data: {}
  });
  assert.equal(item.state, WORK_STATES.ACCEPTED);
  assert.equal(item.status, SESSION_STATUSES.PROCESSING);
  assert.equal(item.worker_member_id, "maya");
});

test("doc: First active heartbeat (set_status: active) moves the item to working", () => {
  const item = sessionItem(WORK_STATES.ACCEPTED, { status: "processing", worker: "maya" });
  applySessionFields(item, {
    type: SESSION_EVENT_TYPES.STATUS_CHANGED, actorId: "maya", at: AT,
    data: { status: SESSION_STATUSES.ACTIVE }
  });
  assert.equal(item.state, WORK_STATES.WORKING);
});

test("doc: Release or expiry without completion moves the item back to proposed", () => {
  for (const state of [WORK_STATES.ACCEPTED, WORK_STATES.WORKING]) {
    const item = sessionItem(state, { status: "active", worker: "maya" });
    applySessionFields(item, {
      type: SESSION_EVENT_TYPES.STOPPED, actorId: "maya", at: AT, data: { status: "failed" }
    });
    assert.equal(item.state, WORK_STATES.PROPOSED, `from ${state}`);
  }
});

test("doc: A completed item stays completed when the session stops", () => {
  const item = sessionItem(WORK_STATES.COMPLETED, { status: "active", worker: "maya" });
  applySessionFields(item, {
    type: SESSION_EVENT_TYPES.STOPPED, actorId: "maya", at: AT, data: { status: "done" }
  });
  assert.equal(item.state, WORK_STATES.COMPLETED);
});

test("doc: A second live claim is 409 session_claimed and the hint names the holder", () => {
  const item = sessionItem(WORK_STATES.WORKING, { status: "active", worker: "maya" });
  const conflict = sessionClaimConflict(item, "codex", Date.now());
  assert.match(conflict, /^Claim held by maya$/);
  assert.throws(
    () => applySessionFields(item, {
      type: SESSION_EVENT_TYPES.STARTED, actorId: "codex", at: AT, data: {}
    }),
    /Claim held by maya/
  );
});

test("doc: Claiming again while holding it renews the heartbeat instead of conflicting", () => {
  const item = sessionItem(WORK_STATES.WORKING, { status: "active", worker: "maya" });
  applySessionFields(item, {
    type: SESSION_EVENT_TYPES.STARTED, actorId: "maya", at: AT, data: {}
  });
  assert.equal(item.worker_member_id, "maya");
  assert.equal(item.heartbeat_at, AT);
});

test("doc: worker_member_id on the session card is who holds the claim", () => {
  const item = sessionItem(WORK_STATES.WORKING, { status: "active", worker: "maya" });
  const card = sessionCard(item);
  assert.equal(card.worker_member_id, "maya");
  assert.equal(typeof card.revision, "number");
});

// --- Receipt: evidenceVersion is sha256: of the exact stored UTF-8 body ---

test("doc: evidenceVersion is sha256: of the exact stored body, no trimming", () => {
  const body = "  padded result with trailing space \n";
  const expected = "sha256:" + createHash("sha256").update(body, "utf8").digest("hex");
  assert.equal(textVersion(body), expected);
  assert.notEqual(textVersion(body), textVersion(body.trim()));
});

test("doc: evidenceVersion is sha256: of the exact UTF-8 bytes", () => {
  const body = "result with emoji 🪔 and CJK 測試";
  const expected = "sha256:" + createHash("sha256").update(body, "utf8").digest("hex");
  assert.equal(textVersion(body), expected);
});

// --- Room receipt tool: room_submit_text_result adds evidenceKind room_text ---

test("doc: room_submit_text_result builds a work.completed command with evidenceKind room_text", () => {
  const command = buildWorkCommand("room_submit_text_result", {
    requestId: "req-doc-1",
    workItemId: "w-doc",
    expectedRevision: 2,
    summary: "done",
    nextAction: "none",
    evidenceMessageId: "m-1",
    evidenceMessageEventId: "e-1",
    evidenceVersion: "sha256:" + "0".repeat(64),
    previousCompletionEventId: null,
    producerId: null
  });
  assert.equal(command.type, "work.completed");
  assert.equal(command.data.evidenceKind, "room_text");
  assert.equal(command.data.evidenceMessageId, "m-1");
});

// --- Block / resolve / handoff: applyEvent transitions in references/tasks-handoff.md ---

function fixedEvent(id, type, actorId, data) {
  return {
    id, idempotencyKey: `key-${id}`, roomId: ROOM_ID, type, actorId,
    at: AT, causationId: null, data
  };
}

function proposedItem() {
  const state = replay(seedEvents);
  const propose = fixedEvent("w-doc-propose", T.WORK_PROPOSED, "potter", {
    workItemId: "w-doc", title: "Doc pin", definitionOfDone: "done",
    accountableMemberId: "potter", mode: "read", expectedRevision: 0
  });
  const proposed = applyEvent(state, propose);
  return applyEvent(proposed, fixedEvent("w-doc-accept", T.WORK_ACCEPTED, "potter", {
    workItemId: "w-doc", expectedRevision: 0
  }));
}

test("doc: room_block_work parks the item; room_resolve_blocker returns it to accepted", () => {
  const state = proposedItem();
  const blocked = applyEvent(state, fixedEvent("w-doc-block", T.WORK_BLOCKED, "potter", {
    workItemId: "w-doc", expectedRevision: 1, reason: "waiting on review", nextAction: "nudge reviewer"
  }));
  assert.equal(blocked.workItems["w-doc"].state, WORK_STATES.BLOCKED);
  const resolved = applyEvent(blocked, fixedEvent("w-doc-resolve", T.WORK_BLOCKER_RESOLVED, "potter", {
    workItemId: "w-doc", expectedRevision: 2, resolution: "review landed"
  }));
  assert.equal(resolved.workItems["w-doc"].state, WORK_STATES.ACCEPTED);
});

test("doc: work.handoff_recorded requires doneSummary, nextAction and limitReason", () => {
  const state = proposedItem();
  assert.throws(
    () => applyEvent(state, fixedEvent("w-doc-handoff-short", T.WORK_HANDOFF_RECORDED, "potter", {
      workItemId: "w-doc", expectedRevision: 1, doneSummary: "partial", nextAction: "continue"
    })),
    /limitReason/
  );
  const handed = applyEvent(state, fixedEvent("w-doc-handoff", T.WORK_HANDOFF_RECORDED, "potter", {
    workItemId: "w-doc", expectedRevision: 1, doneSummary: "partial", nextAction: "continue", limitReason: "out of turns"
  }));
  assert.equal(handed.workItems["w-doc"].handoff.open, true);
});

test("doc: a handoff does not close or reassign the item", () => {
  const state = proposedItem();
  const handed = applyEvent(state, fixedEvent("w-doc-handoff2", T.WORK_HANDOFF_RECORDED, "potter", {
    workItemId: "w-doc", expectedRevision: 1, doneSummary: "partial", nextAction: "continue", limitReason: "out of turns"
  }));
  assert.equal(handed.workItems["w-doc"].state, WORK_STATES.ACCEPTED);
});

test("doc: work.completed with evidence moves an accepted item to completed", () => {
  const state = proposedItem();
  const body = "the exact result body";
  const withMessage = applyEvent(state, fixedEvent("e-doc", T.MESSAGE_POSTED, "potter", {
    messageId: "m-doc", body, workItemId: "w-doc"
  }));
  const receipt = applyEvent(withMessage, fixedEvent("w-doc-complete", T.WORK_COMPLETED, "potter", {
    workItemId: "w-doc", expectedRevision: 1, summary: "done", nextAction: "none",
    evidenceKind: "room_text", evidenceMessageId: "m-doc", evidenceMessageEventId: "e-doc",
    evidenceVersion: textVersion(body), previousCompletionEventId: null, producerId: null
  }));
  assert.equal(receipt.workItems["w-doc"].state, WORK_STATES.COMPLETED);
  assert.equal(receipt.workItems["w-doc"].receipt.evidenceVersion, textVersion(body));
});
