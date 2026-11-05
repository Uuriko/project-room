import {seedHistoricalNeedsMeRoom} from './helpers/historical-needs-me-room.mjs';
import {isCurrentRoom} from '../server/current-room-repository.mjs';
// RC-2026-09-18-057: work-sessions teaches how to join.
// GET /api/rooms/{roomId}/work-sessions carries next[] — open sessions
// yield a claim-session step with the workItemId filled into the atomic
// claim body; no open sessions yields a start-session step.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

async function ownerRoom(origin, fixture, {legacy=false,starter=false}={}) {
  const owner = fixture.store.identities.create("ws owner");
  const roomId = "ws-room";
  if(legacy){seedHistoricalNeedsMeRoom(fixture.store,owner,{roomId,title:'Work sessions',purpose:'probe'});return{ownerSecret:owner.secret,roomId,ownerMemberId:owner.identityId};}
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "Work sessions", purpose: "probe", kind: "personal", displayName: "Work sessions",starter,
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  return { ownerSecret: owner.secret, roomId, ownerMemberId:owner.identityId,created:await roomRes.json() };
}

test("work-sessions next[] teaches register-work-item when none are open", async t => {
  // RC-2026-09-24-001 (dogfood F-07): the empty state must name the creation
  // path — POST a work claim — not an undefined "session.start command".
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture,{legacy:true});
  const res = await get(origin, `/api/rooms/${roomId}/work-sessions`, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.sessions, []);
  assert.deepEqual(json.next.map(n => n.action), ["register-work-item"]);
  const step = json.next[0];
  assert.equal(step.method, "POST");
  assert.equal(step.path, `/api/rooms/${roomId}/work-claims`);
  assert.ok(step.description.includes("id"), "names the claim id field");
});

test("work-sessions next[] teaches claim-session for an open session", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { ownerSecret, roomId } = await ownerRoom(origin, fixture,{legacy:true});
  const friend = fixture.store.identities.create("ws friend");
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: friend.identityId, displayName: "Friend",
    requestedPermissions: ["accept_work"], note: null, requestId: "ws-req-1",
  }, friend.secret);
  assert.equal(reqRes.status, 201);
  const decideRes = await post(origin, `/api/rooms/${roomId}/access-requests/ws-req-1/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null,
  }, ownerSecret);
  assert.equal(decideRes.status, 200);
  const memberId = (await decideRes.json()).memberId;
  const propRes = await post(origin, `/api/rooms/${roomId}/commands`, {
    id: "00000000-0000-4000-8000-000000000057",
    type: "work.proposed",
    data: {
      workItemId: "ws-item-1", title: "Draft the agenda",
      definitionOfDone: "Named next step",
      accountableMemberId: memberId, mode: "read",
    },
  }, ownerSecret);
  assert.equal(propRes.status, 201);
  const res = await get(origin, `/api/rooms/${roomId}/work-sessions`, ownerSecret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.sessions.some(s => s.workItemId === "ws-item-1"), "session is listed");
  assert.deepEqual(json.next.map(n => n.action), ["claim-session"]);
  const claim = json.next[0];
  assert.equal(claim.method, "POST");
  assert.equal(claim.path, `/api/rooms/${roomId}/work-sessions`);
  assert.ok(claim.description.includes("ws-item-1"), "claim-session names the work item");
  assert.ok(claim.description.includes("processing"), "claim-session shows the atomic claim");
});

test('new normalized rooms preserve explicit legacy-session refusal and execute the canonical work guidance',async t=>{
 const fixture=createAcceptanceFixture(),origin=await startServer(t,fixture),{ownerSecret,roomId,created}=await ownerRoom(origin,fixture,{starter:true});
 assert.equal(isCurrentRoom(fixture.store.db,roomId),true);assert.ok(created.next.some(step=>step.tool==='room_read_work'),'new-room guidance names the existing canonical starter reader');
 let response=await get(origin,`/api/rooms/${roomId}/work-sessions`,ownerSecret);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'current_room_context_required');response=await post(origin,`/api/rooms/${roomId}/work-claims`,{id:'old-board',title:'Retired registration'},ownerSecret);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'legacy_work_retired');
 const outsider=fixture.store.identities.create('Session outsider');response=await get(origin,`/api/rooms/${roomId}/work-sessions`,outsider.secret);assert.ok([401,403].includes(response.status),'unsupported legacy API never bypasses room authority');
 const command=async input=>{const r=await post(origin,`/api/rooms/${roomId}/commands`,input,ownerSecret),body=await r.json();assert.ok([200,201].includes(r.status),JSON.stringify(body));return body;};
 const startStep=created.next.find(step=>step.action==='start-work'),workItemId=startStep.body.data.workItemId;assert.equal(startStep.body.type,'work.started');const start={...startStep.body,id:'canonical-start'};const saved=await command(start),retried=await command(start);assert.equal(retried.duplicate,true);assert.equal(retried.event.id,saved.event.id);
 fixture.store.room=()=>{throw Error('canonical selected workflow must not hydrate whole room');};response=await get(origin,`/api/rooms/${roomId}/work-context?workItemId=${encodeURIComponent(workItemId)}`,ownerSecret);assert.equal(response.status,200);const selected=await response.json();assert.equal(selected.work.id,workItemId);assert.equal(selected.work.state,'working');assert.equal(selected.work.revision,2);response=await get(origin,`/api/rooms/${roomId}/work-list?focus=all&limit=1`,ownerSecret);assert.equal(response.status,200);assert.equal((await response.json()).work[0].id,workItemId);
});
