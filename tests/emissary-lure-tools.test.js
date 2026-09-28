// Emissary Slice 2 (RC-2026-09-28-2873): MCP wiring tests for the three
// emissary tools in server/mcp-room-profile.mjs + server/emissary-lure.mjs.
//
// Test-authoring gate (repo AGENTS.md + .agents/skills/test-audit/SKILL.md):
// 1. Observable contract protected — named in each test's comment.
// 2. Credible regression — what change makes it fail.
// 3. Why existing coverage doesn't catch it — no existing coverage of
//    these tools; each test names its distinct boundary.
// 4. No test-only production seam — every test drives the real MCP
//    dispatch (createHostedRoomMcp tools/call) or the real
//    handleEmissaryTool with a real RoomStore; the share-link mint uses
//    the real ShareLinks.create (owner/delegated-admin gate intact).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { demoteToReadonly, getTier } from "../server/autonomy-tiers.mjs";
import { handleEmissaryTool } from "../server/emissary-lure.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "emissary-tools-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  const owner = store.identities.create("Owner");
  const created = rooms.create(owner.secret, { title: "Commons", purpose: "Test room", displayName: "Owner" });
  const roomId = created.roomId;
  const mcp = createHostedRoomMcp(store);
  const rpc = (method, params) => ({ jsonrpc: "2.0", id: "c", method, ...(params === undefined ? {} : { params }) });
  const call = async (secret, name, args) => {
    const response = await mcp(rpc("tools/call", { name, arguments: args }), { authorization: `Bearer ${secret}` });
    if (response.error) return { ...response.error.data, message: response.error.message };
    if (response.result?.structuredContent) return response.result.structuredContent;
    try { return JSON.parse(response.result?.content?.[0]?.text); } catch { return {}; }
  };
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, owner, roomId, call };
}

function addMember(setupResult, displayName) {
  const { store, rooms, owner, roomId } = setupResult;
  const identity = store.identities.create(displayName);
  const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName }, null);
  const joined = store.invites.redeem(invite.code, { displayName, identitySecret: identity.secret });
  return { identity, memberId: joined.memberId ?? joined.member?.id };
}

// 1. Contract: emissary_drop is callable over MCP and returns a drop_id.
//    Regression: the tool missing from the dispatch or the catalog.
test("MCP emissary_drop generates a drop", async t => {
  const { roomId, owner, call } = setup(t);
  const result = await call(owner.secret, "emissary_drop", {
    roomId, venue: "sssnack", title: "Join our room", terms: "We coordinate agent work here.",
  });
  assert.match(result.drop_id, /^emd1\.[0-9a-f]{32}$/);
  assert.ok(result.text.includes("Join our room"));
  assert.equal(result.duplicate, false);
});

// 2. Contract: the MCP validation layer rejects bad venues with
//    invalid_arguments before the module runs. Regression: validEmissaryArgs
//    weakened, letting bad input reach the generator.
test("MCP rejects an invalid venue with invalid_arguments", async t => {
  const { roomId, owner, call } = setup(t);
  const result = await call(owner.secret, "emissary_drop", { roomId, venue: "nope", title: "T", terms: "terms" });
  assert.equal(result.reason, "invalid_arguments");
});

// 3. Contract: emissary_pitch over MCP cites a verified receipt.
//    Regression: proof resolution broken in the MCP path.
test("MCP emissary_pitch cites a verified receipt", async t => {
  const { store, roomId, owner, call } = setup(t);
  store.db.exec("CREATE TABLE external_receipts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL)");
  const ref = `ert1.${"ab".repeat(16)}`;
  store.db.prepare("INSERT INTO external_receipts (id, kind, created_at) VALUES (?, 'jury', ?)").run(ref, Date.now());
  const result = await call(owner.secret, "emissary_pitch", { roomId, focus: "We need reviewers.", proof_refs: [ref] });
  assert.ok(result.text.startsWith("We need reviewers."));
  assert.ok(result.text.includes(ref));
});

// 4. Contract: the room owner can mint a human invite over MCP and gets a
//    #join/ URL. Regression: ShareLinks wiring broken in the MCP path.
test("MCP human_invite_mint works for the room owner", async t => {
  const { roomId, owner, call } = setup(t);
  const result = await call(owner.secret, "human_invite_mint", { roomId, note: "for Ada" });
  assert.match(result.url, /^https:\/\/www\.getdasha\.com\/room\/#join\/[A-Za-z0-9_-]{43}$/);
  assert.match(result.attribution_id, /^eia1\.[0-9a-f]{32}$/);
});

// 5. Contract: an ordinary member cannot mint human invites —
//    ShareLinks.create's owner/delegated-admin gate is preserved.
//    Regression: the MCP path bypassing the authority check.
test("MCP human_invite_mint denies an ordinary member", async t => {
  const s = setup(t);
  const { identity } = addMember(s, "Member");
  const result = await s.call(identity.secret, "human_invite_mint", { roomId: s.roomId });
  assert.equal(result.status, 403);
});

// 6. Contract: the t1_readonly autonomy tier denies all three tools.
//    Regression: the tier check missing from the MCP path.
test("MCP denies t1_readonly members on all three tools", async t => {
  const s = setup(t);
  const { identity, memberId } = addMember(s, "Readonly");
  demoteToReadonly(s.store.db, s.roomId, memberId, { updatedBy: "owner", nowMs: Date.now() });
  assert.equal(getTier(s.store.db, s.roomId, memberId).autonomyTier, "t1_readonly");
  for (const [name, args] of [
    ["emissary_drop", { roomId: s.roomId, venue: "sssnack", title: "T", terms: "terms" }],
    ["emissary_pitch", { roomId: s.roomId, focus: "Hi", proof_refs: [] }],
    ["human_invite_mint", { roomId: s.roomId }],
  ]) {
    const result = await s.call(identity.secret, name, args);
    assert.ok(result.code === "agent_readonly" || result.status === 403, `${name} should deny t1_readonly`);
  }
});

// 7. Contract: guest agents are denied at the module boundary.
//    Regression: the guest check missing from handleEmissaryTool.
test("guest agents are denied", t => {
  const directory = mkdtempSync(join(tmpdir(), "emissary-guest-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const guestToken = "ga1." + "A".repeat(43);
  const guest = store.guestAgentLinks.mint(ownerKey, "commons", {
    requestId: "guest-1", linkToken: guestToken, expectedOwnerRevision: 0, displayName: "guest-agent",
  }, null);
  assert.throws(() => handleEmissaryTool(store, guest.token, "emissary_drop",
    { roomId: "commons", venue: "sssnack", title: "T", terms: "terms" }),
    err => err.code === "guest_scope_denied" && err.status === 403);
});

// 8. Contract: callers with no room membership get 401/403, not generation.
//    Regression: authenticate bypassed in the MCP path.
test("MCP denies callers with no membership", async t => {
  const { roomId, store, call } = setup(t);
  const outsider = store.identities.create("Outsider");
  const result = await call(outsider.secret, "emissary_drop",
    { roomId, venue: "sssnack", title: "T", terms: "terms" });
  assert.ok(result.status === 401 || result.status === 403);
});

// 9. Contract (architecture): generating lures creates no room messages or
//    events — the server never auto-posts. Regression: a "helpful"
//    auto-share added to the generation path.
test("generation creates no room messages or events", async t => {
  const s = setup(t);
  const before = s.store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  await s.call(s.owner.secret, "emissary_drop", {
    roomId: s.roomId, venue: "sssnack", title: "T", terms: "terms",
  });
  await s.call(s.owner.secret, "human_invite_mint", { roomId: s.roomId });
  const after = s.store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  assert.equal(after, before, "generation must not emit room events");
});
