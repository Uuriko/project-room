// RC-2026-09-30-3611 (human-door P0-2): the general request-access door.
// The door's home is the join page since the #3293 consolidation (the
// account-panel door was retired in step 2); src/join.js wires this
// module's orchestration to #join-request-form.
// Contracts guarded here:
//  1. The door builds a valid POST /api/access-requests body: non-empty
//     roomId (default muse-room comes from the HTML), validated display
//     name, ar_-shaped idempotency key, minimal accept_work ask.
//  2. The submit orchestration reuses the browser-stashed identity per room
//     instead of minting a fresh identity per click (the mint endpoint is
//     rate-limited; a per-click mint burns it).
//  3. A retry reuses the stashed requestId — the server's idempotency key —
//     instead of minting a fresh one per attempt, so a retry after a lost
//     response returns the original request instead of filing a duplicate.
// Neither is covered elsewhere: server tests own the POST route, join-p2s
// owns the invite-context helpers, and the dead-invite flow in app.js is
// DOM-wired without unit coverage at this boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  approvedAccountRequestRoom,
  retireHumanAccessRequest,
  GENERAL_REQUEST_DEFAULT_ROOM_ID,
  buildGeneralAccessRequest,
  submitGeneralAccessRequest,
} from "../src/request-access.js";
import { FALLBACK_REQUEST_PERMISSIONS, readAccessRequest, stashAccessRequest } from "../src/invite-context.js";

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => m.delete(k),
  };
}

function fakeClient({ identityId = "ai_test123", calls = [] } = {}) {
  let mints = 0;
  return {
    calls,
    restore: async () => ({ authenticated: false }),
    mintCount: () => mints,
    mintAccessIdentity: async (displayName) => {
      mints += 1;
      assert.ok(typeof displayName === "string" && displayName.length > 0);
      return identityId ? { identityId, secret: "pri_test" } : {};
    },
    submitAccessRequest: async (body) => { calls.push(body); return { ok: true }; },
  };
}

test("general door defaults to the open community room", () => {
  assert.equal(GENERAL_REQUEST_DEFAULT_ROOM_ID, "muse-room");
});

test("build: valid fields produce a submittable body", () => {
  const body = buildGeneralAccessRequest({
    roomId: "muse-room",
    displayName: "  Ada  ",
    note: "hello",
    referredBy: "",
  });
  assert.equal(body.roomId, "muse-room");
  assert.equal(body.displayName, "Ada");
  assert.equal(body.note, "hello");
  assert.equal(body.referredBy, null);
  assert.deepEqual(body.requestedPermissions, [...FALLBACK_REQUEST_PERMISSIONS]);
  assert.match(body.requestId, /^ar_[0-9a-f]{16}$/);
  assert.equal(body.identityId, null);
});

test("build: empty room id and blank name throw user-facing errors", () => {
  assert.throws(() => buildGeneralAccessRequest({ roomId: "  ", displayName: "Ada" }), /link of the room/i);
  assert.throws(() => buildGeneralAccessRequest({ roomId: "muse-room", displayName: "   " }), /display name/i);
  assert.throws(() => buildGeneralAccessRequest({ roomId: "muse-room", displayName: "x".repeat(81) }), /80/);
});

test("build: a pasted room link resolves to its room id", () => {
  for (const link of ["https://room.trydemigod.com/?room=team-7", "https://room.trydemigod.com/#room/team-7", "  team-7  "]) {
    assert.equal(buildGeneralAccessRequest({ roomId: link, displayName: "Ada" }).roomId, "team-7", link);
  }
  assert.throws(() => buildGeneralAccessRequest({ roomId: "x".repeat(129), displayName: "Ada" }), /doesn't look like a room link/);
  // A long shared link (tracking params, invite fragments) is not cut off: the
  // field has no maxlength and only the resolved room id is length-checked.
  const longLink = `https://room.trydemigod.com/?room=team-7&utm_source=${"x".repeat(300)}`;
  assert.equal(buildGeneralAccessRequest({ roomId: longLink, displayName: "Ada" }).roomId, "team-7");
  const html = readFileSync(new URL("../join.html", import.meta.url), "utf8");
  assert.match(html, /Room link/);
  assert.doesNotMatch(html.match(/<input id="join-request-room"[^>]*>/)[0], /maxlength/);
});

test("the account panel no longer carries a request-access door (#3293 step 2)", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /account-request-(access|form|room|name|note|referred|submit|status)/);
});

test("submit: mints once, submits with the minted identity, stashes the record", async () => {
  const client = fakeClient();
  const storage = memStorage();
  const result = await submitGeneralAccessRequest({
    client, storage, roomId: "muse-room", displayName: "Ada", note: null, referredBy: null,
  });
  assert.equal(client.mintCount(), 1);
  assert.equal(client.calls.length, 1);
  const sent = client.calls[0];
  assert.equal(sent.roomId, "muse-room");
  assert.equal(sent.identityId, "ai_test123");
  assert.equal(sent.secret, "pri_test", "the minted identity's secret travels with the filing as proof (issue #2912)");
  assert.equal(sent.displayName, "Ada");
  assert.match(sent.requestId, /^ar_[0-9a-f]{16}$/);
  assert.equal(result.requestId, sent.requestId);
  assert.equal(result.roomId, "muse-room");
});

test("submit: retry reuses the stashed identity instead of minting again", async () => {
  const client = fakeClient();
  const storage = memStorage();
  await submitGeneralAccessRequest({ client, storage, roomId: "muse-room", displayName: "Ada" });
  await submitGeneralAccessRequest({ client, storage, roomId: "muse-room", displayName: "Ada" });
  assert.equal(client.mintCount(), 1);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].identityId, client.calls[1].identityId);
  // The requestId is the server's idempotency key: a retry that mints a
  // fresh one files a duplicate request when the first response was lost.
  assert.equal(client.calls[0].requestId, client.calls[1].requestId);
});

test("submit: a pre-stashed requestId is reused as the idempotency key", async () => {
  const client = fakeClient();
  const storage = memStorage();
  stashAccessRequest(storage, "muse-room", {
    identityId: "ai_test123", secret: "pri_test", requestId: "ar_0123456789abcdef", displayName: "Ada",
  });
  const result = await submitGeneralAccessRequest({ client, storage, roomId: "muse-room", displayName: "Ada" });
  assert.equal(client.mintCount(), 0);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].requestId, "ar_0123456789abcdef");
  assert.equal(result.requestId, "ar_0123456789abcdef");
});

test("submit: a different room mints its own identity", async () => {
  const client = fakeClient();
  const storage = memStorage();
  await submitGeneralAccessRequest({ client, storage, roomId: "muse-room", displayName: "Ada" });
  await submitGeneralAccessRequest({ client, storage, roomId: "other-room", displayName: "Ada" });
  assert.equal(client.mintCount(), 2);
});

test("submit: mint returning no identity fails closed", async () => {
  const client = fakeClient({ identityId: null });
  await assert.rejects(
    () => submitGeneralAccessRequest({ client, storage: memStorage(), roomId: "muse-room", displayName: "Ada" }),
    /identity service/i,
  );
});

test("submit: a failed submit keeps the minted identity stashed for the retry (M-37)", async () => {
  let failSubmit = true;
  const client = fakeClient();
  const submit = client.submitAccessRequest;
  const attempted = [];
  client.submitAccessRequest = async (body) => {
    attempted.push(body);
    if (failSubmit) throw new Error("network down");
    return submit(body);
  };
  const storage = memStorage();
  await assert.rejects(
    () => submitGeneralAccessRequest({ client, storage, roomId: "muse-room", displayName: "Ada" }),
    /network down/,
  );
  const stashed = readAccessRequest(storage, "muse-room");
  assert.ok(stashed?.identityId, "the minted identity stays stashed even though the submit failed");

  failSubmit = false;
  const result = await submitGeneralAccessRequest({ client, storage, roomId: "muse-room", displayName: "Ada" });
  assert.equal(client.mintCount(), 1, "the retry reuses the stashed identity instead of minting again");
  assert.equal(result.identityId, stashed.identityId);
  // The failed attempt may still have reached the server (lost response), so
  // the retry must carry the SAME requestId: it is the server's idempotency
  // key and reusing it returns the original request instead of a duplicate.
  assert.equal(attempted.length, 2);
  assert.equal(attempted[1].requestId, attempted[0].requestId);
  assert.equal(result.requestId, attempted[0].requestId);
  assert.equal(result.requestId, stashed.requestId);
});

 test("room address input resolves before requesting access and refuses unrecognized URLs", () => {
  for (const roomId of ["https://example.test/rooms/team-7", "https://example.test/room/rooms/team-7/", "/rooms/team-7"]) {
    assert.equal(buildGeneralAccessRequest({ roomId, displayName: "Ada" }).roomId, "team-7");
  }
  for (const roomId of ["https://example.test/unknown", "https://example.test/rooms/bad%2Fid", "not a room"]) {
    assert.throws(() => buildGeneralAccessRequest({ roomId, displayName: "Ada" }), /room link/);
  }
});

test("signed human requests never mint agents and retry within account scope",async()=>{
  const storage=memStorage(), calls=[];let account="human-a",lose=true;
  const client={restore:async()=>({authenticated:true,account:{id:account}}),
    mintAccessIdentity:async()=>assert.fail("must not mint"),
    submitAccountAccessRequest:async body=>{calls.push(body);if(lose){lose=false;throw new Error("lost response");}return {request:{...body,principalKind:"account",status:"pending"}};}};
  stashAccessRequest(storage,"commons",{identityId:"ai_old",secret:"old-secret",requestId:"ar_agent"});
  const submit=()=>submitGeneralAccessRequest({client,storage,roomId:"commons",displayName:"Ada"});
  await assert.rejects(submit(),/lost response/);await submit();
  assert.equal(calls[0].requestId,calls[1].requestId);assert.notEqual(calls[0].requestId,"ar_agent");
  for(const key of ["identityId","secret","accountId"]) assert.equal(Object.hasOwn(calls[0],key),false);
  account="human-b";await submit();assert.notEqual(calls[2].requestId,calls[0].requestId);
});
test("failed account restoration never falls back to agent mint",async()=>{
  const client={restore:async()=>{throw new Error("offline");},mintAccessIdentity:async()=>assert.fail("must not mint")};
  await assert.rejects(submitGeneralAccessRequest({client,storage:memStorage(),roomId:"commons",displayName:"Ada"}),/offline/);
});
test("approval needs matching membership in actual account discovery, including later pages",async()=>{
  const request={requestId:"ar_test",roomId:"commons",principalKind:"account",status:"approved",memberId:"human-member"};
  let reads=0;
  const client={accountAccessRequest:async()=>({request}),rooms:async cursor=>{reads++;return cursor===null?{rooms:[{id:"a-room",memberId:"other"}],nextCursor:"a-room"}:{rooms:[{id:"commons",memberId:"human-member"}],nextCursor:null};}};
  assert.equal((await approvedAccountRequestRoom(client,"ar_test","commons")).room.id,"commons");assert.equal(reads,2);
  client.rooms=async()=>({rooms:[{id:"commons",memberId:"wrong-member"}],nextCursor:null});
  assert.equal((await approvedAccountRequestRoom(client,"ar_test","commons")).room,null);
  request.status="denied";client.rooms=async()=>assert.fail("do not read rooms after denial");
  assert.deepEqual(await approvedAccountRequestRoom(client,"ar_test","commons"),{status:"denied",room:null});
});
test("human door cannot mint an agent after sign-out or expiry",async()=>{
  const client={restore:async()=>({authenticated:false}),mintAccessIdentity:async()=>assert.fail("must not mint")};
  await assert.rejects(submitGeneralAccessRequest({client,storage:memStorage(),roomId:"commons",displayName:"Ada",requireHuman:true}),{code:"account_session_required"});
});
test("unreadable retry storage stops before creating a duplicate operation",async()=>{
  const client={restore:async()=>({authenticated:true,account:{id:"human"}}),submitAccountAccessRequest:async()=>assert.fail("must not send")};
  const storage={getItem(){throw new Error("storage unavailable");}};
  await assert.rejects(submitGeneralAccessRequest({client,storage,roomId:"commons",displayName:"Ada"}),/storage unavailable/);
});
test("lost response retries immutable fields and reauthentication starts a new operation",async()=>{
  const storage=memStorage(),calls=[];let epoch=0;
  const client={restore:async()=>({authenticated:true,account:{id:"human",authEpoch:epoch}}),submitAccountAccessRequest:async body=>{
    calls.push(body);if(calls.length===1)throw new Error("lost response");return {request:{...body,principalKind:"account",status:"pending"}};
  }};
  const submit=displayName=>submitGeneralAccessRequest({client,storage,roomId:"commons",displayName,note:displayName});
  await assert.rejects(submit("Original"),/lost response/);
  await submit("Edited");assert.deepEqual(calls[1],calls[0]);
  epoch++;await submit("Reauthenticated");assert.notEqual(calls[2].requestId,calls[0].requestId);assert.equal(calls[2].displayName,"Reauthenticated");
});
test("retiring a terminal operation cannot clear a different request or account",async()=>{
  const storage=memStorage(),session={authenticated:true,account:{id:"human",authEpoch:0}};
  const client={restore:async()=>session,submitAccountAccessRequest:async payload=>({request:{...payload,principalKind:"account"}})};
  const input={client,storage,roomId:"commons",displayName:"Ada"};
  const original=await submitGeneralAccessRequest(input);
  assert.equal(retireHumanAccessRequest(storage,session,"commons","ar_other"),false);
  assert.equal(retireHumanAccessRequest(storage,{account:{id:"other",authEpoch:0}},"commons",original.requestId),false);
  assert.equal((await submitGeneralAccessRequest(input)).requestId,original.requestId);
  assert.equal(retireHumanAccessRequest(storage,session,"commons",original.requestId),true);
  assert.notEqual((await submitGeneralAccessRequest(input)).requestId,original.requestId);
});


test("missing human admission stops waiting while transient failures propagate", async () => {
  const client = { accountAccessRequest: async () => { throw Object.assign(new Error("missing"), {status: 404}); } };
  assert.deepEqual(await approvedAccountRequestRoom(client, "ar_missing", "commons"), {status: "unavailable", room: null});
  client.accountAccessRequest = async () => { throw Object.assign(new Error("unavailable"), {status: 503}); };
  await assert.rejects(approvedAccountRequestRoom(client, "ar_missing", "commons"), /unavailable/);
});
