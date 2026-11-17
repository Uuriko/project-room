import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event } from "../src/events.js";
import { readCurrentWorkSummaryForViewer } from "../server/current-room-repository.mjs";



// Real legacy storage: private handoff text remains party/role scoped during
// orientation, including when the viewer is only the triage addressee.
const SENTINELS = {
  title: "PRIVATE-TITLE-SENTINEL",
  definitionOfDone: "PRIVATE-DOD-SENTINEL",
  doneSummary: "PRIVATE-DONE-SENTINEL",
  nextAction: "PRIVATE-NEXT-SENTINEL",
  limitReason: "PRIVATE-REASON-SENTINEL",
  evidenceUrl: "https://example.invalid/PRIVATE-EVIDENCE-SENTINEL",
  evidenceVersion: "PRIVATE-EVIDENCE-VERSION-SENTINEL",
  blockerNext: "BLOCKER-NEXT-SENTINEL",
};
const ALL_PRIVATE = Object.values(SENTINELS);

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const events = initialRoom();
  const add = (type, data, actorId = "owner") =>
    events.push(event({ id: "fx-" + events.length, roomId: "commons", actorId, type, data }));
  for (const [memberId, permissions] of [["producer", ["accept_work", "complete_work"]],
      ["successor", ["accept_work", "complete_work"]], ["verifier", []], ["observer", []]])
    add("member.added", { memberId, displayName: memberId, kind: "agent", permissions, accountableHumanId: "owner" });
  store.initialize(events);
  const keys = Object.fromEntries(["owner", "producer", "successor", "verifier", "observer"]
    .map(id => [id, store.issueAccessKey("commons", id)]));
  const send = (key, id, type, data) => store.command(key, "commons", { id, type, data });
  // Private-request work: producer is accountable and the request recipient,
  // verifier holds a work role but is not a request party, successor is the
  // handoff's triage addressee only, observer is unrelated.
  send(keys.owner, "propose-private", "work.proposed", { workItemId: "private-handoff",
    title: SENTINELS.title, definitionOfDone: SENTINELS.definitionOfDone,
    accountableMemberId: "producer", verifierMemberId: "verifier", mode: "read",
    independentVerificationRequired: false, ownerDecisionRequired: false });
  send(keys.owner, "ask-private", "message.posted", { messageId: "ask-private",
    toMemberId: "producer", workItemId: "private-handoff", requestKind: "reply",
    body: "PRIVATE-REQUEST-SENTINEL" });
  send(keys.producer, "accept-private", "work.accepted", { workItemId: "private-handoff", expectedRevision: 0 });
  send(keys.producer, "start-private", "work.started", { workItemId: "private-handoff", expectedRevision: 1 });
  send(keys.producer, "handoff-private", "work.handoff_recorded", { workItemId: "private-handoff", expectedRevision: 2,
    doneSummary: SENTINELS.doneSummary, nextAction: SENTINELS.nextAction, limitReason: SENTINELS.limitReason,
    evidenceUrl: SENTINELS.evidenceUrl, evidenceVersion: SENTINELS.evidenceVersion, toMemberId: "successor" });
  // Public work with its own handoff, no private request attached.
  send(keys.owner, "propose-public", "work.proposed", { workItemId: "public-handoff",
    title: "Public title", definitionOfDone: "Public done", accountableMemberId: "producer", mode: "read",
    independentVerificationRequired: false, ownerDecisionRequired: false });
  send(keys.producer, "accept-public", "work.accepted", { workItemId: "public-handoff", expectedRevision: 0 });
  send(keys.producer, "start-public", "work.started", { workItemId: "public-handoff", expectedRevision: 1 });
  send(keys.producer, "handoff-public", "work.handoff_recorded", { workItemId: "public-handoff", expectedRevision: 2,
    doneSummary: "PUBLIC-DONE-SENTINEL", nextAction: "PUBLIC-NEXT-SENTINEL", limitReason: "PUBLIC-REASON-SENTINEL",
    evidenceUrl: "https://example.invalid/PUBLIC-EVIDENCE-SENTINEL", evidenceVersion: "PUBLIC-EVIDENCE-VERSION-SENTINEL",
    toMemberId: "successor" });
  const summaryFor = viewer => readCurrentWorkSummaryForViewer(store.db, "commons", "private-handoff", viewer);
  const noPrivateLeak = (value, label) => {
    const text = JSON.stringify(value);
    for (const sentinel of ALL_PRIVATE) assert.equal(text.includes(sentinel), false, `${label} leaks ${sentinel}`);
  };
  return { store, keys, send, summaryFor, noPrivateLeak };
}


import {readAgentOrientation} from '../server/agent-orientation.mjs';
test('legacy orientation withholds private handoff from unrelated observer',t=>{
 const f=fixture(t);
 const result=readAgentOrientation(f.store,f.keys.observer,'commons');
 const item=result.state.workItems['private-handoff'];
 assert.equal(item.title,null);
 f.noPrivateLeak(item,'legacy orientation');
});

test('legacy orientation keeps private parties and work-role holders, but not triage-only access',t=>{
 const f=fixture(t);
 const original=structuredClone(f.store.workProjection('commons').state.workItems['private-handoff']);
 for(const viewer of ['observer','successor']) {
  const result=readAgentOrientation(f.store,f.keys[viewer],'commons');
  f.noPrivateLeak(result,viewer);
  assert.equal(result.state.workItems['public-handoff'].handoff.doneSummary,'PUBLIC-DONE-SENTINEL');
 }
 for(const viewer of ['owner','producer','verifier']) {
  const result=readAgentOrientation(f.store,f.keys[viewer],'commons');
  assert.equal(result.state.workItems['private-handoff'].handoff.doneSummary,SENTINELS.doneSummary);
 }
 assert.deepEqual(f.store.workProjection('commons').state.workItems['private-handoff'],original);
});
