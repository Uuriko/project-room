// Legacy onboarding MCP tokens keep heartbeat/wake + inbox after W2-M1.
// Tokens minted before the gate carry [mcp:room:<id>, rooms:read, rooms:write]
// (30-day expiry); W2-M1 gave only NEW onboarding tokens mcp:inbox/mcp:wake,
// so pre-gate joiners lost heartbeat_set ("API key lacks the mcp:wake scope").
// A missing scope also reports as an access error, not invalid_arguments.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { API_KEY_PREFIX } from "../server/agent-api-keys.mjs";

function fixture(t, now) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-legacy-key-"));
  const store = new RoomStore(join(directory, "room.sqlite"), now === undefined ? {} : { now: () => now });
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

const call = (mcp, credential, name, args) => mcp(
  { jsonrpc: "2.0", id: "1", method: "tools/call", params: { name, arguments: args } },
  { authorization: `Bearer ${credential}`, mcpUrl: "http://127.0.0.1/mcp", userAgent: "test" });

const DAY = 86400000;

test("a pre-gate onboarding token (3 scopes, 30-day expiry) still reaches heartbeat_set", async t => {
  const store = fixture(t, Date.parse("2026-10-05T17:46:32Z"));
  const identity = store.identities.create("Legacy joiner");
  const createdAt = store.now();
  const issued = store.agentPlugin.issueApiKey({ identityId: identity.identityId,
    scopes: ["mcp:room:commons", "rooms:read", "rooms:write"], expiresAt: createdAt + 30 * DAY, label: "Legacy joiner" });
  const mcp = createHostedRoomMcp(store);
  const reply = await call(mcp, API_KEY_PREFIX + issued.secret, "heartbeat_set", { hostId: "legacy-host", mode: "wakeable", cadenceSeconds: 1800 });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.notEqual(reply.result?.isError, true, JSON.stringify(reply.result));
});

test("a narrowly scoped owner key (not the onboarding shape) is still refused, as an access error", async t => {
  const store = fixture(t, Date.parse("2026-10-05T17:46:32Z"));
  const identity = store.identities.create("Narrow owner");
  const issued = store.agentPlugin.issueApiKey({ identityId: identity.identityId,
    scopes: ["mcp:room:commons", "rooms:read", "rooms:write"], expiresAt: store.now() + 7 * DAY, label: "narrow" });
  const mcp = createHostedRoomMcp(store);
  const reply = await call(mcp, API_KEY_PREFIX + issued.secret, "heartbeat_set", { hostId: "narrow-host", mode: "wakeable", cadenceSeconds: 1800 });
  assert.equal(reply.error?.message, "insufficient_scope");
  assert.equal(reply.error?.data?.reason, "insufficient_scope");
  assert.equal(reply.error?.data?.category, "access");
  assert.match(reply.error?.data?.hint, /mcp:wake/);
  const noExpiry = store.agentPlugin.issueApiKey({ identityId: identity.identityId,
    scopes: ["mcp:room:commons", "rooms:read", "rooms:write"] });
  const again = await call(mcp, API_KEY_PREFIX + noExpiry.secret, "heartbeat_set", { hostId: "narrow-host-2", mode: "wakeable", cadenceSeconds: 1800 });
  assert.equal(again.error?.message, "insufficient_scope");
});

test("the same 3-scope, 30-day shape minted after the cutoff gets no implied wake scope", async t => {
  const store = fixture(t, Date.parse("2026-10-09T00:00:00Z"));
  const identity = store.identities.create("Late narrow owner");
  const issued = store.agentPlugin.issueApiKey({ identityId: identity.identityId,
    scopes: ["mcp:room:commons", "rooms:read", "rooms:write"], expiresAt: store.now() + 30 * DAY, label: "late" });
  const mcp = createHostedRoomMcp(store);
  const reply = await call(mcp, API_KEY_PREFIX + issued.secret, "heartbeat_set", { hostId: "late-host", mode: "wakeable", cadenceSeconds: 1800 });
  assert.equal(reply.error?.message, "insufficient_scope");
});
