// Run by tests/handoff-packet.test.js with ROOM_HANDOFF_PACKET=1 (tool lists are fixed at import).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

test("get_room_context view:handoff over hosted MCP", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  send("message.posted", { messageId: "rule-src", body: "We merge only through Codex." });
  send("decision.recorded", { sourceMessageId: "rule-src", statement: "Codex is the only merger." });
  f.store.workClaims.set("commons", { id: "held-1", title: "Held work", state: "claimed", owner: "producer", history: [] });
  const identity = f.store.identities.create("Handoff reader");
  linkWithProof(f.store, f.keys.owner, "commons", identity, { memberId: "reader", displayName: "Reader agent", permissions: ["accept_work"] });
  const auth = { authorization: `Bearer ${identity.secret}` };
  const mcp = createHostedRoomMcp(f.store);
  const { HOSTED_ROOM_MCP_TOOLS } = await import("../src/room-mcp-join.js");
  assert.ok(!HOSTED_ROOM_MCP_TOOLS.includes("room_handoff_packet"), "folded into get_room_context: no extra tool");
  const reply = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_room_context", arguments: { roomId: "commons", view: "handoff" } } }, auth);
  assert.ok(reply.result && !reply.result.isError, JSON.stringify(reply).slice(0, 2000));
  const packet = reply.result.structuredContent;
  assert.equal(packet.contract.name, "project-room/handoff-packet");
  assert.equal(packet.roomId, "commons");
  assert.ok(packet.decisions.some(d => d.statement === "Codex is the only merger."), JSON.stringify(packet.decisions));
  assert.ok("charter" in packet.rules);
  assert.equal(packet.claims.scope, "caller_owned_summaries");
  assert.ok(Array.isArray(packet.claims.yours));
});


test("actual owned claims are summaries, not fabricated full Board rows", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const identity = f.store.identities.create("Summary reader");
  linkWithProof(f.store, f.keys.owner, "commons", identity, { memberId: "reader", displayName: "Reader", permissions: [] });
  for (const [id, owner] of [["mine", "reader"], ["other", "producer"]]) f.store.workClaims.set("commons", { id, title: id, state: "claimed", owner, repo: "o/r", files: ["src/a.js"], leaseExpiresAt: "2026-11-05T00:00:00Z", history: [] });
  const mcp = createHostedRoomMcp(f.store);
  const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_room_context", arguments: { roomId: "commons", view: "handoff" } } }, { authorization: `Bearer ${identity.secret}` });
  const p = r.result.structuredContent;
  assert.equal(p.claims.scope, "caller_owned_summaries");
  assert.deepEqual(p.claims.yours, [{ id: "mine", title: "mine", state: "claimed" }]);
  assert.equal(p.claims.total, 1); assert.equal(p.claims.openTotal, undefined);
});

import { RoomStore } from "../server/store.mjs";
import { seedPostOAuth, providerFor, resource } from "./helpers/work-linked-post-oauth.mjs";
test("normalized handoff keeps omissions and follows its exact work continuation without hidden history", async t => {
  const s = new RoomStore(":memory:"); t.after(() => s.close());
  const saved = seedPostOAuth(s, { scopes: ["rooms:read", "chat:read", "work:read"] });
  for (let i=0; i<18; i++) s.command(saved.owner, "commons", { id: `task-${i}`, type: "work.proposed", data: { workItemId: `extra-${String(i).padStart(2,"0")}`, title: `Useful ${i}`, definitionOfDone: "Work", accountableMemberId: saved.identityId } });
  s.command(saved.owner, "commons", { id: "private", type: "message.posted", data: { messageId: "private", toMemberId: "observer", body: "HIDDEN-HANDOFF-TEXT" } });
  s.room = () => { throw Error("whole-room hydration"); };
  const mcp = createHostedRoomMcp(s, { oauthProvider: providerFor(s), oauthResource: resource });
  const call = (pointer, token=saved.identitySecret) => mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: pointer.tool, arguments: pointer.arguments } }, { authorization: `Bearer ${token}` });
  let pointer={ tool:"get_room_context", arguments:{roomId:"commons",view:"handoff"} }, first, ids=[];
  for(let i=0;i<3;i++) {
    const r=await call(pointer);assert.ok(r.result&&!r.result.isError,JSON.stringify(r));const p=r.result.structuredContent;first??=p;
    assert.equal(p.workScope,"workWindow");assert.equal(p.claims.scope,"omitted");assert.equal(p.claims.total,null);assert.equal(p.claims.yours,null);
    assert.ok(p.omitted.includes("board_claims"));assert.equal(p.rules.pinned,null);assert.ok(p.workWindow.shown<=8);assert.equal(p.workWindow.total,19);
    assert.ok(!JSON.stringify(p).includes("HIDDEN-HANDOFF-TEXT"));ids.push(...p.yourWork.map(w=>w.id));
    pointer=p.next.find(n=>n.tool==='get_room_context');
  }
  assert.equal(pointer,undefined);assert.equal(new Set(ids).size,19);assert.equal(ids.length,19);
  const selected=await call(first.yourWork[0].nextRead);assert.ok(selected.result&&!selected.result.isError,JSON.stringify(selected));
  const denied=await call({tool:"get_room_context",arguments:{roomId:"commons",view:"handoff"}},saved.token);
  assert.ok(denied.error);assert.match(denied.error.data.hint,/outside the connected agent grant/);
});
