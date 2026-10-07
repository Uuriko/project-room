// B3 messaging-correctness: redacted-but-live messages must not crash readers.
//
// A message scrubbed by account deletion (server/message-redaction.mjs
// redactRemainingMessageBodies) keeps its slot with body null, redacted true
// and NO deletedAt — the tombstone path (message.deleted / message.redacted
// events) is different. server/pins.mjs explicitly notes such messages stay
// pinnable. Every reader that assumes `message.body` is a string throws on
// them: room search (#1796), the reply bar, pins, decision/report dialogs,
// the work-loop signals. This file pins the shared null-safe reader and
// scans the client for the unsafe pattern.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bodyText } from "../src/conversation.js";
import { coordinationLoops } from "../src/work-loops.js";
import { EVENT_TYPES as T, applyEvent, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("bodyText: a missing or non-string body reads as empty text", () => {
  assert.equal(bodyText(null), "");
  assert.equal(bodyText(undefined), "");
  assert.equal(bodyText({}), "");
  assert.equal(bodyText({ body: null }), "");
  assert.equal(bodyText({ body: 42 }), "");
  assert.equal(bodyText({ body: "hello" }), "hello");
  assert.equal(bodyText({ body: "" }), "");
});

test("bodyText: slicing a redacted-but-live body never throws", () => {
  const scrubbed = { id: "m1", authorId: "a", body: null, redacted: true, createdAt: "2026-10-07T00:00:00.000Z" };
  assert.equal(bodyText(scrubbed).slice(0, 100), "");
  assert.equal(bodyText({ ...scrubbed, body: "abc" }).slice(0, 100), "abc");
});

// The real trigger: post a proposal, scrub the log the way account deletion
// does (body null, redacted true, no deletedAt), rebuild the projection, and
// run the read-time work-loop signals over it. Before the fix this threw
// TypeError: Cannot read properties of null (reading 'trim').
test("work-loop signals survive a scrubbed (bodyless, live) proposal message", () => {
  const at = "2026-10-07T00:00:00.000Z";
  const fixed = (id, type, actorId, data) => ({ id, idempotencyKey: `key-${id}`, roomId: "room-project-room-v0", type, actorId, at, causationId: null, data });
  let state = replay(seedEvents);
  state = applyEvent(state, fixed("add-a", T.MEMBER_ADDED, "potter",
    { memberId: "a", displayName: "A", kind: "human", permissions: ["steer"] }));
  state = applyEvent(state, fixed("work-1", T.WORK_PROPOSED, "a",
    { workItemId: "w1", title: "t", definitionOfDone: "d", accountableMemberId: "a" }));
  state = applyEvent(state, fixed("post-1", T.MESSAGE_POSTED, "a",
    { messageId: "m1", body: "proposal text here", workItemId: "w1" }));
  // Account-deletion scrub: the posted event's body is nulled in the log with
  // redacted true, but no delete/redact event follows, so the rebuilt
  // projection message has body null and no deletedAt.
  const scrubbed = structuredClone(state.messages.find(m => m.id === "m1"));
  scrubbed.body = null;
  scrubbed.redacted = true;
  delete scrubbed.deletedAt;
  const messages = state.messages.map(m => m.id === "m1" ? scrubbed : m);
  const item = state.workItems.w1;
  const signals = coordinationLoops(item, messages);
  assert.ok(Array.isArray(signals), "signals compute without throwing");
});

// Scan gate: no direct string-method access on a message body in the client
// read paths. Draft bodies (draft.body / d.body) are excluded — they are
// always strings by construction.
test("client read paths never assume message.body is a string", () => {
  const receiver = String.raw`\b(target|m|message|msg)\.body\.(slice|trim|length|toLocaleLowerCase|includes|split|match|replace)\b`;
  const problems = [];
  for (const file of ["src/app.js", "src/work-loops.js", "src/portable-work.js"]) {
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const hit of source.matchAll(new RegExp(receiver, "g"))) {
      const line = source.slice(0, hit.index).split("\n").length;
      problems.push(`${file}:${line}: ${hit[0]}`);
    }
  }
  assert.deepEqual(problems, [], `unsafe message.body reads:\n${problems.join("\n")}`);
});
