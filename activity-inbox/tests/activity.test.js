import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIER, FEED_KINDS, projectActivity } from "../src/index.js";

const viewer = Object.freeze({ memberId: "maya", displayName: "Maya" });

function event(over = {}) {
  return {
    id: over.id ?? `evt-${Math.random().toString(16).slice(2)}`,
    type: over.type ?? "message.posted",
    roomId: over.roomId ?? "commons",
    actorId: over.actorId ?? "agent",
    at: over.at ?? "2026-09-10T12:00:00.000Z",
    data: over.data ?? {}
  };
}

function kinds(result) {
  return result.rows.map((row) => row.kind);
}

test("ack-needed: reply request to the viewer is a feed row and does not ding at the default tier", () => {
  const source = event({
    id: "req-1",
    data: { requestKind: "reply", toMemberId: "maya", workItemId: "wi-decision", body: "Need a call." }
  });
  const { rows, tier } = projectActivity({ viewer, events: [source] });
  assert.equal(tier, DEFAULT_TIER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "ack_needed");
  assert.equal(rows[0].notify, false);
  assert.equal(rows[0].source_event_id, "req-1");
  assert.deepEqual(rows[0].opens, { eventId: "req-1", workItemId: "wi-decision" });
  assert.equal(Object.hasOwn(rows[0], "score"), false);
});

test("failed-receipt: failed Receipt opens the Receipt and notifies as exception-class", () => {
  const source = event({
    id: "evt-receipt",
    type: "receipt.recorded",
    data: { receiptId: "rcpt-9", workItemId: "wi-job", status: "failed" }
  });
  const { rows } = projectActivity({ viewer, events: [source] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "failed_receipt");
  assert.equal(rows[0].notify, true);
  assert.equal(rows[0].source_receipt_id, "rcpt-9");
  assert.deepEqual(rows[0].opens, { eventId: "evt-receipt", workItemId: "wi-job", receiptId: "rcpt-9" });
});

test("mention: toMemberId or @DisplayName addresses the viewer and notifies", () => {
  const addressed = event({
    id: "mention-to",
    actorId: "alex",
    data: { toMemberId: "maya", body: "Can you look?" }
  });
  const named = event({
    id: "mention-at",
    at: "2026-09-10T13:00:00.000Z",
    data: { body: "@Maya please review" }
  });
  const notYou = event({
    id: "mention-other",
    data: { toMemberId: "alex", body: "@Alex only" }
  });
  const { rows } = projectActivity({ viewer, events: [addressed, named, notYou] });
  assert.deepEqual(kinds({ rows }), ["mention", "mention"]);
  assert.ok(rows.every((row) => row.notify === true));
  assert.ok(rows.every((row) => row.opens.eventId));
  assert.equal(rows.some((row) => row.source_event_id === "mention-other"), false);
});

test("exception: verification FAIL is a feed row and notifies at the default tier", () => {
  const source = event({
    id: "verify-fail",
    type: "verification.recorded",
    data: { result: "fail", workItemId: "wi-check" }
  });
  const { rows } = projectActivity({ viewer, events: [source] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "exception");
  assert.equal(rows[0].notify, true);
  assert.deepEqual(rows[0].opens, { eventId: "verify-fail", workItemId: "wi-check" });
});

test("ignore plain message volume: chatter and reactions mint nothing and never rank", () => {
  const events = [];
  for (let n = 0; n < 40; n++) {
    events.push(event({
      id: `chatter-${n}`,
      at: `2026-09-10T12:${String(n).padStart(2, "0")}:00.000Z`,
      data: { body: `Agent update ${n}` }
    }));
  }
  events.push(event({
    id: "react-1",
    type: "message.reaction_set",
    data: { messageId: "chatter-0", reaction: "like", active: true }
  }));
  const { rows } = projectActivity({ viewer, events });
  assert.equal(rows.length, 0);
  assert.ok(FEED_KINDS.includes("mention"));
  assert.equal(rows.some((row) => Object.hasOwn(row, "score") || Object.hasOwn(row, "weight") || Object.hasOwn(row, "rank")), false);
});
