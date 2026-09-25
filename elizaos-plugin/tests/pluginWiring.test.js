// ElizaOS wiring tests: the plugin SDK contract.
//
// Authoring gate: this is the only test covering the SDK adaptation layer —
// the plugin object shape (name/actions/providers), validate() gating on the
// credential, options.parameters extraction, ActionResult shaping, and the
// provider's configured/unconfigured behavior. A broken extraction or a
// renamed action silently disables the plugin for the ElizaOS planner, and
// nothing else catches it. globalThis.fetch is stubbed (strict: unknown
// routes throw) and restored after each test; no production seams added.

import test from "node:test";
import assert from "node:assert/strict";
import projectRoomPlugin, {
  projectRoomPlugin as namedPlugin,
  projectRoomActions,
  projectRoomProvider,
  projectRoomSettings,
} from "../src/plugin.js";
import { ACTION_NAMES } from "../src/actions.js";

const runtimeWith = (settings = {}) => ({
  getSetting: name => (typeof settings[name] === "string" ? settings[name] : undefined),
});

/** Strict stub fetch: route table on "METHOD /path"; unknown routes throw. */
function stubFetch(t, routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const { pathname } = new URL(url);
    const handler = routes.get(`${method} ${pathname}`);
    if (!handler) throw new Error(`stub fetch: no route for ${method} ${pathname}`);
    calls.push({ method, pathname, body: options.body ? JSON.parse(options.body) : undefined });
    const { status, json } = handler(url, options);
    return { ok: status >= 200 && status < 300, status, statusText: `stub-${status}`, json: async () => json };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const actionByName = name => projectRoomActions.find(a => a.name === name);

test("plugin object matches the SDK contract", () => {
  assert.equal(namedPlugin, projectRoomPlugin, "named and default exports are the same plugin");
  assert.equal(projectRoomPlugin.name, "@uuriko/plugin-project-room");
  assert.ok(projectRoomPlugin.description.length > 20);
  assert.deepEqual(projectRoomActions.map(a => a.name).sort(), [...ACTION_NAMES].sort(), "every runtime-agnostic action is wired");
  for (const action of projectRoomActions) {
    assert.match(action.name, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(Array.isArray(action.similes) && action.similes.length > 0, `${action.name} has similes`);
    assert.ok(action.description.length > 20, `${action.name} describes itself for the planner`);
    assert.ok(Array.isArray(action.parameters), `${action.name} declares parameters`);
    assert.equal(typeof action.validate, "function");
    assert.equal(typeof action.handler, "function");
  }
  assert.equal(projectRoomProvider.name, "PROJECT_ROOM_STATE");
  assert.equal(typeof projectRoomProvider.get, "function");
});

test("validate gates credential-requiring actions; ROOM_JOIN stays open", async () => {
  const bare = runtimeWith({});
  const enrolled = runtimeWith({ ROOM_AGENT_SECRET: "pri_x" });
  assert.equal(await actionByName("ROOM_JOIN").validate(bare), true);
  assert.equal(await actionByName("ROOM_LIST_WORK").validate(bare), false);
  assert.equal(await actionByName("ROOM_CLAIM_TASK").validate(bare), false);
  assert.equal(await actionByName("ROOM_CLAIM_TASK").validate(enrolled), true);
  assert.equal(await actionByName("ROOM_SUBMIT_RECEIPT").validate(enrolled), true);
});

test("ROOM_JOIN handler enrolls via options.parameters and surfaces the secret once", async t => {
  const calls = stubFetch(t, new Map([
    ["POST /api/agent-invites/redeem", () => ({ status: 201, json: {
      identityId: "ai_1", secret: "pri_onesecret", roomId: "commons", memberId: "ai_1",
      displayName: "Eliza", permissions: ["accept_work"], next: [{ description: "Read the board" }],
    } })],
  ]));
  const runtime = runtimeWith({ ROOM_URL: "https://room.example" });
  const res = await actionByName("ROOM_JOIN").handler(runtime, {}, {}, { parameters: { code: "RM-1", displayName: "Eliza" } });
  assert.equal(res.success, true, JSON.stringify(res));
  assert.ok(res.text.includes("pri_onesecret"), "the once-shown secret reaches the operator");
  assert.ok(res.text.includes("ROOM_AGENT_SECRET"), "the persistence warning is in the result text");
  assert.equal(res.data.secret, "pri_onesecret");
  assert.equal(calls[0].body.code, "RM-1");
});

test("ROOM_JOIN falls back to ROOM_INVITE_CODE / ROOM_AGENT_NAME settings", async t => {
  stubFetch(t, new Map([
    ["POST /api/agent-invites/redeem", (_u, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.code, "RM-SET");
      assert.equal(body.displayName, "Set Bot");
      return { status: 201, json: { identityId: "ai_2", secret: "pri_s2", roomId: "commons", memberId: "ai_2", displayName: "Set Bot", permissions: [], next: [] } };
    }],
  ]));
  const runtime = runtimeWith({ ROOM_INVITE_CODE: "RM-SET", ROOM_AGENT_NAME: "Set Bot" });
  const res = await actionByName("ROOM_JOIN").handler(runtime, {}, {}, { parameters: {} });
  assert.equal(res.success, true, JSON.stringify(res));
});

test("handlers map invalid params and missing enrollment to failed ActionResults", async t => {
  stubFetch(t, new Map());
  const runtime = runtimeWith({});
  const badParams = await actionByName("ROOM_CLAIM_TASK").handler(runtime, {}, {}, { parameters: {} });
  assert.equal(badParams.success, false);
  assert.equal(badParams.data.error, "INVALID_PARAMS");
  const notEnrolled = await actionByName("ROOM_CLAIM_TASK").handler(runtime, {}, {}, { parameters: { claimId: "t" } });
  assert.equal(notEnrolled.success, false);
  assert.equal(notEnrolled.data.error, "NOT_ENROLLED");
});

test("write-action handler walks submitReceipt through the state machine", async t => {
  const calls = stubFetch(t, new Map([
    ["GET /api/rooms/commons/work-claims/t1", () => ({ status: 200, json: { id: "t1", state: "claimed" } })],
    ["POST /api/rooms/commons/work-claims/t1/update", (_u, opts) => {
      const body = JSON.parse(opts.body);
      return { status: 200, json: { id: "t1", state: body.state } };
    }],
  ]));
  const runtime = runtimeWith({ ROOM_URL: "https://room.example", ROOM_AGENT_SECRET: "pri_x", ROOM_ID: "commons" });
  const res = await actionByName("ROOM_SUBMIT_RECEIPT").handler(runtime, {}, {}, {
    parameters: { claimId: "t1", note: "done", deliveryMode: "result" },
  });
  assert.equal(res.success, true, JSON.stringify(res));
  assert.ok(res.text.includes("rc_t1"), "receipt id in the result text");
  const updates = calls.filter(c => c.pathname.endsWith("/update"));
  assert.deepEqual(updates.map(c => c.body.state), ["in_progress", "done"]);
});

test("room error codes surface as failed ActionResults with the code", async t => {
  stubFetch(t, new Map([
    ["POST /api/rooms/commons/work-claims/t1/claim", () => ({
      status: 409,
      json: { error: { code: "work_claim_conflict", message: "already claimed" }, status: "failed" },
    })],
  ]));
  const runtime = runtimeWith({ ROOM_AGENT_SECRET: "pri_x", ROOM_ID: "commons" });
  const res = await actionByName("ROOM_CLAIM_TASK").handler(runtime, {}, {}, { parameters: { claimId: "t1" } });
  assert.equal(res.success, false);
  assert.equal(res.data.error, "work_claim_conflict");
  assert.ok(res.text.includes("already claimed"));
});

test("provider degrades when unenrolled and renders standing when enrolled", async t => {
  stubFetch(t, new Map([
    ["GET /api/rooms/commons/work-claims", () => ({ status: 200, json: { claims: [{ id: "a", title: "Docs", state: "in_progress", owner: "ai_1" }], swept: [] } })],
    ["GET /api/rooms/commons/agent-inbox", () => ({ status: 200, json: { agentId: "ai_1", directMessages: [], mentions: [], assignments: [], dmRequests: [] } })],
    ["GET /api/rooms/commons/receipts", () => ({ status: 200, json: { receipts: [], nextCursor: null } })],
  ]));
  const bare = await projectRoomProvider.get(runtimeWith({}));
  assert.equal(bare.text, "");
  assert.equal(bare.values.projectRoomConfigured, false);
  const enrolled = await projectRoomProvider.get(runtimeWith({ ROOM_AGENT_SECRET: "pri_x", ROOM_ID: "commons", ROOM_MEMBER_ID: "ai_1" }));
  assert.equal(enrolled.values.projectRoomConfigured, true);
  assert.ok(enrolled.text.includes("Project Room standing"), "snapshot renders");
  assert.ok(enrolled.text.includes("a: Docs"), "my open claim renders");
});

test("init fails fast on a malformed ROOM_URL and passes otherwise", async () => {
  await assert.rejects(
    () => projectRoomPlugin.init({}, runtimeWith({ ROOM_URL: "not a url" })),
    /not a valid http\(s\) URL/
  );
  await projectRoomPlugin.init({}, runtimeWith({}));
  await projectRoomPlugin.init({}, runtimeWith({ ROOM_URL: "http://localhost:8787" }));
});

test("settings schema documents every config key with secrecy flags", () => {
  const names = Object.keys(projectRoomSettings);
  assert.deepEqual(names.sort(), ["ROOM_AGENT_NAME", "ROOM_AGENT_SECRET", "ROOM_ID", "ROOM_INVITE_CODE", "ROOM_MEMBER_ID", "ROOM_URL"].sort());
  assert.equal(projectRoomSettings.ROOM_AGENT_SECRET.secret, true);
  assert.equal(projectRoomSettings.ROOM_INVITE_CODE.secret, true);
  assert.equal(projectRoomSettings.ROOM_URL.secret, false);
  for (const setting of Object.values(projectRoomSettings)) {
    assert.ok(setting.description && setting.usageDescription, `${setting.name} is documented`);
  }
});
