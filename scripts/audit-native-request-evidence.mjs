// Read-only evidence correlation. No host invocation, credentials or networking.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const paths = process.argv.slice(2);
if (paths.length !== 4) throw new Error("Provide Room, Codex clarification, Codex production and Claude review evidence files");
const [room, clarify, produce, review] = paths.map(path => JSON.parse(readFileSync(path, "utf8")));
const hash = value => createHash("sha256").update(value).digest("hex");
const events = host => host.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
const calls = host => events(host).filter(e => e.type === "item.completed" && e.item?.type === "mcp_tool_call").map(e => e.item);
const result = call => call.result.structured_content;
for (const host of [clarify, produce, review]) { assert.equal(host.code, 0); assert.equal(host.timedOut, false); assert.notEqual(host.outputLimited, true); }
assert.equal(clarify.host, "codex"); assert.equal(produce.host, "codex"); assert.equal(review.host, "claude");
assert.equal(clarify.memberId, "producer"); assert.equal(produce.memberId, "producer"); assert.equal(review.memberId, "reviewer");
assert.ok(Date.parse(produce.startedAt) > Date.parse(clarify.finishedAt), "reconnect used a new native process after the first finished");
const first = calls(clarify), second = calls(produce);
const one = (list, name) => { const matches = list.filter(call => call.tool === name); assert.equal(matches.length, 1, name); return matches[0]; };
const correlate = (call, actor) => {
  assert.equal(call.status, "completed"); assert.equal(call.error, null);
  const receipt = result(call), rows = room.events.filter(row => row.event.id === receipt.eventId);
  assert.equal(rows.length, 1); const row = rows[0];
  assert.equal(row.sequence, receipt.sequence); assert.equal(row.event.actorId, actor);
  assert.equal(row.event.idempotencyKey, hash(actor + ":" + call.arguments.requestId));
  return row.event;
};
const question = correlate(one(first, "room_reply"), "producer");
assert.equal(question.data.replyToId, "native-question"); assert.equal(question.data.body, one(first, "room_reply").arguments.body);
const oldNotice = result(one(first, "room_read_attention")).items.find(n => n.subject === "request");
const newNotice = result(one(second, "room_read_attention")).items.find(n => n.subject === "request");
assert.notEqual(oldNotice.id, newNotice.id); assert.equal(newNotice.reason, "changed");
assert.equal(newNotice.request.contextEventId, room.request.contextEventId);
const draft = correlate(one(second, "room_post_draft"), "producer");
const completed = correlate(one(second, "room_submit_text_result"), "producer");
const answered = correlate(one(second, "room_respond_to_request"), "producer");
assert.equal(draft.data.body, one(second, "room_post_draft").arguments.body);
assert.equal(draft.data.body, room.result.result.text.body);
assert.equal(room.work.receipt.evidenceVersion, "sha256:" + hash(Buffer.from(draft.data.body, "utf8")));
assert.equal(room.work.receipt.eventId, completed.id); assert.equal(room.request.terminalEventId, answered.id);
assert.equal(room.request.status, "answered"); assert.equal(room.work.state, "completed");
assert.ok(room.cursors.every(cursor => cursor.sequence === 0)); assert.ok(Object.values(room.audit.checks).every(Boolean));
const reviewed = events(review), final = reviewed.find(e => e.type === "result");
const reviewCalls = reviewed.filter(e => e.type === "assistant").flatMap(e => e.message?.content ?? []).filter(b => b.type === "tool_use");
assert.ok(reviewCalls.some(call => call.name === "mcp__room__room_read_result"));
assert.ok(final.permission_denials.some(denial => denial.tool_name === "mcp__room__room_read_work_discussion"));
assert.equal(reviewCalls.some(call => call.name === "mcp__room__room_record_verification"), false);
assert.equal(room.work.verification, null); assert.equal(room.work.decision, null);
console.log(JSON.stringify({ evidenceConsistent: true, acceptance: "partial", nativeProducerFlow: true,
  nativeIndependentVerification: false, humanDecision: "pending", humanReadMarkers: room.cursors,
  codexCalls: { clarification: first.length, production: second.length }, claudeAttemptedCalls: reviewCalls.length,
  resultBytes: Buffer.byteLength(draft.data.body), evidenceVersion: room.work.receipt.evidenceVersion,
  wordCounts: { whitespaceTokens: draft.data.body.trim().split(/\s+/).length,
    excludingListMarkers: draft.data.body.replace(/^\d+\.\s+/gm, "").trim().split(/\s+/).length },
  codexShutdownWarnings: [clarify, produce].filter(p => p.stderr.includes("failed to initialize MCP client during shutdown")).length,
  blocker: "Initial reviewer tool approval omitted scoped discussion. Corrected rerun was not executed: current model-usage approval required." }, null, 2));
