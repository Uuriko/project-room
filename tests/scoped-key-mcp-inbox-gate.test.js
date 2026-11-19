// B5-4-F8: room_read_inbox bypassed the mcp:inbox scoped-key gate via the
// hosted-stdio branch. The core profile's own design comment states scoped
// API keys need the mcp:inbox scope for inbox tools — inbox tools reach
// the identity's whole inbox, which room scopes never cover — but
// room_read_inbox is a hosted-stdio tool, and the isHostedStdioTool branch
// runs before the INBOX_TOOLS branch, routing it to callHostedStdioTool,
// whose API-key gate required only rooms:read for read-class tools.
// Executed at base 927a6420: a rak_ key holding only rooms:read called
// room_read_inbox successfully and received the full identity-wide inbox.
//
// Secondary (same defect family): inbox/wake scope refusals were rendered
// by mcpCallError's fallthrough as -32602 invalid_arguments (the hint
// named the missing scope; the reason/message lied), and argument
// validation ran before the named scope gates, so a malformed call from
// an under-scoped key heard only about its arguments.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { API_KEY_PREFIX } from "../server/agent-api-keys.mjs";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";
import { mcpCallError } from "../server/mcp-arg-errors.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "scoped-key-mcp-inbox-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, rooms };
}

async function call(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent };
}

async function fixture(t) {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Wren");
  const agent = store.identities.create("Lark");
  const created = rooms.create(owner.secret, {
    roomId: "inbox-gate-den", title: "Inbox gate den", purpose: "mcp:inbox gate test",
    kind: "personal", displayName: "Wren"
  });
  store.identities.link(owner.secret, created.roomId, {
    identityId: agent.identityId, displayName: "Lark", permissions: []
  });
  const issue = scopes => API_KEY_PREFIX + store.agentPlugin.issueApiKey({ identityId: agent.identityId, scopes }).secret;
  return { origin, store, roomId: created.roomId, owner, issue };
}

function assertScopeRefusal(result, scope, label) {
  assert.equal(result.body.result, undefined, `${label}: no result envelope on a scope refusal`);
  assert.equal(result.body.error?.message, "insufficient_scope", label);
  assert.equal(result.body.error?.data?.reason, "insufficient_scope", label);
  assert.equal(result.body.error?.data?.category, "access", label);
  assert.notEqual(result.body.error?.code, -32602, `${label}: a scope refusal is not invalid_arguments`);
  assert.equal(result.body.error?.data?.hint, `API key lacks the ${scope} scope`, label);
}

test("hosted-stdio branch: a rooms:read-only key cannot read the identity-wide inbox via room_read_inbox", async t => {
  const { origin, roomId, owner, issue } = await fixture(t);
  const reader = issue(["rooms:read"]);
  const refused = await call(origin, "room_read_inbox", { roomId }, reader);
  assertScopeRefusal(refused, "mcp:inbox", "room_read_inbox under rooms:read");
  // A rooms:* wildcard is still a room scope: it never covers the inbox.
  assertScopeRefusal(await call(origin, "room_read_inbox", { roomId }, issue(["rooms:*"])), "mcp:inbox", "room_read_inbox under rooms:*");
  // The denial fires before argument validation: missing roomId changes nothing.
  assertScopeRefusal(await call(origin, "room_read_inbox", {}, reader), "mcp:inbox", "room_read_inbox with invalid args under rooms:read");
  // room_run_action recurses into the same handler: no smuggling past the gate.
  assertScopeRefusal(await call(origin, "room_run_action", { name: "room_read_inbox", arguments: { roomId } }, reader),
    "mcp:inbox", "room_read_inbox via room_run_action under rooms:read");
  // Owner identity secret is unaffected.
  const viaOwner = await call(origin, "room_read_inbox", { roomId }, owner.secret);
  assert.equal(viaOwner.body.error, undefined);
  assert.equal(viaOwner.body.result.isError ?? false, false);
  assert.ok(Array.isArray(viaOwner.value.directMessages), "owner still receives the inbox");
  // A key carrying mcp:inbox (alone, or via the mcp:* wildcard) succeeds:
  // the inbox gate requires mcp:inbox instead of rooms:read, as the
  // INBOX_TOOLS branch does.
  for (const [label, key] of [["mcp:inbox", issue(["mcp:inbox"])], ["mcp:*", issue(["mcp:*"])]]) {
    const viaKey = await call(origin, "room_read_inbox", { roomId }, key);
    assert.equal(viaKey.body.error, undefined, label);
    assert.equal(viaKey.body.result.isError ?? false, false, label);
    assert.ok(Array.isArray(viaKey.value.directMessages), label);
  }
});

test("hosted-stdio funnel: callHostedStdioTool itself refuses a rooms:read-only key (direct callers included)", async t => {
  const { store, roomId, owner, issue } = await fixture(t);
  await assert.rejects(
    callHostedStdioTool(store, issue(["rooms:read"]), "room_read_inbox", { roomId }),
    error => error.status === 403 && error.code === "insufficient_scope" && /mcp:inbox/.test(error.message));
  const viaOwner = await callHostedStdioTool(store, owner.secret, "room_read_inbox", { roomId });
  assert.equal(viaOwner.isError, false);
  assert.ok(Array.isArray(viaOwner.value.directMessages));
  const viaInboxKey = await callHostedStdioTool(store, issue(["mcp:inbox"]), "room_read_inbox", { roomId });
  assert.equal(viaInboxKey.isError, false);
});

test("INBOX_TOOLS branch: scoped key refused with insufficient_scope on valid and invalid arguments; owner succeeds", async t => {
  const { origin, owner, issue } = await fixture(t);
  const reader = issue(["rooms:read"]);
  assertScopeRefusal(await call(origin, "inbox_list_attachments", {}, reader), "mcp:inbox", "inbox_list_attachments valid args");
  assertScopeRefusal(await call(origin, "inbox_list_attachments", { bogus: 1 }, reader), "mcp:inbox", "inbox_list_attachments invalid args");
  assertScopeRefusal(await call(origin, "inbox_get_attachment", { id: "att-1" }, reader), "mcp:inbox", "inbox_get_attachment");
  const viaOwner = await call(origin, "inbox_list_attachments", {}, owner.secret);
  assert.equal(viaOwner.body.error, undefined);
  assert.ok(Array.isArray(viaOwner.value.attachments));
  const viaInboxKey = await call(origin, "inbox_list_attachments", {}, issue(["mcp:inbox"]));
  assert.equal(viaInboxKey.body.error, undefined);
  assert.ok(Array.isArray(viaInboxKey.value.attachments));
});

test("WAKE branch: scoped key refused with insufficient_scope; webhook tools additionally require webhooks:manage", async t => {
  const { origin, owner, issue } = await fixture(t);
  const reader = issue(["rooms:read"]);
  assertScopeRefusal(await call(origin, "heartbeat_set", { hostId: "h1", mode: "pull-only" }, reader), "mcp:wake", "heartbeat_set valid args");
  assertScopeRefusal(await call(origin, "heartbeat_set", { hostId: 42 }, reader), "mcp:wake", "heartbeat_set invalid args");
  assertScopeRefusal(await call(origin, "webhook_list", {}, reader), "mcp:wake", "webhook_list without mcp:wake");
  const wakeOnly = issue(["mcp:wake"]);
  assertScopeRefusal(await call(origin, "webhook_list", {}, wakeOnly), "webhooks:manage", "webhook_list with mcp:wake only");
  assertScopeRefusal(await call(origin, "webhook_list", { bogus: 1 }, wakeOnly), "webhooks:manage", "webhook_list invalid args with mcp:wake only");
  // Adequately scoped keys and the owner keep working.
  const viaWake = await call(origin, "heartbeat_set", { hostId: "h1", mode: "pull-only" }, wakeOnly);
  assert.equal(viaWake.body.error, undefined, JSON.stringify(viaWake.body).slice(0, 200));
  assert.equal(viaWake.body.result.isError ?? false, false);
  const viaManaged = await call(origin, "webhook_list", {}, issue(["mcp:wake", "webhooks:manage"]));
  assert.equal(viaManaged.body.error, undefined);
  assert.ok(Array.isArray(viaManaged.value.subscriptions));
  const viaOwner = await call(origin, "webhook_list", {}, owner.secret);
  assert.equal(viaOwner.body.error, undefined);
  assert.ok(Array.isArray(viaOwner.value.subscriptions));
});

test("mcpCallError renders insufficient_scope as an access error, never as invalid_arguments", () => {
  const error = mcpCallError(7, { reason: "insufficient_scope", tool: "inbox_list_attachments", hint: "API key lacks the mcp:inbox scope" });
  assert.equal(error.error.code, -32001);
  assert.equal(error.error.message, "insufficient_scope");
  assert.equal(error.error.data.reason, "insufficient_scope");
  assert.equal(error.error.data.category, "access");
  assert.equal(error.error.data.tool, "inbox_list_attachments");
  assert.equal(error.error.data.hint, "API key lacks the mcp:inbox scope");
});
