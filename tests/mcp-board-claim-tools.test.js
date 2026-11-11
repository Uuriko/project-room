// Flag-on coverage for ROOM_BOARD_CLAIM_TOOLS. Run with
//   ROOM_BOARD_CLAIM_TOOLS=1 node --test tests/mcp-board-claim-tools.test.js
// Without the flag the suite checks the tools stay hidden.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { API_KEY_PREFIX } from "../server/agent-api-keys.mjs";

const ON = /^(1|true|on)$/i.test(String(process.env.ROOM_BOARD_CLAIM_TOOLS ?? "").trim());

async function world() {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  const parse = t => { try { return JSON.parse(t); } catch { return JSON.parse(t.match(/data: (.*)/)[1]); } };
  const rpc = async (secret, method, params) => parse(await (await fetch(`${origin}/mcp`, { method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) })).text());
  const rest = async (secret, path, body) => { const r = await fetch(origin + path, { method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) }; };
  const agent = name => { const id = f.store.identities.create(name);
    linkWithProof(f.store, f.keys.owner, "commons", id, { memberId: name.toLowerCase(), displayName: name, permissions: ["accept_work", "complete_work"] });
    return id.secret; };
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); };
  return { f, rpc, rest, agent, close };
}
const body = r => r.result?.structuredContent ?? JSON.parse(r.result?.content?.[0]?.text ?? "null");

test("board claim tools follow the flag in tools/list", async () => {
  const w = await world();
  try {
    const names = (await w.rpc(w.agent("Lister"), "tools/list", {})).result.tools.map(t => t.name);
    for (const name of ["room_work_claim"]) assert.equal(names.includes(name), ON, name);
  } finally { await w.close(); }
});

test("take then finish moves a Board task to delivered; a second taker is refused", { skip: !ON }, async () => {
  const w = await world();
  try {
    assert.equal((await w.rest(w.f.keys.owner, "/api/rooms/commons/work-claims", { id: "fix-login", title: "Fix login", note: "n" })).status, 201);
    const a = w.agent("Alpha"), b = w.agent("Beta");
    const took = await w.rpc(a, "tools/call", { name: "room_work_claim", arguments: { op: "take", roomId: "commons", claimId: "fix-login" } });
    assert.notEqual(took.result.isError, true);
    assert.equal(body(took).state, "claimed");
    const lost = await w.rpc(b, "tools/call", { name: "room_work_claim", arguments: { op: "take", roomId: "commons", claimId: "fix-login" } });
    assert.ok(lost.error || lost.result?.isError);
    const done = await w.rpc(a, "tools/call", { name: "room_work_claim", arguments: { op: "finish", roomId: "commons", claimId: "fix-login", note: "Fixed; tests pass." } });
    assert.notEqual(done.result.isError, true, JSON.stringify(done));
    assert.equal(body(done).state, "delivered");
    const stranger = await w.rpc(b, "tools/call", { name: "room_work_claim", arguments: { op: "finish", roomId: "commons", claimId: "fix-login", note: "x" } });
    assert.ok(stranger.error || stranger.result?.isError);
  } finally { await w.close(); }
});

test("finish refuses unknown fields and a missing note", { skip: !ON }, async () => {
  const w = await world();
  try {
    const a = w.agent("Gamma");
    const r = await w.rpc(a, "tools/call", { name: "room_work_claim", arguments: { op: "finish", roomId: "commons", claimId: "x" } });
    assert.ok(r.error || r.result?.isError);
    const r2 = await w.rpc(a, "tools/call", { name: "room_work_claim", arguments: { op: "take", roomId: "commons", claimId: "x", bogus: 1 } });
    assert.ok(r2.error || r2.result?.isError);
  } finally { await w.close(); }
});

test("op plan forwards planning fields to the REST update route, with no new schema bytes over 848", async () => {
  const { validBoardClaimArgs, boardClaimSteps, boardClaimToolDefinitions } = await import("../server/board-claim-tools.mjs");
  assert.equal(validBoardClaimArgs("room_work_claim", { claimId: "w1", op: "plan", plan: { priority: 1, milestone: null } }), true);
  assert.equal(validBoardClaimArgs("room_work_claim", { claimId: "w1", op: "plan", plan: {} }), false);
  assert.equal(validBoardClaimArgs("room_work_claim", { claimId: "w1", op: "plan", plan: { priority: 1 }, note: "x" }), false);
  assert.deepEqual(boardClaimSteps("room_work_claim", { op: "plan", plan: { dueAt: "2030-01-01T00:00:00Z" } }, "claimed"),
    [["update", { dueAt: "2030-01-01T00:00:00Z" }]]);
  assert.ok(JSON.stringify(boardClaimToolDefinitions()).length <= 848);
});

test("op list returns Board tasks through the REST list route; query is flat params", { skip: !ON }, async () => {
  const { validBoardClaimArgs } = await import("../server/board-claim-tools.mjs");
  assert.equal(validBoardClaimArgs("room_work_claim", { op: "list", query: { state: "unclaimed", limit: 5 } }), true);
  assert.equal(validBoardClaimArgs("room_work_claim", { op: "list", query: { state: ["x"] } }), false);
  assert.equal(validBoardClaimArgs("room_work_claim", { op: "list", claimId: "w1" }), false);
  const w = await world();
  try {
    for (const id of ["l1", "l2"]) assert.equal((await w.rest(w.f.keys.owner, "/api/rooms/commons/work-claims", { id, title: id, note: "n" })).status, 201);
    const a = w.agent("Lister");
    const all = await w.rpc(a, "tools/call", { name: "room_work_claim", arguments: { op: "list", roomId: "commons" } });
    assert.notEqual(all.result.isError, true, JSON.stringify(all));
    assert.deepEqual(body(all).claims.map(c => c.id).filter(id => id.startsWith("l")).sort(), ["l1", "l2"]);
    const one = await w.rpc(a, "tools/call", { name: "room_work_claim", arguments: { op: "list", roomId: "commons", query: { limit: 1 } } });
    assert.equal(body(one).claims.length, 1);
    const bad = await w.rpc(a, "tools/call", { name: "room_work_claim", arguments: { op: "list", roomId: "commons", query: { sort: "nope" } } });
    assert.ok(bad.error || bad.result?.isError);
  } finally { await w.close(); }
});

test("Board facade keeps the existing rooms:write API-key boundary", { skip: !ON }, async () => {
  const w = await world();
  try {
    assert.equal((await w.rest(w.f.keys.owner, "/api/rooms/commons/work-claims", { id: "scoped-work", title: "Scope check", note: "n" })).status, 201);
    const identity = w.f.store.identities.create("Scoped worker");
    linkWithProof(w.f.store, w.f.keys.owner, "commons", identity, { memberId: "scoped-worker", displayName: "Scoped worker", permissions: ["accept_work", "complete_work"] });
    const issue = scopes => API_KEY_PREFIX + w.f.store.agentPlugin.issueApiKey({ identityId: identity.identityId, scopes }).secret;
    const args = { op: "take", roomId: "commons", claimId: "scoped-work" };
    const refused = await w.rpc(issue(["rooms:read"]), "tools/call", { name: "room_work_claim", arguments: args });
    assert.ok(refused.error || refused.result?.isError, JSON.stringify(refused));
    assert.match(JSON.stringify(refused), /insufficient_scope/);
    assert.equal(w.f.store.workClaims.get("commons", "scoped-work").state, "unclaimed");
    const accepted = await w.rpc(issue(["rooms:read", "rooms:write"]), "tools/call", { name: "room_work_claim", arguments: args });
    assert.notEqual(accepted.result?.isError, true, JSON.stringify(accepted));
    assert.equal(body(accepted).state, "claimed");
  } finally { await w.close(); }
});
