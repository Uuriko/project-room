import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { helpTools, validHelpArguments, buildHelpCommand, submitHelpAction, helpActionRefusal } from "../client/help-actions.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";

const identity = { roomId: "commons", memberId: "helper" };
const base = { requestId: "stable-operation", workItemId: "work", offerId: "offer", expectedRevision: 1 };
const invitation = { expectedHelpRevision: 1, helpEventId: "invitation-event" };
const update = { ...base, expectedOfferRevision: 0, reason: "Explicit coordination choice" };
const cases = [
  ["room_offer_help", { ...base, ...invitation, plan: "I can prepare two agenda items" }, null],
  ["room_select_help_offer", { ...update, ...invitation }, "selected"],
  ["room_decline_help_offer", update, "declined"],
  ["room_withdraw_help_offer", update, "withdrawn"],
  ["room_release_help_offer", { ...update, expectedOfferRevision: 1, externalActivityUnverified: true }, "released"]
];
const receipt = command => ({ sequence: 7, duplicate: false, event: { id: "saved-event", type: command.type, data: structuredClone(command.data),
  roomId: identity.roomId, actorId: identity.memberId, causationId: null, at: "2026-09-08T00:00:00.000Z",
  idempotencyKey: createHash("sha256").update(identity.memberId + ":" + command.id).digest("hex") } });

test("five thin offer actions preserve exact input and report offer revisions, never assignment or execution", async () => {
  assert.equal(helpTools.length, cases.length);
  for (const [name, args, status] of cases) {
    const original = structuredClone(args), sent = [], controller = new AbortController();
    const command = buildHelpCommand(name, args), { requestId, ...data } = args;
    assert.deepEqual(command, { id: requestId, type: status ? "work.help_offer_updated" : "work.help_offer_opened", data: { ...data, ...(status ? { status } : {}) } });
    const result = await submitHelpAction({ command: async (value, { signal }) => {
      assert.equal(signal, controller.signal); sent.push(value); return receipt(value);
    } }, identity, name, args, { signal: controller.signal });
    assert.deepEqual(sent, [command]); assert.deepEqual(args, original);
    assert.equal(result.status, "recorded"); assert.equal(result.appliedOfferRevision, status ? args.expectedOfferRevision + 1 : 0);
    assert.equal(result.workStateChanged, false); assert.equal(result.externalExecution, false);
    assert.equal(result.currentStateVerified, false); assert.equal(result.authority, "coordination_only");
    assert.equal(Object.hasOwn(result, "appliedRevision"), false);
    assert.deepEqual(result.next, { tool: "room_read_work", arguments: { workItemId: "work", includeOffers: true } });
  }
});

test("offer descriptors reject unsupported fields, malformed text and implicit release acknowledgement", () => {
  for (const [name, args] of cases) {
    assert.equal(validHelpArguments(name, args), true);
    for (const change of [v => v.actorId = "other", v => v.token = "secret", v => v.expectedRevision = -1,
      v => v.requestId = "constructor", v => v.offerId = "../other", v => v.status = "selected",
      v => v.expectedRevision = Number.MAX_SAFE_INTEGER, v => delete v.offerId]) {
      const invalid = structuredClone(args); change(invalid);
      assert.equal(validHelpArguments(name, invalid), false);
      assert.throws(() => buildHelpCommand(name, invalid), { code: "invalid_help_action" });
    }
    const field = name === "room_offer_help" ? "plan" : "reason";
    for (const value of [" ", "a".repeat(601), "\ud800", null]) assert.equal(validHelpArguments(name, { ...args, [field]: value }), false);
  }
  const release = cases[4][1];
  assert.equal(validHelpArguments(cases[4][0], { ...release, externalActivityUnverified: false }), false);
  const omitted = { ...release }; delete omitted.externalActivityUnverified;
  assert.equal(validHelpArguments(cases[4][0], omitted), false);
});

test("offer receipts cannot forge selection, exact retry or current state", async () => {
  const [name, args] = cases[1];
  for (const mutate of [r => r.event.data.status = "released", r => r.event.actorId = "other", r => r.event.data.expectedHelpRevision++,
    r => r.event.data.reason = "Different", r => r.event.idempotencyKey = "other", r => r.sequence = 0, r => r.event.roomId = "other"]) {
    const result = await submitHelpAction({ command: async c => { const r = receipt(c); mutate(r); return r; } }, identity, name, args);
    assert.equal(result.status, "unconfirmed");
  }
  const replay = await submitHelpAction({ command: async c => ({ ...receipt(c), duplicate: true }) }, identity, name, args);
  assert.equal(replay.duplicate, true); assert.equal(replay.currentStateVerified, false);
});

test("offer refusals separate refused attempts from unknown outcomes without echoing private text", () => {
  for (const code of ["command_rejected", "idempotency_conflict", "pilot_limit"]) {
    const result = helpActionRefusal({ status: 409, code, message: "PRIVATE SECRET" });
    assert.equal(result.outcome, "this_attempt_refused"); assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes("PRIVATE SECRET"), false);
  }
  assert.equal(helpActionRefusal({ code: "invalid_help_action" }).outcome, "this_attempt_not_sent");
  assert.equal(helpActionRefusal({ status: 503, code: "private" }), null);
});

test("direct client exposes the same strict action with identity preflight and no context read or retry", async () => {
  const sent = [], routes = [], client = new RoomAgentClient({ origin: "http://127.0.0.1:1234", roomId: identity.roomId, memberId: identity.memberId, token: "x".repeat(43),
    fetchImpl: async (url, options) => {
      routes.push(new URL(url).pathname);
      if (new URL(url).pathname === "/api/session") return Response.json({ authMode: "room", roomId: identity.roomId,
        member: { id: identity.memberId, kind: "agent", active: true, revision: 0, permissions: [] },
        account: null, csrf: null, sessionBinding: null, sessionRevision: null, expiresAt: Date.now() + 3600000 });
      assert.equal(new URL(url).pathname, "/api/rooms/commons/commands");
      assert.equal(options.method, "POST"); const command = JSON.parse(options.body); sent.push(command);
      return Response.json(receipt(command));
    } });
  const [name, args] = cases[0], result = await client.helpAction(name, args);
  assert.equal(result.status, "recorded"); assert.deepEqual(sent, [buildHelpCommand(name, args)]);
  assert.deepEqual(routes, ["/api/session", "/api/rooms/commons/commands"]);
  await assert.rejects(client.helpAction(name, { ...args, token: "forged" }), { code: "invalid_help_action" });
  assert.equal(sent.length, 1);
  assert.equal(routes.length, 2);
});
