// A2A card truth (QA2 finding P2-5).
//
// Authoring gate:
// 1. A capability advertised as true has a live method or route that is not
//    JSON-RPC method-not-found, and every supportedInterfaces URL shares the
//    card's own origin. Task push-config methods answer -32003
//    PushNotificationNotSupported while that flag is false. Custom webhooks
//    stay advertised.
// 2. Setting pushNotifications true without those methods, pointing the MCP
//    interface at another host, or returning -32601 for
//    CreateTaskPushNotificationConfig or tasks/pushNotificationConfig/set
//    fails this file.
// 3. Older card tests asserted the flag was true and never called the
//    methods. This file is the owner of the card-versus-server contract.
// 4. No production seam: agentCard(), handleA2aRpc(), and the HTTP server.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCard, AGENT_CARD_A2A_PATH } from "../deploy/agent-discovery.mjs";
import { handleA2aRpc } from "../server/a2a-jsonrpc.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

// Build freshness, not an operation the server performs.
const NOT_AN_OPERATION = new Set(["stale"]);

const A2A_METHODS = Object.freeze({
  streaming: Object.freeze(["message/stream", "SendStreamingMessage"]),
  pushNotifications: Object.freeze([
    "tasks/pushNotificationConfig/set",
    "CreateTaskPushNotificationConfig",
  ]),
});

const PUSH_CONFIG_METHODS = Object.freeze([
  "tasks/pushNotificationConfig/set",
  "tasks/pushNotificationConfig/get",
  "tasks/pushNotificationConfig/list",
  "tasks/pushNotificationConfig/delete",
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
]);

const HTTP_PROBES = Object.freeze({
  "agent-identities": Object.freeze({ method: "POST", path: "/api/agent-identities", body: {} }),
  "agent-invites": Object.freeze({ method: "POST", path: "/api/agent-invites/redeem", body: {} }),
  "agent-keys": Object.freeze({ method: "GET", path: "/api/agent-keys" }),
  "agent-rooms": Object.freeze({ method: "GET", path: "/api/agent-rooms" }),
  "guest-agent-links": Object.freeze({ method: "GET", path: "/api/guest-agent-links" }),
  directory: Object.freeze({ method: "GET", path: "/api/agent-directory" }),
  "agent-inbox": Object.freeze({ method: "GET", path: "/api/inbox" }),
  collab: Object.freeze({ method: "GET", path: "/api/rooms/commons/collab/notes" }),
  webhooks: Object.freeze({ method: "GET", path: "/api/agent-webhooks" }),
  "agent-heartbeats": Object.freeze({ method: "GET", path: "/api/agent-heartbeats" }),
  "public-face": Object.freeze({ method: "GET", path: "/api/rooms/commons/public-face" }),
  "spend-allowance": Object.freeze({ method: "GET", path: "/api/rooms/commons/spend-allowance" }),
  "web-fetch": Object.freeze({ method: "POST", path: "/api/web/fetch", body: {} }),
  "web-research": Object.freeze({ method: "POST", path: "/api/web/research", body: {} }),
});

function rpc(method) {
  return handleA2aRpc({ jsonrpc: "2.0", id: 1, method, params: {} });
}

function assertInterfacesShareCardOrigin(card) {
  const origin = new URL(card.url).origin;
  assert.ok(Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length > 0);
  for (const iface of card.supportedInterfaces) {
    assert.equal(new URL(iface.url).origin, origin, iface.url);
  }
}

async function listen(t) {
  const directory = mkdtempSync(join(tmpdir(), "a2a-card-truth-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("advertised capabilities are implemented and interface URLs share the card origin", async t => {
  const card = agentCard();
  assertInterfacesShareCardOrigin(card);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.equal(card.capabilities.webhooks, true);

  for (const [name, value] of Object.entries(card.capabilities)) {
    if (typeof value !== "boolean" || value !== true || NOT_AN_OPERATION.has(name)) continue;
    if (A2A_METHODS[name]) {
      for (const method of A2A_METHODS[name]) {
        const reply = rpc(method);
        assert.notEqual(reply.error?.code, -32601, `${name} ${method}`);
        if (name === "pushNotifications") assert.notEqual(reply.error?.code, -32003, method);
      }
      continue;
    }
    assert.ok(HTTP_PROBES[name], `true capability ${name} has no method or route probe`);
  }

  const origin = await listen(t);
  const served = await fetch(`${origin}${AGENT_CARD_A2A_PATH}`);
  assert.equal(served.status, 200);
  const servedCard = await served.json();
  assertInterfacesShareCardOrigin(servedCard);
  assert.equal(servedCard.capabilities.pushNotifications, false);
  assert.equal(servedCard.capabilities.webhooks, true);

  for (const [name, value] of Object.entries(servedCard.capabilities)) {
    if (typeof value !== "boolean" || value !== true || NOT_AN_OPERATION.has(name)) continue;
    const probe = HTTP_PROBES[name];
    if (!probe) continue;
    const response = await fetch(origin + probe.path, {
      method: probe.method,
      headers: {
        Origin: origin,
        ...(probe.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: probe.body !== undefined ? JSON.stringify(probe.body) : undefined,
    });
    const text = await response.text();
    assert.notEqual(response.status, 404, `${probe.method} ${probe.path} ${text.slice(0, 180)}`);
  }
});

test("push-config methods return PushNotificationNotSupported", async t => {
  for (const method of PUSH_CONFIG_METHODS) {
    const reply = rpc(method);
    assert.equal(reply.error.code, -32003, method);
    assert.equal(reply.error.message, "PushNotificationNotSupported", method);
  }
  assert.equal(rpc("rooms/delete").error.code, -32601);

  const origin = await listen(t);
  const response = await fetch(`${origin}/a2a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "push",
      method: "tasks/pushNotificationConfig/set",
      params: { taskId: "none", pushNotificationConfig: { url: "https://example.invalid/hook" } },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error.code, -32003);
  assert.equal(body.error.message, "PushNotificationNotSupported");
});
