import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySlackSignature, isSlackTimestampFresh, slackEventKind, mentionUserIds,
  threadContext, ingestSlackEvent, ingestSlackEvents } from "../server/slack-ingest.mjs";
import { ContractError } from "../server/channel-connection.mjs";

const connection = { accountId: "account-fixture", id: "slack-fixture", revision: 1,
  channel: "slack", provider: "slack-app", externalId: "A123456",
  identity: { kind: "bot", id: "B123456", handle: "@roombot", displayName: "Room Bot" },
  capabilities: { read: true, send: true, threads: true, edit: true } };
const message = () => ({ event_id: "Ev0000000001", event_time: 1780000000,
  event: { type: "message", user: "U11111111", text: "Hey <@U22222222>, review this",
    ts: "1780000000.000100", channel: "C22222222" } });
const signed = (secret, timestamp, body) =>
  "v0=" + createHmac("sha256", secret).update("v0:" + timestamp + ":" + body, "utf8").digest("hex");

test("HMAC signing-secret verification is pure: secret in, boolean out", () => {
  const secret = "fixture-signing-secret", timestamp = "1780000000", body = "token=abc&team_id=T1";
  const signature = signed(secret, timestamp, body);
  assert.equal(verifySlackSignature({ signingSecret: secret, timestamp, body, signature }), true);
  assert.equal(verifySlackSignature({ signingSecret: secret, timestamp, body: body + "&x=1", signature }), false, "tampered body fails");
  assert.equal(verifySlackSignature({ signingSecret: "wrong-secret", timestamp, body, signature }), false, "wrong secret fails");
  assert.equal(verifySlackSignature({ signingSecret: secret, timestamp: "1780000001", body, signature }), false, "tampered timestamp fails");
  for (const change of [p => { p.signingSecret = ""; }, p => { p.timestamp = "tomorrow"; }, p => { p.body = null; },
    p => { p.signature = "abc"; }]) {
    const params = { signingSecret: secret, timestamp, body, signature }; change(params);
    assert.throws(() => verifySlackSignature(params), ContractError);
  }
});

test("timestamp freshness guards replays with a 5-minute default", () => {
  assert.equal(isSlackTimestampFresh("1780000000", { now: 1780000000 * 1000 }), true);
  assert.equal(isSlackTimestampFresh("1780000000", { now: 1780000299 * 1000 }), true);
  assert.equal(isSlackTimestampFresh("1780000000", { now: 1780000301 * 1000 }), false);
  assert.equal(isSlackTimestampFresh("1780000000", { now: 1780000060 * 1000, toleranceSeconds: 30 }), false);
  assert.throws(() => isSlackTimestampFresh("tomorrow"), ContractError);
});

test("event kinds classify request bodies; url_verification is a challenge", () => {
  assert.equal(slackEventKind(message()), "message");
  assert.equal(slackEventKind({ event_id: "E", event: { type: "app_mention", user: "U1", text: "hi", ts: "1.0", channel: "C1" } }), "message");
  assert.equal(slackEventKind({ event: { type: "message", subtype: "message_changed", channel: "C1", message: {} } }), "message_update");
  assert.equal(slackEventKind({ event: { type: "message", subtype: "message_deleted", channel: "C1", deleted_ts: "1.0" } }), "message_delete");
  assert.equal(slackEventKind({ event: { type: "reaction_added" } }), "reaction_add");
  assert.equal(slackEventKind({ event: { type: "reaction_removed" } }), "reaction_remove");
  assert.equal(slackEventKind({ type: "url_verification", challenge: "abc" }), "challenge");
  assert.equal(slackEventKind({ event: { type: "message", subtype: "message_replied" } }), null);
  assert.equal(slackEventKind(null), null);
});

test("mentions parse <@U...> tokens; thread context resolves thread_ts", () => {
  assert.deepEqual(mentionUserIds(message()), ["U22222222"]);
  const plain = message(); plain.event.text = "no mentions";
  assert.deepEqual(mentionUserIds(plain), []);
  const reply = message(); reply.event.thread_ts = "1780000000.000099";
  assert.deepEqual(threadContext(reply), { threadTs: "C22222222:1780000000.000099", isReply: true });
  const parent = message(); parent.event.thread_ts = "1780000000.000100";
  assert.deepEqual(threadContext(parent), { threadTs: "C22222222:1780000000.000100", isReply: false });
  assert.equal(threadContext(message()), null);
});

test("single-request ingest: hydrates, retracts, reactions, challenge skips", () => {
  const hydrated = ingestSlackEvent(connection, message());
  assert.equal(hydrated.action, "hydrate"); assert.equal(hydrated.kind, "message");
  assert.equal(hydrated.messageId, "C22222222:1780000000.000100");
  assert.equal(hydrated.envelope.channel, "slack");
  assert.deepEqual(hydrated.mentions, ["U22222222"]);
  const mention = { event_id: "E2", event_time: 1780000000,
    event: { type: "app_mention", user: "U11111111", text: "ping", ts: "1780000000.000200", channel: "C22222222" } };
  assert.equal(ingestSlackEvent(connection, mention).action, "hydrate", "app_mentions hydrate as messages");
  const changed = { event_id: "E3", event_time: 1780000300, event: { type: "message", subtype: "message_changed",
    channel: "C22222222", ts: "1780000300.000200",
    message: { user: "U11111111", text: "edited", ts: "1780000000.000100", edited: { user: "U11111111", ts: "1780000300.000200" } } } };
  const updated = ingestSlackEvent(connection, changed);
  assert.equal(updated.action, "hydrate"); assert.equal(updated.kind, "message_update");
  assert.equal(updated.messageId, "C22222222:1780000000.000100", "edits keep the original message id");
  const deleted = { event_id: "E4", event_time: 1780000600, event: { type: "message", subtype: "message_deleted",
    channel: "C22222222", deleted_ts: "1780000000.000100", ts: "1780000600.000300" } };
  assert.deepEqual(ingestSlackEvent(connection, deleted),
    { action: "retract", kind: "message_delete", messageId: "C22222222:1780000000.000100" });
  const reacted = ingestSlackEvent(connection, { event_id: "E5",
    event: { type: "reaction_added", user: "U22222222", reaction: "thumbsup",
      item: { type: "message", channel: "C22222222", ts: "1780000000.000100" } } });
  assert.deepEqual(reacted, { action: "reaction", kind: "reaction_add", messageId: "C22222222:1780000000.000100",
    emoji: "thumbsup", userId: "U22222222", added: true });
  const challenge = ingestSlackEvent(connection, { type: "url_verification", challenge: "abc123" });
  assert.deepEqual(challenge, { action: "skip", kind: "challenge", reason: "url_verification" });
});

test("batch ingest pages by index with a moving cursor", () => {
  const envelopes = [message(),
    { event_id: "E2", event: { type: "reaction_added", user: "U1", reaction: "eyes", item: { type: "message", channel: "C22222222", ts: "1780000000.000100" } } },
    { event_id: "E3", event_time: 1780000600, event: { type: "message", subtype: "message_deleted",
      channel: "C22222222", deleted_ts: "1780000000.000100", ts: "1780000600.000300" } },
    { type: "url_verification", challenge: "abc" }];
  const first = ingestSlackEvents(connection, envelopes, { limit: 2 });
  assert.equal(first.contractVersion, 1);
  assert.deepEqual(first.changes.map(c => [c.index, c.action]), [[0, "hydrate"], [1, "reaction"]]);
  assert.equal(first.cursor, "2"); assert.equal(first.complete, false);
  const second = ingestSlackEvents(connection, envelopes, { cursor: first.cursor, limit: 2 });
  assert.deepEqual(second.changes.map(c => [c.index, c.action]), [[2, "retract"]], "challenge skips advance the cursor silently");
  assert.equal(second.cursor, "4"); assert.equal(second.complete, true);
  assert.throws(() => ingestSlackEvents(connection, envelopes, { cursor: "nope" }), { code: "invalid_slack_cursor" });
});
