// Silent mentions: `@_Name` names a member without waking, pushing, or
// writing a mention row. Zulip's silent-mention form. The loud parser is
// unchanged for ordinary @names.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { HEARTBEAT_STALE_AFTER_MS } from "../server/agent-heartbeats.mjs";
import { resolveMentionTargetsInText } from "../server/mention-lifecycle.mjs";

const members = {
  muse: { displayName: "Muse", active: true },
  grok: { displayName: "Grok", active: true },
  producer: { displayName: "Test producer", active: true },
  test: { displayName: "Test", active: true },
  bar: { displayName: "bar", active: true },
  me: { displayName: "Me", active: true },
};

const loud = text => resolveMentionTargetsInText(members, {}, text, "me");

test("silent, ordinary, and mixed mentions", () => {
  assert.deepEqual(loud("@_Muse hi"), []);
  assert.deepEqual(loud("@Muse hi"), ["muse"]);
  assert.deepEqual(loud("@_Muse and @Grok"), ["grok"]);
});

test("a multi-word @_Name is silent and the longest name still wins", () => {
  assert.deepEqual(loud("@_Test producer"), []);
  assert.deepEqual(loud("@Test producer"), ["producer"]);
  assert.deepEqual(loud("@_Test producer and @Grok"), ["grok"]);
});

test("an @ glued to a word is still ignored, including foo@_bar", () => {
  assert.deepEqual(loud("foo@_bar"), []);
  assert.deepEqual(loud("mail@Muse"), []);
  assert.deepEqual(loud("mail@_Muse"), []);
});

test("posting @_Agent to an offline agent with push writes no wake, push, or mention row", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  let at = Date.now();
  f.store.now = () => at;
  const identity = f.store.identities.create("silent-agent");
  f.store.identities.link(f.keys.owner, "commons", {
    identityId: identity.identityId, memberId: "agent",
    displayName: "Agent", permissions: [],
  });
  const beat = f.store.agentHeartbeats.heartbeat({
    agentId: identity.identityId, hostId: "host-1", mode: "wakeable",
    wakeUrl: "https://host.example.test/wake",
    pushNotification: { url: "https://push.example.test/hook", token: "opaque-push-token-123" },
  });
  assert.equal(beat.pushConfigured, true);
  at += HEARTBEAT_STALE_AFTER_MS + 1000;
  assert.equal(f.store.agentHeartbeats.statusOf(identity.identityId).status, "offline");

  const calls = { pushNotify: 0, wakeIfOffline: 0 };
  const wakeIfOffline = f.store.agentHeartbeats.wakeIfOffline.bind(f.store.agentHeartbeats);
  f.store.agentHeartbeats.wakeIfOffline = args => { calls.wakeIfOffline += 1; return wakeIfOffline(args); };
  f.store.agentHeartbeats.pushNotify = () => { calls.pushNotify += 1; };
  f.store.agentPlugin.deliverWakePing = () => ({ deliveries: [] });

  const posted = f.store.command(f.keys.owner, "commons", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "silent-1", body: "@_Agent thanks for the summary" },
  });
  assert.equal(calls.pushNotify, 0);
  assert.equal(calls.wakeIfOffline, 0);
  assert.equal(f.store.mentionView("commons", posted.event.id, "agent"), null);
  assert.equal(f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM mention_states WHERE room_id=? AND mentioned_member_id=?"
  ).get("commons", "agent").n, 0);

  f.store.command(f.keys.owner, "commons", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "loud-1", body: "@Agent please look" },
  });
  assert.equal(calls.pushNotify, 1);
  assert.equal(calls.wakeIfOffline, 1);
  assert.equal(f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM mention_states WHERE room_id=? AND mentioned_member_id=?"
  ).get("commons", "agent").n, 1);
});
