import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Bridge } from "../room-acp/src/bridge.mjs";
import { createWork } from "../server/work-claims.mjs";
import { privateWorkFixture } from "./helpers/private-work-fixture.mjs";

const roomId = "commons";
const claimId = "idle-ready";
const fakeWake = (member, id = "first-wake") => ({
  signalId: id, roomId, kind: "mention", workClaim: claimId, reason: "idle_nudge",
  messageId: `idle_nudge:${member.id}:${claimId}:42`
});

async function fixture(t, representation = "legacy") {
  const f = await privateWorkFixture(t, representation);
  if (representation === "legacy") {
    const seed = createWork({ id:claimId, title:"Inspect the release notes" }, {agentId:"owner", now:Date.now() - 1800000 });
    f.store.workClaims.set(roomId, seed);
  }
  const root = mkdtempSync(join(tmpdir(), "room-acp-idle-"));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const connect = async (member, {fetchImpl = fetch, persist = false, hostId = member.id, counts = { prompts: 0, acks: [] }} = {}) => {
    const bridge = new Bridge({ connection:{apiBase:f.origin, roomId, memberId:member.id, hostId, credential:member.secret},
      env:{ ROOM_ACP_HOME:join(root, member.id) }, maxSessions:1, fetchImpl, persistSessions:persist,
      host:{ session:async()=>({sessionId:"test"}), prompt:async(_key, prompt)=>{
        assert.match(JSON.stringify(prompt), /You picked up this available Board claim.*Inspect the release notes/);
        counts.prompts++;
        return {recorder:{text:"Reviewed release notes",tools:new Map()},stopReason:"end_turn"};
      } },
    });
    bridge.room.ack = async ({signalIds}) => counts.acks.push(...signalIds);
    assert.equal(await bridge.lease(), true);
    return { bridge, counts };
  };
  const pause = member => f.store.wakeQueue.pause(f.owner, roomId, { requestId:"pause-idle-wake", reason:null }, null, {memberId:member.id});
  return {...f, connect, pause, claim:()=>f.store.workClaims.get(roomId, claimId)};
}

test("one atomic Board winner starts work, a concurrent loser skips, and replay never starts it twice", async t => {
  const f = await fixture(t);
  let arrivals = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  const synchronize = async (url, options) => {
    if (url.endsWith("/claim")) {
      if (++arrivals === 2) release();
      await both;
    }
    return fetch(url, options);
  };
  const a = await f.connect(f.observer, { fetchImpl:synchronize, persist:true });
  const b = await f.connect(f.broad, { fetchImpl:synchronize, persist:true });
  await Promise.all([a.bridge.accept(fakeWake(f.observer)), b.bridge.accept(fakeWake(f.broad))]);
  await Promise.all([a.bridge.queue.idle(), b.bridge.queue.idle()]);
  const [winner, other] = f.claim().owner === f.observer.id ? [f.observer, f.broad] : [f.broad, f.observer];
  const counts = winner === f.observer ? a.counts : b.counts;
  const loserCounts = other === f.observer ? a.counts : b.counts;
  assert.equal(arrivals, 2);
  assert.equal(f.claim().history.filter(x=>x.action === "claimed").length, 1);
  assert.equal(counts.prompts, 1);
  assert.equal(loserCounts.prompts, 0);
  assert.deepEqual(loserCounts.acks, ["first-wake"]);

  const restarted = await f.connect(winner, { persist:true, counts });
  await restarted.bridge.accept(fakeWake(winner));
  await restarted.bridge.queue.idle();
  await restarted.bridge.accept(fakeWake(winner,"distinct-wake"));
  await restarted.bridge.queue.idle();
  assert.equal(counts.prompts, 1);
  assert.equal(f.claim().history.filter(x=>x.action === "claimed").length, 1);
  assert.deepEqual(counts.acks, ["first-wake","first-wake","distinct-wake"]);
});

test("receiver with a lost claim response resumes the same held lease after restart", async t => {
  const f = await fixture(t);
  const loseClaimReply = async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith("/claim")) {
      assert.equal(response.status, 200);
      await response.body.cancel();
      throw new TypeError("response lost");
    }
    return response;
  };
  const initial = await f.connect(f.observer, {fetchImpl:loseClaimReply, persist:true});
  const wake = fakeWake(f.observer);
  await assert.rejects(initial.bridge.accept(wake), {code:"network"});
  const lease = f.claim().leaseExpiresAt;
  assert.equal(initial.counts.prompts, 0);

  const fresh = await f.connect(f.observer, {persist:true, counts:initial.counts});
  await fresh.bridge.accept(wake);
  await fresh.bridge.queue.idle();
  assert.equal(f.claim().leaseExpiresAt, lease);
  assert.equal(f.claim().history.filter(x=>x.action === "claimed").length, 1);
  assert.equal(fresh.counts.prompts, 1);
  assert.deepEqual(fresh.counts.acks, ["first-wake"]);
});

test("pause after the pickup read prevents lease creation and model dispatch", async t => {
  const f = await fixture(t);
  const pauseBeforeClaim = (url, options) => {
    if (url.endsWith("/claim")) f.pause(f.observer);
    return fetch(url, options);
  };
  const {bridge, counts} = await f.connect(f.observer, {fetchImpl:pauseBeforeClaim});
  await bridge.accept(fakeWake(f.observer));
  assert.equal(f.claim().state, "unclaimed");
  assert.equal(counts.prompts, 0);
  assert.deepEqual(counts.acks, []);
  await bridge.accept(fakeWake(f.observer));
  assert.equal(bridge.seen.size, 0);
});

test("normalized room with no Board authority skips the old nudge", async t => {
  const f = await fixture(t, "normalized-current-v1");
  const {bridge, counts} = await f.connect(f.observer, {fetchImpl:(url, options)=>{
    assert.doesNotMatch(url, /work-claims/);
    return fetch(url, options);
  }});
  await bridge.accept(fakeWake(f.observer));
  assert.equal(counts.prompts, 0);
  assert.deepEqual(counts.acks, ["first-wake"]);
});
