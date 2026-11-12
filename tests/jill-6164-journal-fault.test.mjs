// Regression for the #6164 residual (Dot/Jill repro, seq 5427): a wake send that failed before its durable journal write must not leave the coalescer believing it was sent, or the retry coalesces and the mention ends timed_out with zero journal rows.
// Zero-drop tier 1b: the scheduled sweep. The re-wake (#6147) used to run only
// when someone read the room; the jobs registry now calls
// store.sweepExpiredMentions() on its existing cadence, so a mention nobody
// acknowledged is re-woken even in a room nobody reads. Real wake fabric, no stubs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { createTestClock } from "./helpers/test-clock.mjs";

function setup(t) {
  const f = createAcceptanceFixture(), clock = createTestClock(f.store.now());
  f.store.now = clock.now;
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const session = f.store.createSession(f.keys.owner), token = randomBytes(32).toString("base64url");
  f.store.agentConnections.apply(session.token, "commons", { action: "create", requestId: "zd-enroll", memberId: "zd-agent", displayName: "Scout", access: "chat",
    keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
  setTier(f.store.db, "commons", "zd-agent", "t2_standard", { updatedBy: "owner", nowMs: f.store.now() });
  const identity = f.store.identities.create("Scout");
  f.store.db.prepare("INSERT INTO identity_links (room_id,identity_id,member_id,linked_at) VALUES('commons',?,?,?)")
    .run(identity.identityId, "zd-agent", clock.now());
  // A registered host: the only precondition for a durable wake signal.
  f.store.agentHeartbeats.heartbeat({ agentId: identity.identityId, hostId: "scout-host", mode: "wakeable", wakeUrl: "https://scout.example.test/wake" });
  return { f, token, clock, identityId: identity.identityId };
}
const say = (f, key, data) => f.store.command(key, "commons", { id: randomUUID(), type: "message.posted", data });
const eventIdOf = (f, messageId) => f.store.db.prepare("SELECT id FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')=?").get(messageId).id;
const setDeadline = (f, messageId, at) => f.store.db.prepare("UPDATE mention_states SET timeout_at=? WHERE room_id='commons' AND message_event_id=?").run(at, eventIdOf(f, messageId));
const _mentionWakes = (f, identityId) => f.store.agentHeartbeats.pendingWakes(identityId).filter(row => row.kind === "mention");




import {createWakeAdapters} from '../server/wake-adapters.mjs';
import {installFakeWebhookDns} from './helpers/fake-webhook-dns.mjs';
test('post-enqueue pre-journal failure cannot terminalize after coalesced retry',t=>{
 const {f,clock,identityId}=setup(t);
 say(f,f.keys.owner,{messageId:'lost-journal',body:'@Scout please'});
 setDeadline(f,'lost-journal',clock.now()+1000);clock.advance(1001);
 const plugin=f.store.agentPlugin;
 plugin.kickDispatch=()=>{}; // local DB journal only; no outbound network
 installFakeWebhookDns(f.store);
 plugin.subscribeWebhook({identityId,url:'https://agent.example.test/wake',events:['agent.wake']});
 plugin.setWakeAdapters(createWakeAdapters({env:{ROOM_WAKE_ADAPTERS:'1'},clock:clock.now}));
 const mutate=plugin.mutate.bind(plugin);
 plugin.mutate=()=>{throw Error('injected pre-journal')};
 f.store.sweepExpiredMentions();
 const state=()=>f.store.db.prepare("SELECT state FROM mention_states WHERE message_event_id=?").get(eventIdOf(f,'lost-journal')).state;
 assert.equal(state(),'delivered');
 const signal=f.store.db.prepare("SELECT signal_id FROM agent_wake_signals WHERE message_id=?").get('rewake:'+eventIdOf(f,'lost-journal'));
 assert.ok(signal,'durable signal exists before journal failure');
 clock.advance(299000);
 assert.throws(()=>plugin.deliverWakePing({identityId,signal:{signalId:'second-failed-signal',roomId:'commons',kind:'mention'}}),/injected/);
 plugin.mutate=mutate;clock.advance(1001);
 f.store.sweepExpiredMentions();
 const journal=f.store.db.prepare('SELECT count(*) AS n FROM agent_webhook_deliveries WHERE event_id=?').get(signal.signal_id).n;
 assert.ok(state()==='delivered'||journal>0,'must remain retryable or have a durable journal, not timed_out with zero journal');
});

