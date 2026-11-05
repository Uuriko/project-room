import test from "node:test";
import assert from "node:assert/strict";
import { closestToolName, intentToolName } from "../server/mcp-arg-errors.mjs";

const NAMES = ["room_list_events", "room_release_claim", "room_reply", "room_request_reply", "room_handoff", "get_room_context", "room_block_work", "room_record_completion", "room_claim", "room_post_message", "room_needs_me", "room_list_work", "room_read_messages"];

test("room_close_work suggests completion, not block", () => {
  assert.equal(closestToolName("room_close_work", NAMES), "room_record_completion");
});
test("intent only returns offered tools", () => {
  assert.equal(intentToolName("room_close_work", ["room_block_work"]), null);
});
test("verb synonyms", () => {
  assert.equal(closestToolName("room_take_task", NAMES), "room_claim");
  assert.equal(closestToolName("room_send_message", NAMES), "room_post_message");
  assert.equal(closestToolName("room_unread", NAMES), "room_needs_me");
});
test("exact and near-miss names keep edit-distance behavior", () => {
  assert.equal(closestToolName("room_read_mesages", NAMES), "room_read_messages");
  assert.equal(closestToolName("room_list_wrk", NAMES), "room_list_work");
  assert.equal(closestToolName("zzzz", NAMES), null);
});
test("harness misses: claim, release, answer, read messages, review, decisions", () => {
  assert.equal(closestToolName("room_claim_task", NAMES), "room_claim");
  assert.equal(closestToolName("room_release_task", NAMES), "room_release_claim");
  assert.equal(closestToolName("room_answer", NAMES), "room_reply");
  assert.equal(closestToolName("room_reply_message", NAMES), "room_reply");
  assert.equal(closestToolName("room_get_messages", NAMES), "room_read_messages");
  assert.equal(closestToolName("room_request_review", NAMES), "room_request_reply");
  assert.equal(closestToolName("room_read_decisions", NAMES), "get_room_context", "decisions live in get_room_context view:handoff (#5866)");
});

test('unrelated objects and read intents do not suggest message or completion writes', () => {
  for (const name of ['room_send_invoice', 'room_write_file', 'room_close_connection', 'room_read_reply', 'room_get_review']) {
    assert.equal(closestToolName(name, NAMES), null, name);
  }
});

test('claim verbs do not infer unrelated database, payment or money operations', () => {
  for (const name of ['room_drop_database', 'room_release_payment', 'room_take_money'])
    assert.equal(closestToolName(name, NAMES), null, name);
});
